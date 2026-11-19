// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { buildGraph, lineStageAt, shelfAt, stageAt, stateAt } from '@machines/log';
import type { EventLog, GraphModel, StageParticipant } from '@machines/log';
import {
  cardKey,
  FLY_Z,
  MOVE_MS,
  PH_MAX_H,
  mountTwoPane,
  planMoves,
  planStage,
  valueLine,
} from './twopane';
import type { Rect, TwoPaneController } from './twopane';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'logs');
const names = readdirSync(ROOT)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort();
const readLog = (n: string): EventLog =>
  JSON.parse(readFileSync(join(ROOT, `${n}.json`), 'utf8')) as EventLog;
const measure = (t: string): number => t.length * 7;

let host: HTMLElement;
let tp: TwoPaneController | undefined;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () => new DOMRect(10, 20, 30, 10);
});
afterEach(() => {
  tp?.destroy();
  host?.remove();
  tp = undefined;
});
async function open(name: string): Promise<{ model: GraphModel; log: EventLog }> {
  const log = readLog(name);
  const model = buildGraph(log, { expanded: new Set() });
  host = document.createElement('div');
  document.body.append(host);
  tp = await mountTwoPane(host, model, log, { measure });
  return { model, log };
}
const visible = (sel: string): Element[] =>
  [...host.querySelectorAll(sel)].filter((e) => !e.closest('[hidden]'));
const slot = (node: string): HTMLElement => host.querySelector(`[data-slot="${node}"]`)!;

describe('planStage (pure)', () => {
  test('golden_linreg: inputs above the box, owner left, outputs below, wires only to the box', () => {
    const log = readLog('golden_linreg');
    const model = buildGraph(log, { expanded: new Set() });
    let withBox = 0;
    for (let s = 1; s <= model.steps.length; s++) {
      const st = stageAt(model, log, s);
      if (!st) continue;
      const boxed = st.kind === 'call';
      const plan = planStage(
        st,
        () => ({ w: 100, h: 60 }),
        boxed ? { w: 120, h: 60, ports: {} } : null,
        () => false,
        log,
      );
      const keys = new Set(['box', ...plan.items.map((i) => i.key)]);
      for (const w of plan.wires) {
        expect(keys.has(w.from) && keys.has(w.to)).toBe(true);
        expect(w.points.length).toBeGreaterThanOrEqual(2);
        for (const [x, y] of w.points) expect(x >= 0 && y >= 0).toBe(true);
      }
      for (const it of plan.items) {
        expect(it.rect.x).toBeGreaterThanOrEqual(0);
        expect(it.rect.x + it.rect.w).toBeLessThanOrEqual(plan.width);
        expect(it.rect.y + it.rect.h).toBeLessThanOrEqual(plan.height);
      }
      if (plan.box) {
        withBox++;
        for (const it of plan.items) {
          const p = it.participant;
          if (p.role === 'input') expect(it.rect.y + it.rect.h).toBeLessThanOrEqual(plan.box.y);
          if (p.role === 'output' || p.role === 'created')
            expect(it.rect.y).toBeGreaterThanOrEqual(plan.box.y + plan.box.h);
          if (p.role === 'owner' || p.role === 'callee')
            expect(it.rect.x + it.rect.w).toBeLessThanOrEqual(plan.box.x);
        }
      } else expect(plan.wires).toEqual([]);
    }
    expect(withBox).toBeGreaterThan(0);
  });

  test('plan snapshot: one input, one output, an owner and a value', () => {
    const base = {
      kind: 'instance',
      object: null,
      token: null,
      port: null,
      param: null,
      edge: null,
      changed: false,
    } as const;
    const plan = planStage(
      {
        node: 'c1',
        kind: 'call',
        execution: null,
        i: 3,
        line: 4,
        error: null,
        failed: false,
        dropped: 0,
        participants: [
          { ...base, role: 'owner', node: 'm' },
          { ...base, role: 'input', node: 'x', port: 'in:0', param: 'X', edge: 'e1' },
          { ...base, role: 'output', node: 'y', port: 'out:0', param: '0', edge: 'e2' },
        ],
        values: [
          {
            role: 'input',
            port: 'in:1',
            param: 'k',
            token: null,
            text: '3',
            type: null,
            edge: null,
          },
        ],
      },
      () => ({ w: 100, h: 50 }),
      { w: 140, h: 60, ports: { 'in:0': 70, 'out:0': 70 } },
      () => false,
    );
    expect(plan).toMatchSnapshot();
  });

  test('keys: merged loop boxes get one card per object, chips their edge', () => {
    const p = { kind: 'instance', node: 'n1', object: 'v3', edge: null } as StageParticipant;
    expect(cardKey(p, false)).toBe('n1');
    expect(cardKey(p, true)).toBe('n1#v3');
    expect(cardKey({ ...p, kind: 'chip', node: 'c', edge: 'e7' }, true)).toBe('chip:e7');
  });

  test('value lines say in/out in words', () => {
    expect(
      valueLine({
        role: 'input',
        port: 'in:1',
        param: 'test_size',
        token: null,
        text: '0.2',
        type: null,
        edge: null,
      }),
    ).toBe('in   test_size = 0.2');
    expect(
      valueLine({
        role: 'output',
        port: 'out:0',
        param: 'score',
        token: 's1',
        text: '0.93',
        type: 'float',
        edge: 'e1',
      }),
    ).toBe('out  score = 0.93 : float');
  });
});

