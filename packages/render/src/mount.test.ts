// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import ELKBundled from 'elkjs/lib/elk.bundled.js';
import type { ELK } from 'elkjs/lib/elk-api';
import { buildGraph, stateAt } from '@machines/log';
import type { EventLog, GNode, GraphModel } from '@machines/log';
import { linregLog, loopLog, splitLog, twoModelsLog } from '../dev/models';
import { layout } from './layout';
import type { Laid } from './layout';
import { createLegend, createLegendList, LEGEND_ITEMS } from './legend';
import { mount } from './mount';
import type { DiagramController } from './mount';
import { attrRowsFor } from './svg';

const measure = (t: string): number => t.length * 7;
const realElk = new ELKBundled() as unknown as ELK;
const elkSpy = {
  layout: vi.fn((g: Parameters<ELK['layout']>[0]) => realElk.layout(g)),
} as unknown as ELK;

async function prepare(log: EventLog): Promise<{ model: GraphModel; laid: Laid }> {
  const model = buildGraph(log, { expanded: new Set() });
  const laid = await layout(model, { measure, elk: elkSpy, attrRows: attrRowsFor(model, log) });
  return { model, laid };
}

let host: HTMLElement;
let ctl: DiagramController | undefined;
const calls = { select: [] as string[], hover: [] as (string | null)[], click: [] as string[] };
function setup(): DiagramController {
  host = document.createElement('div');
  document.body.append(host);
  calls.select = [];
  calls.hover = [];
  calls.click = [];
  ctl = mount(host, {
    onSelectNode: (id) => calls.select.push(id),
    onHoverEdge: (id) => calls.hover.push(id),
    onClickEdge: (id) => calls.click.push(id),
  });
  return ctl;
}
afterEach(() => {
  ctl?.destroy();
  host?.remove();
  ctl = undefined;
});
beforeAll(() => {
  // jsdom has no layout
  Element.prototype.getBoundingClientRect = () => new DOMRect(10, 20, 30, 10);
});

const hiddenNodes = (): number => host.querySelectorAll('.md-node.md-hidden').length;
const nodeEl = (name: string): Element => {
  const el = [...host.querySelectorAll('.md-node')].find(
    (n) => n.querySelector('.md-name')?.textContent === name,
  );
  if (!el) throw new Error(`no node ${name}`);
  return el;
};

/** The LinearRegression box: data boxes (DataFrames, arrays) have rows too. */
const modelBox = (): Element =>
  [...host.querySelectorAll('.md-instance')].find((g) =>
    g.getAttribute('aria-label')?.includes('LinearRegression'),
  )!;

