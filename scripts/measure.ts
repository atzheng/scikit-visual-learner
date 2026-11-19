/**
 * `pnpm measure`: SPEC "Performance" numbers (milestone 1). Drives the system Chrome with playwright-core
 * against `vite preview` of the built site (run `pnpm build` first). Everything is served from localhost.
 *
 *   pnpm measure            full run (a few minutes; the Fast 3G cold load alone is long)
 *   pnpm measure --quick    one repetition, no throttled loads
 *   pnpm measure --json     also print the raw results as JSON
 *
 * Environment: MEASURE_CHROME (Chrome path).
 *
 * Throttled loads go through a local proxy that caps the shared bandwidth and adds a round trip per request
 * (CDP network emulation does not reach dedicated workers, which is where Pyodide downloads). The preview
 * server sends files uncompressed, so those loads are a pessimistic upper bound: a real host compresses.
 *
 * Run times come from the worker's hidden `debug` run option ('plain' = no recorder, 'timing' = recorder
 * plus the time spent in content hashing). The page never sets it; this script talks to a second worker.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import {
  CHROME,
  ROOT,
  freePort,
  newPage,
  startPreview as startPreviewOn,
  stopPreview,
  waitReady as waitReadyOn,
} from './lib/browser';

/** Free ports are picked at start (other sessions may be running previews). */
let PORT = 0;
let PREVIEW_PORT = 0;
const QUICK = process.argv.includes('--quick');
const READY_TIMEOUT = 15 * 60_000;

const program = (name: string): string =>
  readFileSync(path.join(ROOT, 'fixtures/programs', name), 'utf8');

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

// ---- servers ---------------------------------------------------------------------------------------

const startPreview = (): ReturnType<typeof startPreviewOn> => startPreviewOn(PREVIEW_PORT);

interface Link {
  /** Bytes per second shared by all connections; Infinity for none. */
  bytesPerSec: number;
  rttMs: number;
  /** Response bytes seen. */
  bytes: number;
}

/** A proxy in front of the preview server: one shared link with a bandwidth cap and a round trip per request. */
function startProxy(link: Link): Promise<http.Server> {
  let freeAt = 0;
  const shape = (): Transform =>
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        link.bytes += chunk.length;
        if (!Number.isFinite(link.bytesPerSec)) return cb(null, chunk);
        const now = Date.now();
        const start = Math.max(now, freeAt);
        freeAt = start + (chunk.length / link.bytesPerSec) * 1000;
        setTimeout(() => cb(null, chunk), freeAt - now);
      },
    });
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      const up = http.request(
        {
          host: '127.0.0.1',
          port: PREVIEW_PORT,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode ?? 200, r.headers);
          r.pipe(shape()).pipe(res);
        },
      );
      up.on('error', (e) => {
        console.error('proxy:', e.message);
        res.destroy();
      });
      req.pipe(up);
    }, link.rttMs);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

// ---- page helpers ----------------------------------------------------------------------------------

const pageUrl = (): string => `http://127.0.0.1:${PORT}/?debug`;

const waitReady = (page: Page): Promise<void> => waitReadyOn(page, READY_TIMEOUT);

/** Time from navigation start to the runtime reporting ready. */
async function loadToReady(page: Page): Promise<number> {
  const t0 = performance.now();
  await page.goto(pageUrl(), { waitUntil: 'commit' });
  await waitReady(page);
  return performance.now() - t0;
}

async function cdpCacheDisabled(ctx: BrowserContext, page: Page, off: boolean): Promise<void> {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: off });
}

async function swReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

// ---- measurements ----------------------------------------------------------------------------------

async function coldLoads(
  browser: Browser,
  n: number,
  link?: Link,
): Promise<{ ms: number[]; mb: number }> {
  const ms: number[] = [];
  let mb = 0;
  for (let i = 0; i < n; i++) {
    const { ctx, page } = await newPage(browser);
    await cdpCacheDisabled(ctx, page, true);
    const before = link?.bytes ?? 0;
    ms.push(await loadToReady(page));
    if (link) mb = (link.bytes - before) / 1e6;
    await ctx.close();
  }
  return { ms, mb };
}