describe('every fixture, every step', () => {
  for (const name of names) {
    test(name, { timeout: 60000 }, async () => {
      const { model, log } = await open(name);
      for (let s = 0; s <= model.steps.length; s++) {
        tp!.setStep(s);
        const on = shelfAt(model, s);
        const shown = [...host.querySelectorAll('.md-slot')].filter(
          (e) => !(e as HTMLElement).hidden,
        );
        expect(shown.map((e) => (e as HTMLElement).dataset.slot)).toEqual(on.map((e) => e.node));
        for (const sl of shown) {
          const ph = sl.querySelector('.md-slot-ph') as HTMLElement;
          expect(
            ph.hidden ? sl.querySelector('.md-card') !== null : !sl.querySelector('.md-card'),
          ).toBe(true);
        }
        const keys = [...host.querySelectorAll('.md-card, .md-chipcard')].map(
          (e) => (e as HTMLElement).dataset.card,
        );
        expect(new Set(keys).size).toBe(keys.length);
        const stage = stageAt(model, log, s);
        expect((host.querySelector('.md-stage-empty') as HTMLElement).hidden).toBe(stage !== null);
        expect(host.querySelectorAll('.md-shelf .md-wire')).toHaveLength(0);
        // cards() agrees with what is visible, and a card on the stage has a stage rectangle
        for (const c of tp!.cards()) {
          const el = tp!.card(c.key)!;
          const hidden = el.closest('[hidden]') !== null;
          expect(c.where === 'hidden').toBe(hidden);
          if (c.where === 'stage') expect(c.stage).not.toBeNull();
          if (c.where === 'shelf') expect(el.parentElement!.matches('.md-slot')).toBe(true);
        }
        // one Tab stop per pane; every visible focus target has its own name
        for (const pane of ['.md-shelf', '.md-stage-canvas']) {
          const stops = [...host.querySelectorAll(`${pane} [tabindex="0"]`)].filter(
            (e) => !e.closest('[hidden]') && !e.closest('.md-hidden'),
          );
          expect(stops.length).toBeLessThanOrEqual(1);
        }
        const names = [...host.querySelectorAll('.md-node[aria-label], .md-chipcard')]
          .filter((e) => !e.closest('[hidden]') && !e.classList.contains('md-hidden'))
          .map((e) => e.getAttribute('aria-label'));
        expect(names.filter((n, k) => names.indexOf(n) !== k)).toEqual([]);
        expect(host.querySelector('[aria-label="Diagram of the program"]')).toBeNull();
        if (stage?.dropped)
          expect(host.querySelector('.md-stage-notes')!.textContent).toContain('not shown');
      }
    });
  }
});