describe('setState', () => {
  test('step 0 hides everything; stepping reveals nodes and wires in order', async () => {
    const log = linregLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, 0), log);
    const total = host.querySelectorAll('.md-node').length;
    expect(total).toBe(model.nodes.length);
    expect(hiddenNodes()).toBe(total - 0);
    expect(host.querySelectorAll('.md-edge:not(.md-hidden)').length).toBe(0);

    c.setState(stateAt(model, log, 1), log);
    expect(nodeEl('train_test_split').classList.contains('md-hidden')).toBe(false);
    expect(nodeEl('train_test_split').classList.contains('md-current')).toBe(true);
    expect(nodeEl('LinearRegression.fit').classList.contains('md-hidden')).toBe(true);

    c.setState(stateAt(model, log, model.steps.length), log);
    expect(hiddenNodes()).toBe(0);
    expect(host.querySelectorAll('.md-edge.md-hidden').length).toBe(0);
    // only the last event's box is current
    expect(host.querySelectorAll('.md-node.md-current').length).toBe(1);
    expect(nodeEl('r2_score').getAttribute('aria-current')).toBe('step');
    // an object is a box that shows its own shape; the wires out of it carry no type text
    const rowTexts = [...host.querySelectorAll('.md-attr:not(.md-hidden)')].map(
      (r) => r.textContent,
    );
    expect(rowTexts.some((t) => t?.includes('shape') && t.includes('(506, 5)'))).toBe(true);
    const labels = [...host.querySelectorAll('.md-edge-label:not(.md-hidden)')].map(
      (l) => l.textContent ?? '',
    );
    expect(labels.some((t) => t.includes('DataFrame'))).toBe(false);
  });

  test('does not re-lay-out and does not rebuild the DOM', async () => {
    const log = linregLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    const before = elkSpy.layout as unknown as ReturnType<typeof vi.fn>;
    const n = before.mock.calls.length;
    const g0 = host.querySelector('.md-node');
    const d0 = [...host.querySelectorAll('.md-wire')].map((p) => p.getAttribute('d'));
    const geom = (): string =>
      [...host.querySelectorAll('.md-box')]
        .map((r) => r.getAttribute('x') + ',' + r.getAttribute('y'))
        .join(';');
    const geom0 = geom();
    for (let s = 0; s <= model.steps.length; s++) c.setState(stateAt(model, log, s), log);
    expect(before.mock.calls.length).toBe(n);
    expect(host.querySelector('.md-node')).toBe(g0);
    expect([...host.querySelectorAll('.md-wire')].map((p) => p.getAttribute('d'))).toEqual(d0);
    expect(geom()).toBe(geom0);
    expect(host.querySelectorAll('svg').length).toBe(1);
  });

  test('setGraph after setState keeps the shown step (streamed re-layout)', async () => {
    const log = linregLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, 3), log);
    c.setGraph(model, laid);
    expect(nodeEl('LinearRegression.fit').classList.contains('md-hidden')).toBe(false);
    // method slots show from the instance's creation (drawn as plain boxes until svl-0qe styles them)
    expect(nodeEl('LinearRegression.predict').classList.contains('md-hidden')).toBe(false);
  });

  test('error, handled and stopped markers', async () => {
    const failed = linregLog({ failAt: 'fit' });
    let { model, laid } = await prepare(failed);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, failed, model.steps.length), failed);
    let fit = nodeEl('LinearRegression.fit');
    expect(fit.classList.contains('md-error')).toBe(true);
    // the message wraps in a narrow box: compare without the break
    expect(fit.querySelector('.md-msg')?.textContent?.replace(/\s/g, '')).toBe(
      '⚠ValueError:InputXcontainsNaN.',
    );
    expect(fit.getAttribute('aria-label')).toContain('ValueError');

    const handled = linregLog({ failAt: 'fit' });
    handled.events.find((e) => e.error)!.error!.handled = true;
    ({ model, laid } = await prepare(handled));
    c.setGraph(model, laid);
    c.setState(stateAt(model, handled, model.steps.length), handled);
    fit = nodeEl('LinearRegression.fit');
    expect(fit.classList.contains('md-handled')).toBe(true);
    expect(fit.classList.contains('md-error')).toBe(false);
    expect(fit.querySelector('.md-msg')?.textContent).toMatch(/^⚠ handled ValueError/);

    const stopped = linregLog({ interrupt: true });
    ({ model, laid } = await prepare(stopped));
    c.setGraph(model, laid);
    c.setState(stateAt(model, stopped, model.steps.length), stopped);
    const pred = nodeEl('LinearRegression.predict');
    expect(pred.classList.contains('md-stopped')).toBe(true);
    expect(pred.querySelector('.md-msg')?.textContent).toBe('⏹ stopped here');
  });

  test('x-n badge at the end, "k of n" while stepping', async () => {
    const log = loopLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    const badge = (): string =>
      nodeEl('SGDRegressor.partial_fit').querySelector('.md-badge-text')?.textContent ?? '';
    c.setState(stateAt(model, log, 3), log);
    expect(badge()).toBe('2 of 3');
    c.setState(stateAt(model, log, model.steps.length), log);
    expect(badge()).toBe('×3');
    expect(
      nodeEl('SGDRegressor.partial_fit')
        .querySelector('.md-badge')
        ?.classList.contains('md-hidden'),
    ).toBe(false);
  });

  test('changed attributes are bold with a bullet; others are not', async () => {
    const log = linregLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, 3), log); // the fit step
    const model_ = modelBox();
    const rows = [...model_.querySelectorAll('.md-attr:not(.md-hidden)')];
    expect(rows.map((r) => r.querySelector('.md-aname')?.textContent)).toEqual([
      'coef_',
      'intercept_',
      'n_features_in_',
    ]);
    expect(rows.every((r) => r.classList.contains('md-changed'))).toBe(true);
    expect(rows.every((r) => !r.querySelector('.md-bullet')!.classList.contains('md-hidden'))).toBe(
      true,
    );
    // the predict step does not change attributes
    c.setState(stateAt(model, log, 4), log);
    const after = [...modelBox().querySelectorAll('.md-attr:not(.md-hidden)')];
    expect(after.length).toBe(3);
    expect(after.some((r) => r.classList.contains('md-changed'))).toBe(false);
  });
});

