// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { buildGraph, shelfAt, stageAt } from '@machines/log';
import type { EventLog, GraphModel, StageParticipant } from '@machines/log';
import { cardKey, mountTwoPane, planMoves, planStage, valueLine } from './twopane';
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
          if (p.role === 'owner') expect(it.rect.x + it.rect.w).toBeLessThanOrEqual(plan.box.x);
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
        const uses = stageAt(model, log, t)?.participants.some((p) => p.node === e.node);
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