/** Cold load that fills the SW cache, then reloads with the cache enabled. */
async function warmLoads(
  browser: Browser,
  n: number,
): Promise<{ ms: number[]; fromSw: number; network: number }> {
  const { ctx, page } = await newPage(browser);
  await loadToReady(page);
  await swReady(page);
  await page.waitForTimeout(5000); // the SW precaches in the background after install
  const ms: number[] = [];
  let fromSw = 0;
  let network = 0;
  for (let i = 0; i < n; i++) {
    fromSw = 0;
    network = 0;
    const onResponse = (r: { fromServiceWorker(): boolean }): void => {
      if (r.fromServiceWorker()) fromSw++;
      else network++;
    };
    page.on('response', onResponse);
    ms.push(await loadToReady(page));
    page.off('response', onResponse);
    const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    if (!controlled) throw new Error('warm load: the service worker does not control the page');
  }
  await ctx.close();
  return { ms, fromSw, network };
}

/** Stop on a long C call (no Python bytecode to interrupt) until the runtime is ready again. */
async function restarts(browser: Browser, n: number): Promise<number[]> {
  const { ctx, page } = await newPage(browser);
  await loadToReady(page);
  await swReady(page);
  await page.waitForTimeout(5000);
  await loadToReady(page); // warm
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const ms = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__machines;
      store
        .getState()
        .setSource('import numpy as np\nnp.linalg.eigvals(np.random.rand(4000, 4000))\n');
      const done = store.getState().run();
      // `started` has arrived once the log exists: the program is executing.
      for (
        let k = 0;
        k < 1500 && !(store.getState().runtime.state === 'running' && store.getState().log);
        k++
      )
        await new Promise((r) => setTimeout(r, 20));
      if (!store.getState().log) throw new Error('restart: the run never started');
      await new Promise((r) => setTimeout(r, 1000)); // margin: into the C call
      if (!store.getState().running) throw new Error('restart: the run ended before Stop');
      const t0 = performance.now();
      store.getState().stop();
      // `running` -> `restarting` -> `ready`
      let sawRestart = false;
      while (!(sawRestart && store.getState().runtime.state === 'ready')) {
        if (performance.now() - t0 > 120_000) throw new Error('restart: not ready after 120 s');
        if (store.getState().runtime.state === 'restarting') sawRestart = true;
        await new Promise((r) => setTimeout(r, 10));
      }
      const t = performance.now() - t0;
      await done;
      const status = store.getState().log?.status;
      if (status !== 'stopped') throw new Error(`restart: run ended as ${status}, not stopped`);
      return t;
    });
    out.push(ms);
  }
  await ctx.close();
  return out;
}

interface RunResult {
  ms: number;
  hashMs?: number;
  status: string;
  error?: string;
}