describe('review fixes', () => {
  test('only the instance whose method is current shows changed attributes', async () => {
    const log = twoModelsLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log); // the last event is b.fit
    const insts = [...host.querySelectorAll('.md-instance')].filter((g) =>
      /Ridge|Lasso|Lars|Linear/.test(g.getAttribute('aria-label') ?? ''),
    );
    expect(insts.length).toBe(2);
    const changedPer = insts.map((g) => g.querySelectorAll('.md-attr.md-changed').length);
    expect(changedPer.sort()).toEqual([0, 1]);
    const cur = host.querySelector('.md-node.md-current')!;
    expect(cur.querySelector('.md-name')?.textContent).toBe('Ridge.fit');
    // the changed one is the instance that contains the current box
    const owner = insts.find((g) => g.querySelector('.md-attr.md-changed'))!;
    expect(owner.getAttribute('aria-label')).toContain('changed: coef_');
    const other = insts.find((g) => g !== owner)!;
    expect(other.getAttribute('aria-label')).not.toContain('changed');
  });

  test('the current expression gets a non-colour highlight hook', async () => {
    const log = splitLog();
    const { model, laid } = await prepare(log);
    const expr = model.nodes.find((n) => n.kind === 'expr');
    const c = setup();
    c.setGraph(model, laid);
    const step =
      model.steps.indexOf((expr as { executions: { i: number }[] }).executions[0]!.i) + 1;
    c.setState(stateAt(model, log, step), log);
    const g = host.querySelector(`.md-expr[data-node="${expr!.id}"]`)!;
    expect(g.classList.contains('md-current')).toBe(true);
    expect(g.getAttribute('aria-current')).toBe('step');
    expect(g.querySelector('.md-hit')).not.toBeNull();
  });

  test('setGraph clears an active hover, drops a stale state, and ids are per controller', async () => {
    const log = splitLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const edge = host.querySelector('.md-edge')!;
    edge
      .querySelector('.md-wire-hit')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    c.setGraph(model, laid);
    expect(calls.hover.at(-1)).toBeNull();
    // same model: the step is kept
    expect(host.querySelectorAll('.md-node:not(.md-hidden)').length).toBeGreaterThan(0);
    // another run: the old state is dropped, everything hidden until setState
    const other = linregLog();
    const p = await prepare(other);
    c.setGraph(p.model, p.laid);
    expect(host.querySelectorAll('.md-node:not(.md-hidden)').length).toBe(0);
    const host2 = document.createElement('div');
    document.body.append(host2);
    const c2 = mount(host2, { onSelectNode() {}, onHoverEdge() {}, onClickEdge() {} });
    c2.setGraph(p.model, p.laid);
    const id = (r: HTMLElement): string => r.querySelector('marker')!.id;
    expect(id(host2)).not.toBe(id(host));
    c2.destroy();
    host2.remove();
  });

  test('destroy clears state; setGraph afterwards is a no-op', async () => {
    const log = splitLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    c.hoverNode(model.nodes[0]!.id);
    c.destroy();
    c.setGraph(model, laid);
    expect(host.querySelector('svg')).toBeNull();
  });

  test('identical setState calls write no attributes', async () => {
    const log = linregLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    const st = stateAt(model, log, 3);
    c.setState(st, log);
    const spy = vi.spyOn(Element.prototype, 'setAttribute');
    c.setState(st, log);
    c.setState(stateAt(model, log, 3), log);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('interactions', () => {
  test('click and Enter select a box; boxes are focusable in source order', async () => {
    const log = splitLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const focusable = [...host.querySelectorAll('.md-node[tabindex="0"]')];
    const order = new Map(model.nodes.map((n) => [n.id, n.order]));
    const orders = focusable.map((e) => order.get(e.getAttribute('data-node')!)!);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    const el = nodeEl('train_test_split');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    const id = el.getAttribute('data-node')!;
    expect(calls.select).toEqual([id, id]);
  });

  test('wire hover, click, and keyboard on the label', async () => {
    const log = splitLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const edge = host.querySelector('.md-edge')!;
    const id = edge.getAttribute('data-edge')!;
    edge
      .querySelector('.md-wire-hit')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(calls.hover).toEqual([id]);
    expect(edge.classList.contains('md-hover')).toBe(true);
    edge
      .querySelector('.md-wire-hit')!
      .dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(calls.hover).toEqual([id, null]);
    expect(edge.classList.contains('md-hover')).toBe(false);
    edge.querySelector('.md-wire-hit')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const label = [...host.querySelectorAll('.md-edge-label')].find(
      (l) => l.getAttribute('data-edge') === id,
    )!;
    label.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(calls.click).toEqual([id, id]);
    label.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(calls.hover.at(-1)).toBe(id);
    label.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(calls.hover.at(-1)).toBeNull();
  });

  test('hoverNode, setSelectedNode, nodeBounds, destroy', async () => {
    const log = splitLog();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    const id = model.nodes[0]!.id;
    c.hoverNode(id);
    c.setSelectedNode(id);
    const g = host.querySelector(`[data-node="${id}"].md-node`)!;
    expect(g.classList.contains('md-hover')).toBe(true);
    expect(g.classList.contains('md-selected')).toBe(true);
    c.hoverNode(null);
    expect(g.classList.contains('md-hover')).toBe(false);
    expect(c.nodeBounds(id)).toEqual({
      x: laid.nodes[id]!.x,
      y: laid.nodes[id]!.y,
      w: laid.nodes[id]!.w,
      h: laid.nodes[id]!.h,
    });
    expect(c.nodeBounds('nope')).toBeNull();
    c.destroy();
    expect(host.querySelector('svg')).toBeNull();
  });
});

describe('legend', () => {
  test('lists every item with text, usable without colour', () => {
    const el = createLegend(document, true);
    expect(el.querySelectorAll('li').length).toBe(LEGEND_ITEMS.length);
    expect(el.textContent).toContain('⚠ Error');
    expect(el.textContent).toContain('⏹ stopped here');
    expect(el.textContent).toContain('● Changed attribute');
  });

  test('every node kind, edge kind and state style has an entry', () => {
    // Record<..., true> makes this fail to compile when the graph model gains a node kind.
    const nodeKinds: Record<GNode['kind'], true> = {
      call: true,
      instance: true,
      expr: true,
      store: true,
      source: true,
      import: true,
    };
    const covered = new Set(LEGEND_ITEMS.flatMap((i) => i.covers));
    const wanted = [
      ...Object.keys(nodeKinds),
      'edge',
      'edge-dashed',
      'port',
      'const-port',
      'current',
      'error',
      'handled',
      'stopped',
      'changed',
      'badge',
      'constructor',
      'uncalled',
      'more-methods',
      'unused-port',
      'edge-inactive',
      'data-row',
    ];
    for (const w of wanted) expect(covered, w).toContain(w);
    expect(new Set(LEGEND_ITEMS.map((i) => i.id)).size).toBe(LEGEND_ITEMS.length);
  });

  test('createLegendList has one li per item and no toggle', () => {
    const ul = createLegendList(document);
    expect(ul.tagName).toBe('UL');
    expect(ul.querySelectorAll('li').length).toBe(LEGEND_ITEMS.length);
  });
});

describe('snapshots', () => {
  const strip = (s: string): string => s.replace(/></g, '>\n<');
  test.each([
    ['split, end', () => splitLog(), 'end'],
    ['linreg, error', () => linregLog({ failAt: 'fit' }), 'end'],
    ['loop, step 2', () => loopLog(), 2],
  ] as const)('%s', async (_name, mk, at) => {
    const log = mk();
    const { model, laid } = await prepare(log);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, at === 'end' ? model.steps.length : at), log);
    expect(strip(host.innerHTML)).toMatchSnapshot();
  });
});

describe('folded temporaries', () => {
  test('a chip is a labelled button on its wire; click and Enter report the edge', async () => {
    // the real pandas-heavy fixture: unnamed one-use Series fold into chips
    const log = JSON.parse(
      readFileSync(join(__dirname, '../../../fixtures/logs/notebook.json'), 'utf8'),
    ) as EventLog;
    const { model, laid } = await prepare(log);
    const chip = model.edges.find((e) => e.chip);
    expect(chip, 'the notebook fixture folds at least one temporary').toBeDefined();
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const el = host.querySelector(`.md-edge-label.md-chip[data-edge="${chip!.id}"]`)!;
    expect(el.classList.contains('md-hidden')).toBe(false);
    expect(el.textContent).toMatch(/^\+ /);
    expect(el.getAttribute('aria-label')).toMatch(/^temporary .*press Enter/);
    expect(el.getAttribute('tabindex')).toBe('0');
    (el as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(calls.click).toEqual([chip!.id, chip!.id]);
    // plain value wires are not chips
    expect(host.querySelectorAll('.md-chip').length).toBe(model.edges.filter((e) => e.chip).length);
  });
});
