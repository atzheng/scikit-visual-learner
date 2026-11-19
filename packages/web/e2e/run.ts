/**
 * `pnpm e2e`: the M3 exit check. Drives system Chrome (playwright-core) against `vite preview` of the built
 * site (run `pnpm build` first). Everything is served from 127.0.0.1 on an OS-assigned port; nothing
 * touches the network.
 *
 *   pnpm e2e                 all checks
 *   pnpm e2e --only share    only checks whose name contains "share"
 *
 * Screenshots go to a temp directory that is always kept; its path is printed at the start and the end.
 * Ctrl-C stops the preview server and the browser before exiting.
 *
 * The checks use roles, aria-labels, data- attributes and relative "N of M" step counts rather than
 * exact step counts or pixel positions, so UI beads that add steps or restyle should leave them alone.
 * Failures do not stop the run: every check reports, then the exit code says whether any failed.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import {
  CHROME,
  ROOT,
  cleanupOnSignal,
  freePort,
  startPreview,
  stopPreview,
  waitReady,
} from '../../../scripts/lib/browser';

const SHOTS = mkdtempSync(path.join(os.tmpdir(), 'machines-e2e-'));
const ONLY = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;
const VIEWPORT = { width: 1440, height: 900 };
const LONG = 120_000;

const program = (name: string): string =>
  readFileSync(path.join(ROOT, 'fixtures/programs', name), 'utf8');

class Failure extends Error {}
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Failure(what);
}

const results: { name: string; ok: boolean; note: string }[] = [];
async function step(name: string, f: () => Promise<void>): Promise<void> {
  // (the first check opens the page the others use, so it always runs)
  if (ONLY && !name.includes(ONLY) && !name.startsWith('load')) return;
  const t0 = Date.now();
  try {
    await f();
    results.push({ name, ok: true, note: `${((Date.now() - t0) / 1000).toFixed(1)} s` });
  } catch (e) {
    const note = (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 8).join(' | ');
    results.push({ name, ok: false, note });
  }
  const r = results[results.length - 1]!;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.note})`);
}

// ---- page helpers ----------------------------------------------------------------------------------

type Store = {
  getState(): {
    setSource(s: string): void;
    runtime: { state: string };
    running: boolean;
    log: { status: string } | null;
  };
};

async function open(ctx: BrowserContext, base: string, hash = ''): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`${base}/?debug${hash}`);
  await waitReady(page, LONG);
  return page;
}

async function setSource(page: Page, source: string): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as { __machines: Store }).__machines.getState().setSource(s),
    source,
  );
  // the editor follows the store
  const first = source.split('\n')[0] ?? '';
  await page.waitForFunction(
    (t) => document.querySelector('.cm-content')?.textContent?.includes(t) ?? false,
    first,
  );
}

const runButton = (page: Page) => page.getByRole('button', { name: 'Run', exact: true });
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

/** Clicks Run and waits until the run is over and the runtime is ready again. */
async function runAndWait(page: Page): Promise<void> {
  await runButton(page).click();
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __machines: Store }).__machines.getState();
      return (
        !s.running && s.log !== null && s.log.status !== 'running' && s.runtime.state === 'ready'
      );
    },
    undefined,
    { timeout: LONG, polling: 50 },
  );
}

/** "N of M" from the timeline's step label. */
async function stepCount(page: Page): Promise<{ n: number; m: number }> {
  const t = (await page.locator('output.step-label').textContent()) ?? '';
  const mt = /(\d+) of (\d+)/.exec(t);
  check(mt, `step label "${t}" is not "N of M"`);
  return { n: Number(mt[1]), m: Number(mt[2]) };
}

const currentEvent = (page: Page) => page.getByTestId('current-event').textContent();
const slider = (page: Page) => page.getByRole('slider', { name: 'Step' });

async function gotoStep(page: Page, target: number): Promise<void> {
  const s = slider(page);
  await s.focus();
  for (let guard = 0; guard < 500; guard++) {
    const { n } = await stepCount(page);
    if (n === target) return;
    await page.keyboard.press(n < target ? 'ArrowRight' : 'ArrowLeft');
  }
  throw new Failure(`could not reach step ${target}`);
}

/** Visible boxes: nodes that are not hidden. */
const visibleNodes = (page: Page) => page.locator('g.md-node[data-node]:not(.md-hidden)');