/** Opens a second worker (the page's own sits idle) and exposes `window.__runs` for timed runs. */
async function runHarness(
  page: Page,
): Promise<(source: string, debug?: 'plain' | 'timing') => Promise<RunResult>> {
  const dbg: string[] = [];
  const hook = (w: { on(ev: 'console', f: (m: { text(): string }) => void): void }): void =>
    w.on('console', (m) => {
      if (m.text().startsWith('[machines-debug] ')) dbg.push(m.text().slice(17));
    });
  page.on('worker', hook);
  await page.evaluate(async () => {
    const entry = performance
      .getEntriesByType('resource')
      .find((e) => /\/worker-[^/]*\.js/.test(e.name));
    if (!entry) throw new Error('worker script not found among resources');
    const w = new Worker(entry.name, { type: 'module' });
    const g = window as unknown as Record<string, unknown>;
    g.__w = w;
    await new Promise<void>((resolve, reject) => {
      w.onmessage = (ev: MessageEvent<{ type: string }>) => ev.data.type === 'ready' && resolve();
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ type: 'init' });
    });
    let nextId = 1000;
    g.__run = (source: string, debug?: string, config?: object) =>
      new Promise<{ ms: number; status: string; error?: string }>((resolve) => {
        const runId = nextId++;
        const t0 = performance.now();
        w.onmessage = (
          ev: MessageEvent<{ type: string; status?: string; error?: { message: string } | null }>,
        ) => {
          if (ev.data.type === 'done')
            resolve({
              ms: performance.now() - t0,
              status: ev.data.status ?? '?',
              error: ev.data.error?.message,
            });
        };
        w.postMessage({
          type: 'run',
          runId,
          source,
          debug,
          config: { ...(g.__runConfig as object), ...config },
        });
      });
  });
  return async (source, debug) => {
    dbg.length = 0;
    const r = await page.evaluate(
      ([s, d]) =>
        (window as unknown as { __run(s: string, d?: string): Promise<RunResult> }).__run(s, d),
      [source, debug] as const,
    );
    // Console messages from the worker arrive a little after its `done`.
    for (let k = 0; debug && !dbg.length && k < 100; k++) await page.waitForTimeout(20);
    if (debug && r.status !== 'ok') throw new Error(`debug run failed: ${r.status} ${r.error}`);
    if (debug && !dbg.length) throw new Error('no debug timing arrived from the worker');
    const info = dbg.length
      ? (JSON.parse(dbg[dbg.length - 1] as string) as { ms: number; hash_ms?: number })
      : null;
    // The in-Python time excludes message passing and the package imports a run triggers.
    return { ...r, ms: info?.ms ?? r.ms, hashMs: info?.hash_ms };
  };
}

async function uploadCsv(page: Page, name: string, file: string): Promise<void> {
  const b64 = readFileSync(path.join(ROOT, 'fixtures/data', file)).toString('base64');
  await page.evaluate(
    ([n, data]) => {
      const bytes = Uint8Array.from(atob(data as string), (c) => c.charCodeAt(0));
      (window as unknown as { __w: Worker }).__w.postMessage(
        { type: 'file', name: n, bytes: bytes.buffer },
        [bytes.buffer],
      );
    },
    [name, b64],
  );
  await page.waitForTimeout(500);
}

// ---- output ----------------------------------------------------------------------------------------

const fmt = (ms: number): string =>
  Math.round(ms) >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const spread = (xs: number[]): string =>
  `${fmt(median(xs))} (min ${fmt(Math.min(...xs))}, max ${fmt(Math.max(...xs))}, n=${xs.length})`;