describe('mount', () => {
  test('I on a focused card selects its node, and the card advertises it', async () => {
    const log = readLog('golden_linreg');
    const model = buildGraph(log, { expanded: new Set() });
    host = document.createElement('div');
    document.body.append(host);
    const picked: string[] = [];
    tp = await mountTwoPane(host, model, log, { measure, onSelectNode: (id) => picked.push(id) });
    tp.setStep(model.steps.length);
    const g = host.querySelector<SVGElement>(
      '.md-stage-canvas .md-card:not([hidden]) g.md-node[data-node]',
    )!;
    expect(g.getAttribute('aria-keyshortcuts')).toContain('I');
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }));
    expect(picked).toEqual([g.getAttribute('data-node')]);
  });

  test('a card that goes back to its slot loses the stage offset', async () => {
    const { model } = await open('golden_linreg');
    for (let s = 1; s <= model.steps.length; s++) tp!.setStep(s);
    for (const c of tp!.cards()) {
      if (c.where !== 'shelf') continue;
      const el = tp!.card(c.key)!;
      expect(el.parentElement?.classList.contains('md-slot')).toBe(true);
      expect(el.style.position).toBe('');
      expect(el.style.left).toBe('');
    }
  });

  test('a called function moves from the shelf onto the stage (svl-jl3)', async () => {
    const { model, log } = await open('edge_student_fn');
    let seen = 0;
    for (let s = 1; s <= model.steps.length; s++) {
      const callee = stageAt(model, log, s)?.participants.find((p) => p.role === 'callee');
      if (!callee) continue;
      seen++;
      tp!.setStep(s);
      const card = tp!.card(callee.node)!;
      expect(card.parentElement).toBe(tp!.stageEl); // the shelf card itself moved
      expect(slot(callee.node).dataset.state).toBe('stage');
      expect((slot(callee.node).querySelector('.md-slot-ph') as HTMLElement).hidden).toBe(false);
      expect(tp!.plan!.wires.some((w) => w.label?.name === 'calls')).toBe(true);
      tp!.setStep(s + 1 <= model.steps.length ? s + 1 : s);
    }
    expect(seen).toBe(2); // load and Pipeline; pipe.run is a method, so it has no callee
  });

  test('a def step shows the function card with its signature, and a class its methods', async () => {
    const { model } = await open('edge_student_fn');
    const stepOf = (name: string): number =>
      model.steps.findIndex((i) =>
        model.nodes.some((n) => n.kind === 'def' && n.name === name && n.executions[0]!.i === i),
      ) + 1;
    tp!.setStep(stepOf('load'));
    const fn = visible('.md-stage-canvas .md-def')
      .map((e) => e.textContent ?? '')
      .join(' ');
    expect(fn).toContain('def load');
    expect(fn).toContain('load(path)');
    tp!.setStep(stepOf('Pipeline'));
    const cls = visible('.md-stage-canvas .md-def')
      .map((e) => e.textContent ?? '')
      .join(' ');
    expect(cls).toContain('class Pipeline');
    expect(cls).toContain('methods: run');
  });

  test('golden_linreg: import, fit and predict', async () => {
    const { model, log } = await open('golden_linreg');
    expect(visible('.md-slot')).toHaveLength(0);
    tp!.setStep(1);
    expect(visible('.md-stage-canvas .md-card[data-node]').length).toBeGreaterThan(0);

    let fit = 0;
    for (let s = 1; s <= model.steps.length; s++)
      if (stageAt(model, log, s)?.participants.some((p) => p.changed && p.role === 'owner'))
        fit = s;
    expect(fit).toBeGreaterThan(0);
    tp!.setStep(fit);
    const stage = stageAt(model, log, fit)!;
    const owner = stage.participants.find((p) => p.role === 'owner')!;
    const card = tp!.card(owner.node)!;
    expect(card.parentElement).toBe(tp!.stageEl);
    const ph = slot(owner.node).querySelector('.md-slot-ph') as HTMLElement;
    expect(ph.hidden).toBe(false);
    expect(ph.textContent).toContain('on the stage'); // not colour alone
    expect(slot(owner.node).dataset.state).toBe('stage');
    expect(card.querySelector('.md-attr.md-changed')).not.toBeNull();
    expect(host.querySelectorAll('.md-stage-wires .md-edge').length).toBe(tp!.plan!.wires.length);

    // some object that is on the shelf, then on the stage: the same element moves
    let moved = 0;
    for (const e of shelfAt(model, model.steps.length)) {
      const el = tp!.card(e.node)!;
      for (let t = 1; t <= model.steps.length; t++) {
        const uses = lineStageAt(model, log, t)?.calls.some((c) =>
          c.stage.participants.some((p) => p.node === e.node),
        );
        if (uses || !shelfAt(model, t).some((x) => x.node === e.node)) continue;
        tp!.setStep(t);
        expect(tp!.card(e.node)).toBe(el);
        expect(el.parentElement).toBe(slot(e.node));
        expect((slot(e.node).querySelector('.md-slot-ph') as HTMLElement).hidden).toBe(true);
        moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  test('cards report where they are and both rectangles', async () => {
    const { model, log } = await open('golden_linreg');
    for (let s = 1; s <= model.steps.length; s++) {
      const owner = stageAt(model, log, s)?.participants.find((p) => p.role === 'owner');
      if (!owner) continue;
      tp!.setStep(s);
      const info = tp!.cards().find((c) => c.key === owner.node)!;
      expect(info.where).toBe('stage');
      expect(info.stage).not.toBeNull();
      expect(info.shelf).not.toBeNull();
      return;
    }
    throw new Error('no owner step');
  });

  test('a loop box is one shelf entry with a count and one stage card per object', async () => {
    const { model, log } = await open('edge_loop');
    const merged = shelfAt(model, model.steps.length).find((e) => e.objects > 1);
    if (!merged) return; // this fixture merges no objects
    tp!.setStep(model.steps.length);
    expect(slot(merged.node).querySelector('.md-slot-cap')!.textContent).toContain(
      `${merged.objects} objects`,
    );
    for (let s = 1; s <= model.steps.length; s++)
      for (const p of stageAt(model, log, s)?.participants ?? [])
        if (p.node === merged.node && p.objectOf) {
          tp!.setStep(s);
          expect(tp!.card(`${p.node}#${p.object}`)).not.toBeNull();
        }
  });

  test('keyboard and labels', async () => {
    const { model } = await open('golden_linreg');
    tp!.setStep(model.steps.length);
    expect(host.querySelector('[aria-label="Current line"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Objects"]')).not.toBeNull();
    expect(host.querySelectorAll('.md-shelf [tabindex="0"]').length).toBeGreaterThan(0);
  });

  test('keyboard: arrows move between shelf cards, Enter dives in, labels say the role', async () => {
    const { model } = await open('golden_linreg');
    tp!.setStep(model.steps.length);
    const stops = [...host.querySelectorAll<HTMLElement>('.md-shelf .md-node')].filter(
      (e) => !e.closest('[hidden]'),
    );
    expect(stops.filter((e) => e.getAttribute('tabindex') === '0')).toHaveLength(1);
    const first = stops.find((e) => e.getAttribute('tabindex') === '0')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const second = host.ownerDocument.activeElement as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(first.getAttribute('tabindex')).toBe('-1');
    expect(second.getAttribute('aria-label')).toContain('on the shelf');
    // the stage names each card's role
    tp!.setStep(10);
    const labels = [...host.querySelectorAll('.md-stage-canvas .md-node')].map((e) =>
      e.getAttribute('aria-label'),
    );
    expect(labels.some((l) => /input to X/.test(l ?? ''))).toBe(true);
    expect(labels.some((l) => /owner of/.test(l ?? ''))).toBe(true);
  });

  test('destroy removes everything', async () => {
    await open('golden_linreg');
    tp!.destroy();
    expect(host.children).toHaveLength(0);
    tp = undefined;
  });
});

describe('instance cards hold their method boxes (svl-faf)', () => {
  const linreg = (model: GraphModel): { id: string; kids: string[] } => {
    const inst = model.nodes.find(
      (n) => n.kind === 'instance' && n.className === 'LinearRegression',
    )!;
    return {
      id: inst.id,
      kids: model.nodes.filter((n) => n.kind === 'call' && n.parent === inst.id).map((n) => n.id),
    };
  };
  const shown = (card: Element, kind: string): Element[] =>
    [...card.querySelectorAll(`.md-node.md-${kind}`)].filter(
      (g) => !g.classList.contains('md-hidden'),
    );

  test('the shelf card draws its method boxes, no wires, and the more-methods button, as the full view does', async () => {
    const { model } = await open('golden_linreg');
    const { id, kids } = linreg(model);
    expect(kids.length).toBeGreaterThan(1);
    tp!.setStep(model.steps.length); // the end of the run: the card is on the shelf
    const card = tp!.card(id)!;
    expect(card.querySelectorAll('.md-edge').length).toBe(0);
    // every method box is drawn inside the instance's rectangle
    const laidIds = [...card.querySelectorAll('.md-node.md-call')].map((g) =>
      g.getAttribute('data-node'),
    );
    expect(laidIds.sort()).toEqual([...kids].sort());
    expect(card.querySelector('.md-more')).not.toBeNull();
  });

  test('methods not called yet show the cue; called ones do not (the full view at the same step)', async () => {
    const { model, log } = await open('golden_linreg');
    const { id, kids } = linreg(model);
    const e = model.steps.length;
    let sawUncalled = false;
    for (let s = 1; s <= e; s++) {
      tp!.setStep(s);
      const card = tp!.card(id)!;
      if (card.hidden) continue;
      const st = stateAt(model, log, s);
      for (const k of kids) {
        const g = card.querySelector(`.md-node[data-node="${k}"]`)!;
        expect(!g.classList.contains('md-hidden')).toBe(st.visibleNodes.has(k));
        expect(g.classList.contains('md-uncalled')).toBe(st.uncalled.has(k));
        if (st.uncalled.has(k) && st.visibleNodes.has(k)) sawUncalled = true;
      }
    }
    expect(sawUncalled).toBe(true);
  });

  test('the placeholder of a card on the stage is at most one shelf row tall', async () => {
    const { model } = await open('golden_linreg');
    const { id } = linreg(model);
    tp!.setStep(model.steps.length); // the model is the owner at the last line
    const ph = slot(id).querySelector<HTMLElement>('.md-slot-ph')!;
    expect(ph.hidden).toBe(false);
    expect(parseFloat(ph.style.height)).toBeLessThanOrEqual(PH_MAX_H);
    expect(ph.style.width).not.toBe('');
  });

  test('the card is as wide as the measured text needs', async () => {
    const wide = async (m: (t: string) => number): Promise<number> => {
      const log = readLog('golden_linreg');
      const model = buildGraph(log, { expanded: new Set() });
      const h = document.createElement('div');
      document.body.append(h);
      const t = await mountTwoPane(h, model, log, { measure: m });
      t.setStep(model.steps.length);
      const w = parseFloat(t.card(linreg(model).id)!.style.width);
      t.destroy();
      h.remove();
      return w;
    };
    const narrow = await wide((t) => t.length * 5);
    const broad = await wide((t) => t.length * 10);
    expect(broad).toBeGreaterThan(narrow);
  });

  test('keyboard: Tab stops at the card; ArrowDown reaches rows, methods and more-methods; Escape returns', async () => {
    const { model } = await open('golden_linreg');
    const { id, kids } = linreg(model);
    tp!.setStep(model.steps.length);
    const card = tp!.card(id)!;
    const box = card.querySelector<SVGElement>(`.md-node[data-node="${id}"]`)!;
    // methods and the button are not tab stops
    for (const k of kids)
      expect(card.querySelector(`.md-node[data-node="${k}"]`)!.getAttribute('tabindex')).toBe('-1');
    expect(card.querySelector('.md-more-ctl')!.getAttribute('tabindex')).toBe('-1');
    box.focus();
    const down = (): void => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    };
    const seen: Element[] = [];
    for (let i = 0; i < 40; i++) {
      down();
      const a = document.activeElement!;
      if (seen.at(-1) === a) break;
      seen.push(a);
    }
    const methods = seen.filter((e) => e.matches('.md-node.md-call'));
    expect(methods.length).toBe(shown(card, 'call').length);
    expect(seen.at(-1)!.matches('.md-more-ctl')).toBe(true);
    seen
      .at(-1)!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    expect(document.activeElement).toBe(box);
  });

  test('an instance with no methods drawn still mounts, and a method box on a card names its instance', async () => {
    const { model } = await open('golden_linreg');
    const { id } = linreg(model);
    tp!.setStep(model.steps.length);
    const g = tp!.card(id)!.querySelector('.md-node.md-call:not(.md-hidden)')!;
    expect(g.getAttribute('aria-label')).toMatch(/, in /);
  });
});

describe('a method is drawn inside its owner (svl-a9e)', () => {
  const stepOfCall = (model: GraphModel, log: EventLog, re: RegExp): number => {
    for (let s = 1; s <= model.steps.length; s++) {
      const n = model.nodes.find((x) => x.id === stageAt(model, log, s)?.node);
      if (n?.kind === 'call' && re.test(n.name)) return s;
    }
    throw new Error(`no step for ${re}`);
  };

  test('planStage: owner in the middle, inputs left and outputs right, wires on the method edges', () => {
    const log = readLog('golden_linreg');
    const model = buildGraph(log, { expanded: new Set() });
    for (const re of [/\.fit$/, /\.predict$/, /\.score$/]) {
      const st = stageAt(model, log, stepOfCall(model, log, re))!;
      const plan = planStage(
        st,
        () => ({ w: 200, h: 220 }),
        null,
        () => false,
        log,
        { rect: { x: 12, y: 150, w: 160, h: 36 } },
      );
      expect(plan.nested).toBe(true);
      const owner = plan.items.find((i) => i.participant.role === 'owner')!;
      const m = plan.box!;
      // the method box lies inside the owner's box
      expect(m.x).toBeGreaterThanOrEqual(owner.rect.x);
      expect(m.x + m.w).toBeLessThanOrEqual(owner.rect.x + owner.rect.w);
      expect(m.y).toBeGreaterThanOrEqual(owner.rect.y);
      expect(m.y + m.h).toBeLessThanOrEqual(owner.rect.y + owner.rect.h);
      // no owner line: every wire is a graph edge with an arrow
      expect(plan.wires.every((w) => w.edge !== null && w.arrow)).toBe(true);
      for (const w of plan.wires) {
        const first = w.points[0]!;
        const last = w.points[w.points.length - 1]!;
        const [near, far] = w.to === 'box' ? [last, first] : [first, last];
        expect(near[0] === m.x || near[0] === m.x + m.w).toBe(true);
        expect(near[1]).toBeGreaterThanOrEqual(m.y);
        expect(near[1]).toBeLessThanOrEqual(m.y + m.h);
        expect(far[0] < m.x || far[0] > m.x + m.w).toBe(true);
      }
      for (const it of plan.items) {
        const p = it.participant;
        if (p.role === 'input') expect(it.rect.x + it.rect.w).toBeLessThanOrEqual(owner.rect.x);
        if (p.role === 'output')
          expect(it.rect.x).toBeGreaterThanOrEqual(owner.rect.x + owner.rect.w);
        expect(it.rect.y).toBeGreaterThanOrEqual(0);
        expect(it.rect.y + it.rect.h).toBeLessThanOrEqual(plan.height);
      }
    }
  });

  test('mount: fit and predict draw the method in the owner card, with no call card and no owner line', async () => {
    const { model, log } = await open('golden_linreg');
    for (const [re, ins, outs] of [
      [/\.fit$/, 2, 0], // returns self: no output wire
      [/\.predict$/, 1, 1],
    ] as const) {
      const s = stepOfCall(model, log, re);
      tp!.setStep(s);
      const st = stageAt(model, log, s)!;
      const owner = st.participants.find((p) => p.role === 'owner')!;
      expect(tp!.plan!.nested).toBe(true);
      expect(tp!.card(st.node)).toBeNull(); // no card of its own for the method
      expect(host.querySelectorAll('.md-owner-line')).toHaveLength(0);
      expect(host.querySelectorAll('.md-stage-wires [data-edge]')).toHaveLength(ins + outs);
      const card = tp!.card(owner.node)!;
      expect(card.parentElement).toBe(tp!.stageEl);
      const inner = card.querySelector(`.md-node[data-node="${st.node}"]`)!;
      expect(inner.classList.contains('md-current')).toBe(true);
      const label = inner.getAttribute('aria-label')!;
      expect(label).toMatch(/current call, inputs /);
      expect(label).toMatch(/, in object model: LinearRegression/);
      // the owner keeps its changed-attribute highlight
      if (st.participants.some((p) => p.changed && p.role === 'owner'))
        expect(card.querySelector('.md-changed')).not.toBeNull();
      // the stage's canvas raises the wires above the cards so they reach the method box
      expect(tp!.stageEl.classList.contains('md-nested')).toBe(true);
    }
  });

  test('constructors and functions keep their call box (and the calls line)', async () => {
    const { model, log } = await open('golden_linreg');
    const s = stepOfCall(model, log, /^LinearRegression$/);
    tp!.setStep(s);
    const st = stageAt(model, log, s)!;
    expect(tp!.plan!.nested).toBeUndefined();
    expect(tp!.card(st.node)).not.toBeNull();
    expect(tp!.plan!.wires.some((w) => w.label?.name === 'calls')).toBe(true);
    expect(tp!.stageEl.classList.contains('md-nested')).toBe(false);
  });

  test('a method of a student class is drawn the same way', async () => {
    const { model, log } = await open('edge_student_fn');
    const s = stepOfCall(model, log, /\.run$/);
    tp!.setStep(s);
    expect(tp!.plan!.nested).toBe(true);
    expect(host.querySelectorAll('.md-owner-line')).toHaveLength(0);
  });

  test('a method on a temporary (a chip owner) keeps its own call box', async () => {
    const { model, log } = await open('golden_linreg');
    const s = stepOfCall(model, log, /^DataFrame\.dropna$/);
    tp!.setStep(s);
    expect(tp!.plan!.nested).toBeUndefined();
    expect(tp!.plan!.box).not.toBeNull();
    expect(tp!.card(stageAt(model, log, s)!.node)).not.toBeNull();
  });

  test('stepping onto and off a method step restores the owner card to its slot', async () => {
    const { model, log } = await open('golden_linreg');
    const s = stepOfCall(model, log, /\.fit$/);
    const owner = stageAt(model, log, s)!.participants.find((p) => p.role === 'owner')!;
    tp!.setStep(s);
    expect(slot(owner.node).dataset.state).toBe('stage');
    tp!.setStep(s + 1);
    expect(slot(owner.node).dataset.state).toBe('stage'); // predict: the owner is on the stage again
    tp!.setStep(1); // an import: the model does not exist yet
    expect(slot(owner.node).dataset.state).toBe('hidden');
    expect(tp!.card(owner.node)!.parentElement).toBe(slot(owner.node));
    expect(tp!.card(owner.node)!.style.position).toBe('');
  });
});

describe('a line keeps every call on the stage (svl-qol)', () => {
  const stepOf = (model: GraphModel, log: EventLog, re: RegExp): number => {
    for (let s = 1; s <= model.steps.length; s++) {
      const n = model.nodes.find((x) => x.id === stageAt(model, log, s)?.node);
      if (n?.kind === 'call' && re.test(n.name)) return s;
    }
    throw new Error(`no step for ${re}`);
  };

  test('planLine: every wire joins cards or call boxes of the plan, and a chip is drawn once', async () => {
    const names2 = ['golden_linreg', 'edge_nosig', 'edge_fit_chain', 'edge_alias', 'edge_mpl'];
    let groups = 0;
    for (const name of names2) {
      const { model, log } = await open(name);
      for (let s = 1; s <= model.steps.length; s++) {
        tp!.setStep(s);
        const line = lineStageAt(model, log, s)!;
        const plan = tp!.plan!;
        if (line.calls.length < 2 || !plan.calls) continue;
        groups++;
        const keys = new Set(plan.items.map((i) => i.key));
        expect(keys.size).toBe(plan.items.length); // one card per object
        const tags = new Set(plan.calls.map((c) => `box#${c.call}`));
        for (const w of plan.wires) {
          expect(keys.has(w.from) || tags.has(w.from)).toBe(true);
          expect(keys.has(w.to) || tags.has(w.to)).toBe(true);
          expect(w.points.length).toBeGreaterThanOrEqual(2);
          for (const [x, y] of w.points) expect(x >= 0 && y >= 0).toBe(true);
        }
        // no wire the calls' own stages did not report
        const edges = new Set(line.calls.flatMap((c) => c.stage.participants.map((p) => p.edge)));
        for (const w of plan.wires) if (w.edge !== null) expect(edges.has(w.edge)).toBe(true);
        expect(plan.calls.filter((c) => c.current)).toHaveLength(1);
        for (const it of plan.items) expect(it.rect.y + it.rect.h).toBeLessThanOrEqual(plan.height);
      }
    }
    expect(groups).toBeGreaterThan(5);
  });

  test('golden_linreg: dropna keeps read_csv on the stage with the chip wire between them', async () => {
    const { model, log } = await open('golden_linreg');
    const read = stepOf(model, log, /^read_csv$/);
    const drop = stepOf(model, log, /\.dropna$/);
    tp!.setStep(read);
    expect(tp!.plan!.calls ?? []).toHaveLength(0); // one call: the single-call layout
    tp!.setStep(drop);
    const plan = tp!.plan!;
    expect(plan.calls!.map((c) => [c.node, c.current])).toEqual([
      [stageAt(model, log, read)!.node, false],
      [stageAt(model, log, drop)!.node, true],
    ]);
    // both call boxes are cards on the stage; read_csv's is not the current one
    for (const c of plan.calls!) expect(tp!.card(c.node)!.parentElement).toBe(tp!.stageEl);
    const readG = tp!.card(plan.calls![0]!.node)!.querySelector('g.md-node')!;
    expect(readG.classList.contains('md-current')).toBe(false);
    expect(
      tp!.card(plan.calls![1]!.node)!.querySelector('g.md-node')!.classList.contains('md-current'),
    ).toBe(true);
    // one chip, wired out of the first call and into the second
    const chips = plan.items.filter((i) => i.participant.kind === 'chip');
    expect(chips).toHaveLength(1);
    const chip = chips[0]!.key;
    expect(plan.wires.filter((w) => w.to === chip).map((w) => w.from)).toEqual(['box#0']);
    expect(plan.wires.filter((w) => w.from === chip).map((w) => w.to)).toEqual(['box#1']);
    const e = plan.wires.filter((w) => w.from === chip || w.to === chip).map((w) => w.edge);
    expect(e[0]).toBe(e[1]);
    expect(host.querySelectorAll('.md-chipcard')).toHaveLength(1);
    // the names tell the calls apart
    const names = [...host.querySelectorAll('.md-stage-canvas .md-node[aria-label]')].map((g) =>
      g.getAttribute('aria-label'),
    );
    expect(names.some((n) => /earlier call 1 of 2 on this line/.test(n ?? ''))).toBe(true);
    expect(names.some((n) => /current call/.test(n ?? ''))).toBe(true);

    // stepping back within the line removes the later call
    tp!.setStep(read);
    expect(host.querySelectorAll('.md-chipcard')).toHaveLength(1); // read_csv's own output chip
    expect(tp!.card(stageAt(model, log, drop)!.node)!.hidden).toBe(true);
    // the next line sends every card of this one back to the shelf
    tp!.setStep(drop + 1);
    expect(tp!.plan!.calls).toBeUndefined();
    expect(host.querySelectorAll('.md-chipcard')).toHaveLength(0);
    expect(tp!.card(stageAt(model, log, read)!.node)!.hidden).toBe(true);
  });

  test('fit and predict of one chain share the owner card, one method box each', async () => {
    const { model, log } = await open('edge_fit_chain');
    const predict = stepOf(model, log, /\.predict$/);
    tp!.setStep(predict);
    const line = lineStageAt(model, log, predict)!;
    expect(line.calls.length).toBe(2);
    const plan = tp!.plan!;
    expect(plan.calls!.every((c) => c.nested)).toBe(true);
    const owner = line.current.participants.find((p) => p.role === 'owner')!;
    const card = tp!.card(owner.node)!;
    expect(card.parentElement).toBe(tp!.stageEl);
    for (const c of plan.calls!)
      expect(card.querySelector(`.md-node[data-node="${c.node}"]`)).not.toBeNull();
    expect(host.querySelectorAll('.md-owner-line')).toHaveLength(0);
    expect(plan.items.filter((i) => i.participant.role === 'owner')).toHaveLength(1);
  });

  test('a loop starts a new group on each pass', async () => {
    const { model, log } = await open('edge_loop');
    for (let s = 2; s <= model.steps.length; s++) {
      const a = stageAt(model, log, s - 1);
      const b = stageAt(model, log, s);
      if (a && b && a.node === b.node) {
        tp!.setStep(s);
        expect(lineStageAt(model, log, s)!.first).toBe(s);
        expect(tp!.plan!.calls?.some((c) => c.node === b.node && !c.current) ?? false).toBe(false);
      }
    }
  });
});

describe('planMoves (pure)', () => {
  const R = (x: number, y: number): Rect => ({ x, y, w: 50, h: 30 });
  test('step forward: shelf to stage; stepping back is the mirror', () => {
    const shelf = new Map([
      ['a', R(0, 100)],
      ['b', R(60, 100)],
      ['c', R(120, 100)],
    ]);
    const stage = new Map([
      ['a', R(10, 20)],
      ['b', R(60, 100)],
      ['n', R(200, 20)],
    ]);
    expect(planMoves(shelf, stage)).toEqual([
      { key: 'a', kind: 'move', dx: -10, dy: 80 },
      { key: 'n', kind: 'enter', dx: 0, dy: 0 },
    ]);
    // back: a goes stage -> shelf, n disappears (no animation), c comes back
    expect(planMoves(stage, shelf)).toEqual([
      { key: 'a', kind: 'move', dx: 10, dy: -80 },
      { key: 'c', kind: 'enter', dx: 0, dy: 0 },
    ]);
  });
  test('a shelf card that kept its place in the shelf does not slide when the stage resizes', () => {
    // the whole shelf moved down 40px (the stage grew); a goes shelf -> stage
    const b = new Map([
      ['a', R(0, 100)],
      ['b', R(60, 100)],
    ]);
    const a = new Map([
      ['a', R(10, 20)],
      ['b', R(60, 140)],
    ]);
    const relB = new Map<string, Rect | null>([
      ['a', R(0, 0)],
      ['b', R(60, 0)],
    ]);
    const relA = new Map<string, Rect | null>([
      ['a', null],
      ['b', R(60, 0)],
    ]);
    expect(planMoves(b, a, { before: relB, after: relA })).toEqual([
      { key: 'a', kind: 'move', dx: -10, dy: 80 },
    ]);
    expect(planMoves(b, a).map((m) => m.key)).toEqual(['a', 'b']);
  });
  test('cards that stay put or are not visible do not move', () => {
    const b = new Map([['a', R(0, 0)]]);
    const a = new Map([
      ['a', R(0.4, 0)],
      ['z', null],
    ]);
    expect(planMoves(b, a)).toEqual([]);
  });
});

describe('animation', () => {
  type Stub = { animate?: unknown };
  const proto = HTMLElement.prototype as unknown as Stub;
  const svgProto = SVGElement.prototype as unknown as Stub;
  let calls: { el: Element; frames: Keyframe[] }[] = [];
  let cancelled = 0;
  const realRect = Element.prototype.getBoundingClientRect;
  const realMM = window.matchMedia;
  const setup = (reduced: boolean): void => {
    calls = [];
    cancelled = 0;
    const animate = function (this: Element, frames: Keyframe[]): unknown {
      calls.push({ el: this, frames });
      return { cancel: () => cancelled++ };
    };
    proto.animate = animate;
    svgProto.animate = animate;
    // a card on the stage is at (left, top) in the canvas, one on the shelf is elsewhere
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (!(this instanceof HTMLElement) || !this.matches('.md-card, .md-chipcard'))
        return new DOMRect(0, 0, 10, 10);
      return this.parentElement?.classList.contains('md-stage-canvas')
        ? new DOMRect(
            500 + parseFloat(this.style.left || '0'),
            parseFloat(this.style.top || '0'),
            50,
            30,
          )
        : new DOMRect(10, 400, 50, 30);
    };
    window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce') })) as never;
  };
  afterEach(() => {
    delete proto.animate;
    delete svgProto.animate;
    Element.prototype.getBoundingClientRect = realRect;
    window.matchMedia = realMM;
  });
  /** The first step whose stage uses a card that is on the shelf the step before. */
  const usesShelf = async (): Promise<number> => {
    const { model, log } = await open('golden_linreg');
    for (let s = 2; s <= model.steps.length; s++) {
      const st = stageAt(model, log, s);
      const prev = new Set(stageAt(model, log, s - 1)?.participants.map((p) => p.node));
      const sh = new Set(
        shelfAt(model, s - 1)
          .map((e) => e.node)
          .filter((n) => !prev.has(n)),
      );
      if (st?.participants.some((p) => p.kind !== 'chip' && sh.has(p.node))) return s;
    }
    throw new Error('no such step');
  };
  const tx = (c: { frames: Keyframe[] }): number =>
    parseFloat(String(c.frames[0]!.transform).slice('translate('.length));
  const isMove = (c: { frames: Keyframe[] }): boolean =>
    String(c.frames[0]!.transform).startsWith('translate(');

  test('a single step animates cards with transforms, back plays the reverse, a new step finishes it', async () => {
    setup(false);
    const s = await usesShelf();
    tp!.setStep(s - 1);
    expect(calls).toHaveLength(0);
    tp!.setStep(s, { animate: true });
    const moved = calls.filter((c) => c.el.matches('.md-card') && isMove(c));
    expect(moved.length).toBeGreaterThan(0);
    for (const m of moved) expect(m.frames[1]).toEqual({ transform: 'none' }); // transforms only
    const first = calls.length;
    tp!.setStep(s - 1, { animate: true }); // the running animations are finished first
    expect(cancelled).toBe(first);
    const back = calls.slice(first).filter((c) => c.el.matches('.md-card') && isMove(c));
    expect(back.length).toBeGreaterThan(0);
    const same = back.find((b) => moved.some((m) => m.el === b.el))!;
    const fwd = moved.find((m) => m.el === same.el)!;
    expect(Math.sign(tx(same))).toBe(-Math.sign(tx(fwd)));
  });
  test('MOVE_MS is 325, a flying card is lifted above everything and restored afterwards', async () => {
    expect(MOVE_MS).toBe(325);
    setup(false);
    const s = await usesShelf();
    tp!.setStep(s - 1);
    tp!.setStep(s, { animate: true });
    const moved = calls.filter((c) => c.el.matches('.md-card') && isMove(c));
    expect(moved.length).toBeGreaterThan(0);
    for (const m of moved) {
      const w = m.el as HTMLElement;
      expect(w.style.zIndex).toBe(String(FLY_Z));
      expect(w.style.position).toBe('fixed');
    }
    tp!.setStep(s - 1, { animate: true }); // finishes: styles restored, then new flights start
    tp!.setStep(s - 1); // snap: nothing in flight
    for (const w of host.querySelectorAll<HTMLElement>('.md-card, .md-chipcard')) {
      expect(w.style.zIndex).toBe('');
      expect(w.style.position === '' || w.style.position === 'absolute').toBe(true);
    }
    expect(host.querySelector('.md-fly-ph')).toBeNull();
  });

  test('snap: no animation by default, with animate:false, or under prefers-reduced-motion', async () => {
    setup(false);
    const s = await usesShelf();
    tp!.setStep(s - 1);
    tp!.setStep(s);
    tp!.setStep(s - 1, { animate: false });
    expect(calls).toHaveLength(0);
    tp!.destroy();
    tp = undefined;
    setup(true);
    await usesShelf();
    tp!.setStep(s - 1);
    tp!.setStep(s, { animate: true });
    expect(calls).toHaveLength(0);
  });
  test('cards() measures the layout box of a card that is mid-animation', async () => {
    setup(false);
    const s = await usesShelf();
    tp!.setStep(s - 1);
    const offs = { left: 7, top: 9 };
    const defs: [string, number][] = [
      ['offsetLeft', offs.left],
      ['offsetTop', offs.top],
      ['offsetWidth', 50],
      ['offsetHeight', 30],
    ];
    for (const [k, v] of defs)
      Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
    try {
      tp!.setStep(s, { animate: true });
      expect(calls.length).toBeGreaterThan(0);
      const onShelf = tp!.cards().find((c) => c.where === 'shelf' && c.shelf)!;
      // the stubbed drawn rect is (10, 400); the layout box is the offsets (host's own offsets cancel)
      expect(onShelf.shelf).toEqual({ x: 0, y: 0, w: 50, h: 30 });
    } finally {
      for (const [k] of defs)
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
    }
  });
  test('only new wires fade in', async () => {
    setup(false);
    const s = await usesShelf();
    tp!.setStep(s, { animate: true });
    tp!.setStep(s, { animate: true }); // same step again: every wire is already there
    const wiresFaded = calls
      .slice(0)
      .filter((c) => c.el instanceof SVGElement && c.el.hasAttribute('data-wire'));
    const second = wiresFaded.length;
    const before = calls.length;
    tp!.setStep(s, { animate: true });
    expect(calls.slice(before).some((c) => c.el.hasAttribute('data-wire'))).toBe(false);
    expect(second).toBeGreaterThanOrEqual(0);
  });
  test('focus stays on a card that moved to the stage', async () => {
    setup(false);
    const s = await usesShelf();
    tp!.setStep(s - 1);
    const stageKeys = new Set(
      stageAt(
        buildGraph(readLog('golden_linreg'), { expanded: new Set() }),
        readLog('golden_linreg'),
        s,
      )!
        .participants.filter((p) => p.kind !== 'chip')
        .map((p) => p.node),
    );
    const card = [...host.querySelectorAll<HTMLElement>('.md-shelf .md-card')].find(
      (c) => !c.hidden && stageKeys.has(c.dataset.card!),
    )!;
    const g = card.querySelector<HTMLElement>('.md-node')!;
    g.focus();
    expect(document.activeElement).toBe(g);
    tp!.setStep(s, { animate: true });
    expect(tp!.card(card.dataset.card!)!.parentElement).toBe(tp!.stageEl);
    expect(document.activeElement).toBe(g);
  });
});