/** Waits until the diagram stops moving (Follow pans and zooms the full diagram; the two-pane cards move to the stage). */
async function settle(page: Page, timeout = 5000): Promise<void> {
  // (a script string: tsx's name helpers do not exist in the page)
  await page.evaluate(`new Promise((resolve) => {
    const key = () => {
      const stage = document.querySelector('.diagram-stage');
      if (stage) return stage.style.transform + '|' + JSON.stringify(stage.getBoundingClientRect());
      // the two-pane view: every card's place
      return [...document.querySelectorAll('.md-card')]
        .map((c) => JSON.stringify(c.getBoundingClientRect()))
        .join('');
    };
    const t0 = performance.now();
    let last = key();
    let since = t0;
    const tick = () => {
      const now = performance.now();
      const k = key();
      if (k !== last) { last = k; since = now; }
      if (now - since >= 300 || now - t0 >= ${timeout}) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })`);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function shotBothThemes(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // the theme is applied by CSS variables: wait until the page's colour scheme query agrees
    await page.waitForFunction(
      (dark) => matchMedia('(prefers-color-scheme: dark)').matches === dark,
      scheme === 'dark',
    );
    await settle(page);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** A point on a wire path in page coordinates (the middle of the path). */
async function pointOnEdge(
  page: Page,
  edgeIndex: number,
  two: boolean,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ([k, two]) => {
      const paths = [
        ...document.querySelectorAll<SVGPathElement>('g.md-edge[data-edge]:not(.md-hidden) path'),
      ];
      const p = paths[k];
      if (!p) return null;
      const pt = p.getPointAtLength(p.getTotalLength() / 2);
      const m = p.getScreenCTM();
      if (!m) return null;
      const x = m.a * pt.x + m.c * pt.y + m.e;
      const y = m.b * pt.x + m.d * pt.y + m.f;
      // only a point where the wire is on top and in view (not under a box, the panel or off-screen)
      const top = document.elementFromPoint(x, y);
      // the stage's wires take no pointer events: they only need to be in view and clear of every card
      if (two) return top && !top.closest('.md-card') && top.closest('.md-stage') ? { x, y } : null;
      const hit = top?.closest('g.md-edge');
      return hit && hit === p.closest('g.md-edge') ? { x, y } : null;
    },
    [edgeIndex, two] as const,
  );
}

type View = 'two' | 'full';

async function setView(page: Page, view: View): Promise<void> {
  await page
    .getByRole('button', { name: view === 'two' ? 'Shelf and stage' : 'Full diagram' })
    .click();
  await page.locator(view === 'two' ? '[data-testid="twopane"]' : '.diagram-viewport').waitFor({
    timeout: 10_000,
  });
}

/** The attribute panel opens by itself at a call step and covers the right of the pane: close it when present. */
async function closeAttributes(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Close attributes panel' });
  // it appears a moment after the step (not at every step): wait briefly, then close it if it came
  await close.waitFor({ timeout: 1500 }).catch(() => undefined);
  if (await close.count()) {
    await close.click();
    await page
      .getByRole('complementary', { name: /^Attributes of/ })
      .waitFor({ state: 'detached' });
  }
}

/** The core checks (run, step, hover/pin a wire, the fit step, attributes, docs) in one view of the diagram. */
async function core(page: Page, view: View): Promise<void> {
  await setView(page, view);
  await step(`[${view}] run notebook.py: diagram boxes appear`, async () => {
    await runAndWait(page);
    // the layout is asynchronous: it can land a moment after the run ends
    await page
      .locator('g.md-node[data-node]:not(.md-hidden)')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .catch(() => undefined);
    check((await page.locator('g.md-node[data-node]').count()) > 0, 'no boxes in the diagram');
    check((await visibleNodes(page).count()) > 0, 'no visible boxes at the end of the run');
    const { n, m } = await stepCount(page);
    check(m > 0, 'no steps');
    check(n === m, `expected to be at the last step after a run, got ${n} of ${m}`);
    check(
      (await page.locator('g.md-node[data-kind="instance"]').count()) > 0,
      'no instance box (LinearRegression)',
    );
    await shotBothThemes(page, `02-notebook-end-${view}`);
  });

  await step(`[${view}] step through every event with the arrow key`, async () => {
    await gotoStep(page, 0);
    check((await currentEvent(page))?.includes('Before'), 'step 0 is not "Before the first step"');
    check((await page.locator('.cm-site-highlight').count()) === 0, 'editor span shown at step 0');
    const { m } = await stepCount(page);
    const events = new Set<string>();
    const boxes = new Set<string>();
    const spans = new Set<string>();
    let prevEvent = await currentEvent(page);
    let withBox = 0;
    let same = 0;
    for (let k = 1; k <= m; k++) {
      await page.keyboard.press('ArrowRight');
      check((await stepCount(page)).n === k, `after → the step is not ${k} of ${m}`);
      const ev = (await currentEvent(page)) ?? '';
      if (ev === prevEvent) same++; // two steps can share a label (the same call site twice)
      prevEvent = ev;
      events.add(ev);
      // a step may have no current box (an import, say): count first, so nothing waits for one
      const cur = page.locator('g[aria-current="step"]');
      const box = (await cur.count()) > 0 ? await cur.first().getAttribute('data-node') : null;
      if (box) {
        withBox++;
        boxes.add(box);
      }
      const span = await page.locator('.cm-site-highlight').first().textContent();
      if (span) spans.add(span);
      else check(!box, `step ${k} has a current box but no editor span`);
    }
    check(
      events.size > 2 && same < m / 2,
      `the current event barely changed (${events.size} of ${m})`,
    );
    check(withBox > 0 && boxes.size > 1, `current box did not move (${boxes.size} distinct)`);
    check(spans.size > 1, `editor span did not move (${spans.size} distinct)`);
    await shot(page, `03-stepped-to-end-light-${view}`);
  });

  await step(`[${view}] hover a wire and see a preview`, async () => {
    await gotoStep(page, (await stepCount(page)).m);
    await closeAttributes(page);
    const total = await page.locator('g.md-edge[data-edge]:not(.md-hidden) path').count();
    check(total > 0, 'no visible wires');
    await settle(page);
    let shown = false;
    for (let k = 0; k < total && !shown; k++) {
      const pt = await pointOnEdge(page, k, view === 'two');
      if (!pt) continue;
      await page.mouse.move(pt.x - 40, pt.y - 40);
      await page.mouse.move(pt.x, pt.y, { steps: 4 });
      shown = await page
        .locator('.pv-popover')
        .first()
        .waitFor({ timeout: 800 })
        .then(
          () => true,
          () => false,
        );
      if (shown) {
        await shot(page, `04-wire-preview-light-${view}`);
        // Click pins it; Escape unpins.
        await page.mouse.click(pt.x, pt.y);
        await page.locator('.pv-popover.pinned').waitFor({ timeout: 2000 });
        await page.keyboard.press('Escape');
        await page.locator('.pv-popover.pinned').waitFor({ state: 'detached', timeout: 2000 });
      } else {
        await page.mouse.move(2, 2);
      }
    }
    check(shown, `no preview on any of ${total} wires`);
  });

  await step(`[${view}] the step summary at the fit step mentions coef_ (aria-live)`, async () => {
    const { m } = await stepCount(page);
    const summary = page.getByTestId('step-summary');
    const live = page.getByTestId('step-summary-live');
    check((await live.getAttribute('aria-live')) === 'polite', 'summary is not aria-live');
    let fit = -1;
    for (let k = 1; k <= m && fit < 0; k++) {
      await gotoStep(page, k);
      if (/\bmodel\.fit\(/.test((await currentEvent(page)) ?? '')) fit = k;
    }
    check(fit > 0, 'no .fit step');
    const text = (await summary.textContent()) ?? '';
    check(/coef_/.test(text), `fit summary lacks coef_: ${text}`);
    check(/model\.fit/.test(text), `fit summary lacks the call: ${text}`);
    check(
      (await summary.locator('code', { hasText: 'coef_' }).count()) > 0,
      'names are not code elements',
    );
    await page.waitForFunction(
      () =>
        /coef_/.test(
          document.querySelector('[data-testid="step-summary-live"]')?.textContent ?? '',
        ),
      undefined,
      { timeout: 3000 },
    ); // the announcement follows after the debounce
    await gotoStep(page, 0);
    check(/Before the program runs/.test((await summary.textContent()) ?? ''), 'step 0 summary');
  });

  await step(
    `[${view}] click the LinearRegression box at the fit step: coef_ changed`,
    async () => {
      const { m } = await stepCount(page);
      let fit = -1;
      for (let k = 1; k <= m && fit < 0; k++) {
        await gotoStep(page, k);
        if (/\bmodel\.fit\(/.test((await currentEvent(page)) ?? '')) fit = k;
      }
      check(fit > 0, 'no .fit step');
      await settle(page); // Follow pans the diagram after a step; a click while it moves misses
      const id = await page
        .locator('g.md-node[data-kind="instance"]:not(.md-hidden)')
        .filter({ hasText: 'LinearRegression' })
        .first()
        .getAttribute('data-node');
      check(id, 'no visible LinearRegression box');
      // The instance's frame is drawn in a background layer, so the group's own centre is covered by
      // that layer's rect (same data-node) and by the calls inside. A real click on the frame's lower
      // left corner (inside the pane, clear of the calls) is what a student does.
      const frame = page.locator(`rect.md-inst-box[data-node="${id}"]`);
      await frame.scrollIntoViewIfNeeded();
      const bb = await frame.boundingBox();
      check(bb, 'the LinearRegression frame has no box');
      await page.mouse.click(bb.x + 8, bb.y + bb.height - 8);
      const panel = page.getByRole('complementary', { name: /^Attributes of/ });
      await panel.waitFor({ timeout: 5000 });
      const row = panel.locator('tr.changed', { hasText: 'coef_' });
      check((await row.count()) > 0, 'coef_ is not marked as changed at the fit step');
      check(
        /changed/i.test((await row.first().textContent()) ?? ''),
        'changed row has no text flag',
      );
      await shot(page, `05-attributes-light-${view}`);
      await panel.getByRole('button', { name: 'Close attributes panel' }).click();
    },
  );

  await step(`[${view}] the docs question mark opens the documentation`, async () => {
    const { m } = await stepCount(page);
    await gotoStep(page, m);
    await closeAttributes(page);
    await settle(page);
    const row = page
      .locator('g.md-node[data-kind="instance"]:not(.md-hidden) g[data-doc-attr]:not(.md-hidden)')
      .first();
    // the question mark is an aria-hidden glyph inside the row: click it without scrolling the pane
    await row.locator('[data-docs-row-btn]').dispatchEvent('click');
    const docs = page.getByRole('complementary', { name: 'Documentation' });
    await docs.waitFor({ timeout: 5000 });
    await shot(page, `10-docs-${view}`);
    await docs.getByRole('button', { name: 'Close documentation' }).click();
    await docs.waitFor({ state: 'detached', timeout: 5000 });
  });
}

// ---- main ------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const port = await freePort();
  const preview = await startPreview(port);
  const base = `http://127.0.0.1:${port}`;
  const browser: Browser = await chromium.launch({ executablePath: CHROME, headless: true });
  cleanupOnSignal(async () => {
    stopPreview(preview);
    await browser.close();
  });
  // Student code and data never leave the browser: any request off the page's own origin is a failure.
  const offOrigin: string[] = [];
  const guard = (c: BrowserContext): void => {
    c.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:'))
        offOrigin.push(u);
    });
  };
  const newContext = async (): Promise<BrowserContext> => {
    const c = await browser.newContext(ctxOptions);
    guard(c);
    return c;
  };
  const ctxOptions = {
    viewport: VIEWPORT,
    colorScheme: 'light' as const,
    permissions: ['clipboard-read', 'clipboard-write'],
  };
  try {
    console.log(`e2e: ${base}, screenshots in ${SHOTS}`);
    const ctx = await newContext();
    let page!: Page;

    await step('load and wait for ready', async () => {
      page = await open(ctx, base);
      await page.getByRole('heading', { name: 'Code Diagrams' }).waitFor();
      check(await runButton(page).isEnabled(), 'Run is not enabled when ready');
      check(
        await page
          .getByRole('status')
          .filter({ hasText: /^ready/ })
          .count(),
        'no "ready" status',
      );
      await shot(page, '01-loaded-light');
    });
    if (!page) throw new Error('page did not load; nothing else can run');

    for (const view of ['two', 'full'] as const) await core(page, view);

    await step(
      'two-pane: the panel stays closed until I is pressed on a focused card',
      async () => {
        await setView(page, 'two');
        await gotoStep(page, (await stepCount(page)).m);
        await settle(page);
        const panel = page.getByRole('complementary', { name: /^Attributes of/ });
        await page.waitForTimeout(500);
        check(
          (await panel.count()) === 0,
          'the attribute panel opened by itself in the two-pane view',
        );
        const box = page.locator('.md-stage .md-card:not([hidden]) g.md-node[data-node]').first();
        check(
          /(^| )I( |$)/.test((await box.getAttribute('aria-keyshortcuts')) ?? ''),
          'the card does not advertise I in aria-keyshortcuts',
        );
        await box.focus();
        await page.keyboard.press('i');
        await panel.waitFor({ timeout: 5000 });
        await panel.getByRole('button', { name: 'Close attributes panel' }).click();
      },
    );

    await step('the View toggle persists and works with the keyboard', async () => {
      const two = page.getByRole('button', { name: 'Shelf and stage' });
      const full = page.getByRole('button', { name: 'Full diagram' });
      await setView(page, 'two');
      await two.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.locator('.diagram-viewport').waitFor({ timeout: 5000 });
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('view-full') ?? false,
        undefined,
        { timeout: 2000 },
      ); // focus stays on the toggle across the switch
      check(
        (await full.getAttribute('aria-pressed')) === 'true',
        'Enter did not select Full diagram',
      );
      await page.reload();
      await waitReady(page, LONG);
      check(
        (await page.getByRole('button', { name: 'Full diagram' }).getAttribute('aria-pressed')) ===
          'true',
        'the Full diagram choice did not survive a reload',
      );
      await setView(page, 'two');
      await page.reload();
      await waitReady(page, LONG);
      await page.getByTestId('twopane').waitFor({ timeout: 5000 });
      check(
        (await page
          .getByRole('button', { name: 'Shelf and stage' })
          .getAttribute('aria-pressed')) === 'true',
        'the Shelf and stage choice did not survive a reload',
      );
      await shot(page, '09-view-toggle-light');
      await runAndWait(page);
    });

    await step('output hides when stepping back', async () => {
      await gotoStep(page, (await stepCount(page)).m);
      const out = page.getByRole('region', { name: 'Output' });
      await page.getByTestId('output-items').waitFor();
      check(/R\^2/.test((await out.textContent()) ?? ''), 'final output lacks "R^2"');
      await gotoStep(page, 0);
      check((await page.getByTestId('output-items').count()) === 0, 'output still shown at step 0');
      await gotoStep(page, (await stepCount(page)).m);
      await page.getByTestId('output-items').waitFor();
    });

    await step('import this: its output hides before the import step', async () => {
      await setSource(page, 'import this\n');
      await runAndWait(page);
      const out = page.getByRole('region', { name: 'Output' });
      await gotoStep(page, (await stepCount(page)).m);
      await page.getByTestId('output-items').waitFor();
      check(/Zen of Python/.test((await out.textContent()) ?? ''), 'import output missing');
      await gotoStep(page, 0);
      check(
        (await page.getByTestId('output-items').count()) === 0,
        'import output shown at step 0',
      );
    });

    await step('edge_error.py: error box and traceback', async () => {
      await setSource(page, program('edge_error.py'));
      await runAndWait(page);
      const err = page.getByTestId('run-error');
      await err.waitFor({ timeout: 5000 });
      check(/ValueError/.test((await err.textContent()) ?? ''), 'error box lacks ValueError');
      const frames = err.getByRole('list', { name: /Traceback/ }).getByRole('button');
      check((await frames.count()) > 0, 'traceback has no student frames');
      await page.locator('g.md-node.md-error, .md-error').first().waitFor({ timeout: 5000 });
      check((await page.locator('.cm-error-line').count()) > 0, 'the failing line is not marked');
      // output before the error is kept
      check(
        /fitting/.test((await page.getByRole('region', { name: 'Output' }).textContent()) ?? ''),
        'output before the error was lost',
      );
      await frames.first().click();
      await shotBothThemes(page, '06-error');
    });

    await step('Stop on an infinite loop', async () => {
      await setSource(page, 'import numpy as np\nwhile True:\n    pass\n');
      await runButton(page).click();
      await stopButton(page).waitFor({ timeout: 30_000 });
      // the program is running (the log exists) before Stop is pressed
      await page.waitForFunction(
        () => (window as unknown as { __machines: Store }).__machines.getState().log !== null,
        undefined,
        { timeout: 30_000 },
      );
      await stopButton(page).click();
      await runButton(page).waitFor({ timeout: LONG });
      await page.waitForFunction(
        () =>
          (window as unknown as { __machines: Store }).__machines.getState().runtime.state ===
          'ready',
        undefined,
        { timeout: LONG },
      );
      const status = await page.evaluate(
        () => (window as unknown as { __machines: Store }).__machines.getState().log?.status,
      );
      check(status === 'stopped', `run status is "${status}", not stopped`);
      await page.getByTestId('run-banner').waitFor({ timeout: 5000 });
      // Python still works afterwards
      await setSource(page, 'print("alive")\n');
      await runAndWait(page);
      check(
        /alive/.test((await page.getByRole('region', { name: 'Output' }).textContent()) ?? ''),
        'Python does not run after Stop',
      );
    });

    await step('upload a CSV and use it', async () => {
      await page.getByTestId('upload-input').setInputFiles({
        name: 'mini.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('a,b\n1,2\n3,4\n5,6\n'),
      });
      await page
        .locator('ul[aria-label="Data files"]') // inside a closed <details>, so not in the role tree
        .getByText('mini.csv')
        .waitFor({ state: 'attached', timeout: 10_000 });
      await page.locator('details.files summary').click();
      await page.getByText('3 rows, yours').waitFor({ timeout: 5000 });
      await setSource(page, 'import pandas as pd\nprint("rows", len(pd.read_csv("mini.csv")))\n');
      await runAndWait(page);
      check(
        /rows 3/.test((await page.getByRole('region', { name: 'Output' }).textContent()) ?? ''),
        'the uploaded file was not read',
      );
    });

    await step('share link round-trip', async () => {
      const marker = 'e2e_share_marker = 12345';
      const src = `${marker}\nprint(e2e_share_marker)\n`;
      await setSource(page, src);
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await page.locator('.share-pop').waitFor({ timeout: 5000 });
      let url: string;
      const manual = page.getByRole('textbox', { name: 'Share link' });
      if (await manual.count()) url = await manual.inputValue();
      else url = await page.evaluate(() => navigator.clipboard.readText());
      check(url.includes('#'), `no share URL (got "${url.slice(0, 60)}")`);
      // A new browser context: nothing from this one (local storage) carries over.
      const ctx2 = await newContext();
      const p2 = await ctx2.newPage();
      await p2.goto(url);
      await waitReady(p2, LONG);
      await p2
        .getByText(/Code from a link/)
        .first()
        .waitFor({ timeout: 5000 });
      const text = (await p2.locator('.cm-content').textContent()) ?? '';
      check(text.includes(marker), 'the shared code did not arrive');
      await shot(p2, '07-share-link-light');
      await runAndWait(p2);
      check(
        /12345/.test((await p2.getByRole('region', { name: 'Output' }).textContent()) ?? ''),
        'the linked code did not run',
      );
      await ctx2.close();
    });

    await ctx.close();

    await step('edge_mpl.py: matplotlib progress and a figure', async () => {
      const c = await newContext();
      const p = await open(c, base);
      // Record every status-line text from now on.
      // (a script string: tsx's helpers do not exist in the page)
      await p.evaluate(`(() => {
        window.__seen = [];
        const footer = document.querySelector('footer.status');
        new MutationObserver(() => window.__seen.push(footer.textContent || '')).observe(footer, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      })()`);
      await setSource(p, program('edge_mpl.py'));
      await runAndWait(p);
      await p.locator('.out-figure img').first().waitFor({ timeout: 10_000 });
      const alt = await p.locator('.out-figure img').first().getAttribute('alt');
      check(/Figure 1/.test(alt ?? ''), `figure alt is "${alt}"`);
      const seen = await p.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
      check(
        seen.some((t) => /Loading matplotlib/.test(t)),
        `the status line never showed "Loading matplotlib" (saw ${JSON.stringify([...new Set(seen)])})`,
      );
      await shotBothThemes(p, '08-matplotlib');
      await c.close();
    });

    await step('no request left the page origin', async () => {
      check(offOrigin.length === 0, `requests off origin: ${[...new Set(offOrigin)].join(', ')}`);
    });
  } finally {
    await browser.close();
    stopPreview(preview);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length} of ${results.length} checks passed. Screenshots: ${SHOTS}`,
  );
  for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.note}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