async function main(): Promise<void> {
  const reps = QUICK ? 1 : 3;
  const link: Link = { bytesPerSec: Infinity, rttMs: 0, bytes: 0 };
  PORT = await freePort();
  PREVIEW_PORT = await freePort();
  const preview = await startPreview();
  const proxy = await startProxy(link);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const rows: [string, string][] = [];
  const raw: Record<string, unknown> = {};
  try {
    const log = (k: string, v: string, r?: unknown): void => {
      rows.push([k, v]);
      raw[k] = r ?? v;
      console.error(`${k}: ${v}`);
    };

    const cold = await coldLoads(browser, reps, link);
    log('Cold load to ready (cache disabled)', spread(cold.ms), cold.ms);
    log('Cold load transfer (uncompressed)', `${cold.mb.toFixed(1)} MB`, cold.mb);
    const warm = await warmLoads(browser, reps);
    log('Warm load to ready (service worker cache)', spread(warm.ms), warm);
    log(
      'Warm load requests (last load)',
      `${warm.fromSw} served by the service worker, ${warm.network} to the network`,
    );
    const rs = await restarts(browser, reps);
    log('Worker restart after Stop on a C call, to ready', spread(rs), rs);

    // Run times in one worker.
    const { ctx, page } = await newPage(browser);
    await loadToReady(page);
    const run = await runHarness(page);
    await uploadCsv(page, 'listings_10k.csv', 'listings_10k.csv');
    const nb = program('notebook.py');
    const heavy = program('heavy.py');
    await run(nb, 'plain'); // warm-up: first imports, first fit
    await run(nb, 'timing');
    const nbPlain: number[] = [];
    const nbInstr: number[] = [];
    const nbHash: number[] = [];
    for (let i = 0; i < (QUICK ? 3 : 10); i++) {
      nbPlain.push((await run(nb, 'plain')).ms);
      const r = await run(nb, 'timing');
      nbInstr.push(r.ms);
      nbHash.push(r.hashMs ?? 0);
    }
    log('notebook.py plain Python', spread(nbPlain), nbPlain);
    log('notebook.py instrumented', spread(nbInstr), nbInstr);
    const nbOver = median(nbInstr) - median(nbPlain);
    log(
      'notebook.py instrumentation overhead',
      `${fmt(nbOver)} (${((nbOver / median(nbPlain)) * 100).toFixed(0)}% of plain)`,
      nbOver,
    );
    log(
      'notebook.py content hashing share',
      `${((median(nbHash) / median(nbInstr)) * 100).toFixed(1)}% of instrumented run`,
      nbHash,
    );

    const first = await run(heavy, 'plain');
    if (first.status !== 'ok') throw new Error(`heavy.py failed: ${first.error}`);
    const hPlain: number[] = [];
    const hInstr: number[] = [];
    const hHash: number[] = [];
    for (let i = 0; i < reps; i++) {
      hPlain.push((await run(heavy, 'plain')).ms);
      const r = await run(heavy, 'timing');
      if (r.status !== 'ok') throw new Error(`heavy.py instrumented: ${r.status} ${r.error}`);
      hInstr.push(r.ms);
      hHash.push(r.hashMs ?? 0);
    }
    log('heavy.py plain Python', spread(hPlain), hPlain);
    log('heavy.py instrumented', spread(hInstr), hInstr);
    const hOver = median(hInstr) - median(hPlain);
    log(
      'heavy.py instrumentation overhead',
      `${fmt(hOver)} (${((hOver / median(hPlain)) * 100).toFixed(0)}% of plain)`,
      hOver,
    );
    log(
      'heavy.py content hashing share',
      `${((median(hHash) / median(hInstr)) * 100).toFixed(1)}% of instrumented run`,
      hHash,
    );

    // n_jobs inside the browser: does it run, and does it help?
    const njobs = (n: number): string =>
      `import numpy as np\nfrom sklearn.ensemble import RandomForestRegressor\nrng = np.random.RandomState(0)\nX = rng.rand(4000, 8)\ny = X @ rng.rand(8)\nRandomForestRegressor(n_estimators=60, n_jobs=${n}, random_state=0).fit(X, y)\nprint("ok")\n`;
    await run(njobs(1));
    const j1 = await run(njobs(1));
    const j2 = await run(njobs(2));
    const jm1 = await run(njobs(-1));
    const state = (r: RunResult): string =>
      r.status === 'ok' ? fmt(r.ms) : `${r.status}: ${r.error ?? ''}`.slice(0, 120);
    log(
      'n_jobs (RandomForest 60 trees): 1 / 2 / -1',
      `${state(j1)} / ${state(j2)} / ${state(jm1)}`,
      { j1, j2, jm1 },
    );
    await ctx.close();

    if (!QUICK) {
      for (const [label, mbps, rtt] of [
        ['~10 Mbps', 10, 40],
        ['Fast 3G (1.6 Mbps, 150 ms RTT)', 1.6, 150],
      ] as const) {
        link.bytesPerSec = (mbps * 1e6) / 8;
        link.rttMs = rtt;
        const t = await coldLoads(browser, 1, link);
        log(`Cold load, ${label}`, `${fmt(t.ms[0] as number)} (${t.mb.toFixed(1)} MB)`, t);
      }
      link.bytesPerSec = Infinity;
      link.rttMs = 0;
    }
    rows.push(['Classroom wifi, full section loading at once', 'not measured (human test)']);

    const v = await browser.version();
    console.log(
      `\nMachine: ${os.cpus()[0]?.model}, ${os.cpus().length} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB, ${os.platform()} ${os.release()}`,
    );
    console.log(
      `Browser: Chrome ${v} (headless), ${new Date().toISOString().slice(0, 10)}, localhost preview of the production build`,
    );
    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, val] of rows) console.log(`${k.padEnd(w)}  ${val}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(raw, null, 2));
  } finally {
    await browser.close();
    proxy.close();
    stopPreview(preview);
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
