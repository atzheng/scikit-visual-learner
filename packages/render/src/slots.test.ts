// @vitest-environment jsdom
// Method slots, the constructor box, "more methods", shared method boxes and ports of the active execution,
// on the real fixture logs (fixtures/logs) so the graph is what the recorder produces.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import ELKBundled from 'elkjs/lib/elk.bundled.js';
import type { ELK } from 'elkjs/lib/elk-api';
import { buildGraph, stateAt } from '@machines/log';
import type { CallNode, EventLog, GraphModel, InstanceNode } from '@machines/log';
import { layout } from './layout';
import type { Laid } from './layout';
import { mount } from './mount';
import type { DiagramController } from './mount';
import {
  attrDocTarget,
  attrRowsFor,
  hiddenMethods,
  moreMethodsFor,
  nodeDocTarget,
  portViews,
} from './svg';
import type { MethodDocTarget } from './svg';

const measure = (t: string): number => t.length * 7;
const elk = new ELKBundled() as unknown as ELK;

const loadLog = (name: string): EventLog =>
  JSON.parse(
    readFileSync(resolve(process.cwd(), '../../fixtures/logs', `${name}.json`), 'utf8'),
  ) as EventLog;

async function prepare(
  name: string,
  withMore = true,
): Promise<{ log: EventLog; model: GraphModel; laid: Laid }> {
  const log = loadLog(name);
  const model = buildGraph(log, { expanded: new Set() });
  const laid = await layout(model, {
    measure,
    elk,
    attrRows: attrRowsFor(model, log),
    moreMethods: withMore ? moreMethodsFor(model, log) : undefined,
  });
  return { log, model, laid };
}

let host: HTMLElement;
let ctl: DiagramController | undefined;
let docs: { target: MethodDocTarget; node: string }[] = [];
function setup(withDocs = true): DiagramController {
  host = document.createElement('div');
  document.body.append(host);
  docs = [];
  ctl = mount(host, {
    onSelectNode: () => {},
    onHoverEdge: () => {},
    onClickEdge: () => {},
    ...(withDocs ? { onOpenDocs: (target, node) => docs.push({ target, node }) } : {}),
  });
  return ctl;
}
afterEach(() => {
  ctl?.destroy();
  host?.remove();
  ctl = undefined;
});
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () => new DOMRect(10, 20, 30, 10);
});

const stepOf = (model: GraphModel, log: EventLog, name: string, nth = 0): number => {
  const hits = log.events.filter((e) => e.name === name);
  const i = hits[nth]!.i;
  return model.steps.indexOf(i) + 1;
};
const callNode = (model: GraphModel, name: string): CallNode =>
  model.nodes.find((n): n is CallNode => n.kind === 'call' && n.name === name)!;
const el = (id: string): Element => host.querySelector(`[data-node="${id}"].md-node`)!;
const instOf = (model: GraphModel, cls: string): InstanceNode =>
  model.nodes.find((n): n is InstanceNode => n.kind === 'instance' && n.className === cls)!;

describe('uncalled method slots', () => {
  test('dashed style class and "not called yet" until the first call, then solid', async () => {
    const { log, model, laid } = await prepare('golden_linreg');
    const c = setup();
    c.setGraph(model, laid);
    const [fit, predict, score] = ['fit', 'predict', 'score'].map(
      (m) => callNode(model, `LinearRegression.${m}`).id,
    ) as [string, string, string];

    c.setState(stateAt(model, log, stepOf(model, log, 'LinearRegression')), log);
    for (const id of [fit, predict, score]) {
      expect(el(id).classList.contains('md-hidden'), id).toBe(false);
      expect(el(id).classList.contains('md-uncalled'), id).toBe(true);
      expect(el(id).getAttribute('aria-label')).toContain('not called yet');
    }

    c.setState(stateAt(model, log, stepOf(model, log, 'LinearRegression.fit')), log);
    expect(el(fit).classList.contains('md-uncalled')).toBe(false);
    expect(el(fit).getAttribute('aria-label')).not.toContain('not called yet');
    expect(el(predict).classList.contains('md-uncalled')).toBe(true);
    expect(el(score).classList.contains('md-uncalled')).toBe(true);

    c.setState(stateAt(model, log, model.steps.length), log);
    for (const id of [fit, predict, score])
      expect(el(id).classList.contains('md-uncalled')).toBe(false);
  });
});

describe('method on a temporary', () => {
  test('an unparented method call is labelled as a method, not a function', async () => {
    const { model, laid } = await prepare('golden_linreg');
    const c = setup();
    c.setGraph(model, laid);
    const dropna = callNode(model, 'DataFrame.dropna');
    expect(dropna.parent).toBeNull();
    expect(el(dropna.id).getAttribute('aria-label')).toMatch(/^method DataFrame.dropna/);
    expect(el(dropna.id).textContent).toContain('DataFrame.dropna');
  });
});

describe('constructor box', () => {
  test('is an ordinary function box (svl-1x4) and its wire into the instance shows at its step', async () => {
    const { log, model, laid } = await prepare('golden_linreg');
    const c = setup();
    c.setGraph(model, laid);
    const ctor = callNode(model, 'LinearRegression');
    const inst = instOf(model, 'LinearRegression');
    expect(el(ctor.id).getAttribute('aria-label')).toContain('function LinearRegression');
    expect(el(ctor.id).classList.contains('md-ctor')).toBe(false);
    // the call box shows (module); the import block is its own box with no wires (svl-i6s)
    expect(el(ctor.id).textContent).toContain('(sklearn.linear_model)');
    expect(host.querySelector('.md-callee')).toBeNull();
    const imp = model.nodes.find((n) => n.kind === 'import' && n.name === 'LinearRegression')!;
    expect(el(imp.id).textContent).toBe('LinearRegression (sklearn.linear_model)');
    expect(el(imp.id).getAttribute('aria-label')).toBe(
      'import LinearRegression from sklearn.linear_model',
    );
    expect(model.edges.some((e) => e.from.node === imp.id || e.to.node === imp.id)).toBe(false);
    c.setState(stateAt(model, log, 0), log);
    expect(el(imp.id).classList.contains('md-hidden')).toBe(true);
    // above the instance
    expect(laid.nodes[ctor.id]!.y + laid.nodes[ctor.id]!.h).toBeLessThanOrEqual(
      laid.nodes[inst.id]!.y,
    );
    const edge = model.edges.find((e) => e.from.node === ctor.id && e.to.node === inst.id)!;
    c.setState(stateAt(model, log, stepOf(model, log, 'LinearRegression')), log);
    expect(
      host.querySelector(`[data-edge="${edge.id}"].md-edge`)!.classList.contains('md-hidden'),
    ).toBe(false);
  });
});

describe('more methods', () => {
  test('only machines get the control; the count is the class methods minus the drawn boxes', async () => {
    const { log, model, laid } = await prepare('golden_linreg');
    const inst = instOf(model, 'LinearRegression');
    const hidden = hiddenMethods(model, log, inst).map((m) => m.name);
    expect(hidden).not.toContain('fit');
    expect(hidden).not.toContain('predict');
    expect(hidden).toContain('get_params');
    expect(moreMethodsFor(model, log)).toEqual({ [inst.id]: hidden.length });
    expect(laid.nodes[inst.id]!.moreN).toBe(hidden.length);
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const ctls = host.querySelectorAll('.md-more-ctl');
    expect(ctls).toHaveLength(1);
    expect(ctls[0]!.textContent).toContain(`more methods (${hidden.length})`);
    expect(ctls[0]!.getAttribute('aria-expanded')).toBe('false');
  });

  test('the layout reserves a control row', async () => {
    const a = await prepare('golden_linreg', false);
    const b = await prepare('golden_linreg', true);
    const inst = instOf(a.model, 'LinearRegression').id;
    expect(b.laid.nodes[inst]!.h).toBeGreaterThan(a.laid.nodes[inst]!.h);
    expect(a.laid.nodes[inst]!.moreN).toBeUndefined();
  });

  test('mouse: click toggles the list; each entry carries the docs target', async () => {
    const { log, model, laid } = await prepare('golden_linreg');
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const inst = instOf(model, 'LinearRegression');
    const n = hiddenMethods(model, log, inst).length;
    const ctlEl = host.querySelector('.md-more-ctl') as SVGElement;
    expect(host.querySelectorAll('.md-more-item')).toHaveLength(0);
    ctlEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ctlEl.getAttribute('aria-expanded')).toBe('true');
    const items = [...host.querySelectorAll('.md-more-item')];
    expect(items).toHaveLength(n);
    const gp = items.find((i) => i.getAttribute('data-doc-method') === 'get_params')!;
    expect(gp.getAttribute('data-doc-name')).toBe('LinearRegression.get_params');
    expect(gp.getAttribute('data-doc-module')).toBe(callNode(model, 'LinearRegression').module);
    expect(gp.getAttribute('role')).toBe('button');
    expect(gp.textContent).toContain('Get parameters');
    gp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(docs).toEqual([
      {
        target: {
          module: callNode(model, 'LinearRegression').module,
          name: 'LinearRegression.get_params',
        },
        node: inst.id,
      },
    ]);
    ctlEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.querySelectorAll('.md-more-item')).toHaveLength(0);
    expect(host.querySelector('.md-more-ctl')!.getAttribute('aria-expanded')).toBe('false');
  });

  test('keyboard: Enter and Space open it, Enter on an entry opens docs, Escape closes and refocuses', async () => {
    const { log, model, laid } = await prepare('golden_linreg');
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const key = (t: Element, k: string): void => {
      t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    };
    let ctlEl = host.querySelector('.md-more-ctl')!;
    expect(ctlEl.getAttribute('tabindex')).toBe('0');
    expect(ctlEl.getAttribute('role')).toBe('button');
    key(ctlEl, 'Enter');
    ctlEl = host.querySelector('.md-more-ctl')!;
    expect(ctlEl.getAttribute('aria-expanded')).toBe('true');
    key(ctlEl, ' ');
    expect(host.querySelector('.md-more-ctl')!.getAttribute('aria-expanded')).toBe('false');
    key(host.querySelector('.md-more-ctl')!, 'Enter');
    const item = host.querySelector('.md-more-item')!;
    expect(item.getAttribute('tabindex')).toBe('0');
    key(item, 'Enter');
    expect(docs).toHaveLength(1);
    key(item, 'Escape');
    expect(host.querySelector('.md-more-ctl')!.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelectorAll('.md-more-item')).toHaveLength(0);
  });

  test('without a docs handler the entries are plain list items', async () => {
    const { log, model, laid } = await prepare('golden_linreg');
    const c = setup(false);
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    c.toggleMethods(instOf(model, 'LinearRegression').id, true);
    const item = host.querySelector('.md-more-item')!;
    expect(item.getAttribute('role')).toBe('listitem');
    expect(item.hasAttribute('tabindex')).toBe(false);
  });

  test('stays open across a re-layout of the same graph', async () => {
    const { log, model, laid } = await prepare('golden_linreg');
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    c.toggleMethods(instOf(model, 'LinearRegression').id);
    c.setGraph(model, laid);
    expect(host.querySelectorAll('.md-more-item').length).toBeGreaterThan(0);
  });

  test('data boxes (DataFrame) get no list: their methods are a capped alphabetical slice', async () => {
    const { log, model } = await prepare('golden_split');
    const df = model.nodes.find(
      (n): n is InstanceNode => n.kind === 'instance' && n.className === 'DF',
    )!;
    // even if the class carried a methods list, a non-machine has none shown
    const withMethods: EventLog = {
      ...log,
      values: { ...log.values, 'v999.0': { type: 'DF', methods: [{ name: 'abs', doc: '' }] } },
    };
    expect(hiddenMethods(model, withMethods, df)).toEqual([]);
    expect(moreMethodsFor(model, withMethods)).toEqual({});
  });
});

describe('shared method boxes (golden_onehot)', () => {
  test("only the running execution's wires are drawn; the other call's wire is faint and unlabelled", async () => {
    const { log, model, laid } = await prepare('golden_onehot');
    const c = setup();
    c.setGraph(model, laid);
    const transform = callNode(model, 'OneHotEncoder.transform');
    const intoX = model.edges.filter((e) => e.to.node === transform.id && e.to.port === 'in:X');
    expect(intoX).toHaveLength(2); // X_train and X_test both wire into the one transform box
    const inactive = (id: string): boolean =>
      host.querySelector(`[data-edge="${id}"].md-edge`)!.classList.contains('md-inactive');
    const hidden = (id: string): boolean =>
      host.querySelector(`[data-edge="${id}"].md-edge`)!.classList.contains('md-hidden');

    const first = stepOf(model, log, 'OneHotEncoder.transform', 0);
    const second = stepOf(model, log, 'OneHotEncoder.transform', 1);
    // at the first transform only the X_train wire exists yet
    c.setState(stateAt(model, log, first), log);
    const trainEdge = intoX.find((e) =>
      e.uses.some(
        (u) => u.i === log.events.filter((x) => x.name === 'OneHotEncoder.transform')[0]!.i,
      ),
    )!;
    const testEdge = intoX.find((e) => e !== trainEdge)!;
    expect(hidden(trainEdge.id)).toBe(false);
    expect(inactive(trainEdge.id)).toBe(false);
    expect(hidden(testEdge.id)).toBe(true);

    // at the second transform both are visible, but only the X_test wire is the running one
    c.setState(stateAt(model, log, second), log);
    expect(hidden(trainEdge.id)).toBe(false);
    expect(inactive(trainEdge.id)).toBe(true);
    expect(inactive(testEdge.id)).toBe(false);
    const labelOf = (id: string): Element =>
      host.querySelector(`.md-edge-label[data-edge="${id}"]`)!;
    expect(labelOf(trainEdge.id).classList.contains('md-hidden')).toBe(true);
  });

  test('the out-port name follows the active execution (train_enc, then test_enc)', async () => {
    const { log, model, laid } = await prepare('golden_onehot');
    const c = setup();
    c.setGraph(model, laid);
    const transform = callNode(model, 'OneHotEncoder.transform');
    const outName = (): string =>
      el(transform.id).querySelector('[data-port="out:0"] .md-pname')!.textContent ?? '';
    c.setState(stateAt(model, log, stepOf(model, log, 'OneHotEncoder.transform', 0)), log);
    expect(outName()).toBe('train_enc');
    c.setState(stateAt(model, log, stepOf(model, log, 'OneHotEncoder.transform', 1)), log);
    expect(outName()).toBe('test_enc');
  });
});

describe('ports of the active execution', () => {
  test('const text comes from the execution, and a port it did not use is dimmed', async () => {
    const log = loadLog('edge_loop');
    const model = buildGraph(log, { expanded: new Set() });
    const ridge = callNode(model, 'Ridge');
    const execs = ridge.executions;
    expect(execs.length).toBeGreaterThan(1);
    // a constant input: the text comes from the execution's own event, not from the node's latest
    const lg = loadLog('golden_linreg');
    const gm = buildGraph(lg, { expanded: new Set() });
    const sp = callNode(gm, 'train_test_split');
    expect(sp.inPorts.find((p) => p.id === 'in:test_size')!.constText).toBe('test_size = 0.2');
    const ev = lg.events.find((e) => e.i === sp.executions[0]!.i)!;
    ev.inputs.find((x) => x.param === 'test_size')!.text = '0.35';
    expect(portViews(gm, sp, sp.executions[0]!, lg).in['in:test_size']!.constText).toBe(
      'test_size = 0.35',
    );
    // a node with a port the execution lacks: fake an execution without the input
    const ex = { ...execs[0]!, inputs: {} };
    const noOut = { ...ex, outputs: {} };
    const v = portViews(model, ridge, noOut, log);
    expect(v.out['out:0']!.used).toBe(false);
    // without an execution (an uncalled box) everything counts as used
    const stat = portViews(model, ridge, undefined, log);
    expect(Object.values(stat.in).every((p) => p.used)).toBe(true);
    expect(Object.values(stat.out).every((p) => p.used)).toBe(true);
  });

  test('a wired input the execution lacks is marked unused', async () => {
    const log = loadLog('golden_onehot');
    const model = buildGraph(log, { expanded: new Set() });
    const fit = callNode(model, 'OneHotEncoder.fit');
    const ex = { ...fit.executions[0]!, inputs: {} };
    const v = portViews(model, fit, ex, log);
    expect(v.in['in:X']!.used).toBe(false);
    const real = portViews(model, fit, fit.executions[0]!, log);
    expect(real.in['in:X']!.used).toBe(true);
  });
});

describe('changed attributes in a loop (edge_loop)', () => {
  test('only the fit marks attributes; the constructor of a later pass shows the new object', async () => {
    const { log, model, laid } = await prepare('edge_loop');
    const c = setup();
    c.setGraph(model, laid);
    const ridge = instOf(model, 'Ridge');
    const changed = (): string[] =>
      [...el(ridge.id).querySelectorAll('.md-attr.md-changed:not(.md-hidden) .md-aname')].map(
        (e) => e.textContent ?? '',
      );
    const names = (): string[] =>
      [...el(ridge.id).querySelectorAll('.md-attr:not(.md-hidden) .md-aname')].map(
        (e) => e.textContent ?? '',
      );

    c.setState(stateAt(model, log, stepOf(model, log, 'Ridge.fit', 0)), log);
    expect(changed()).toContain('coef_');
    expect(changed()).not.toContain('copy_X');
    expect(changed()).not.toContain('tol');
    expect(names()).toContain('coef_');

    // second pass: the new Ridge is not fitted yet. Nothing is marked and the fitted attributes of the
    // previous pass are not shown on it.
    c.setState(stateAt(model, log, stepOf(model, log, 'Ridge', 1)), log);
    expect(changed()).toEqual([]);
    expect(names()).not.toContain('coef_');

    c.setState(stateAt(model, log, stepOf(model, log, 'Ridge.fit', 1)), log);
    expect(changed()).toContain('coef_');
    expect(changed()).not.toContain('copy_X');
  });
});

describe('data box rows', () => {
  test('shape and columns rows are styled as data rows', async () => {
    const { log, model, laid } = await prepare('golden_split');
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const rows = [...host.querySelectorAll('.md-attr.md-data:not(.md-hidden)')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.textContent?.includes('shape'))).toBe(true);
  });

  test('a data box that holds a method box is as tall as its content needs (no empty band)', async () => {
    const { model, laid } = await prepare('golden_split');
    const df = model.nodes.find(
      (n): n is InstanceNode => n.kind === 'instance' && model.nodes.some((k) => k.parent === n.id),
    )!;
    const kid = model.nodes.find((k) => k.parent === df.id)!;
    const box = laid.nodes[df.id]!;
    const k = laid.nodes[kid.id]!;
    // below the child: its padding plus the room ELK keeps for the wire leaving through the border
    expect(box.y + box.h - (k.y + k.h)).toBeLessThanOrEqual(40);
    // the box is not narrower than its title and rows
    expect(box.w).toBeGreaterThanOrEqual(k.w);
  });
});

describe('docs on boxes (svl-3ms)', () => {
  test('the "?" button and "?" on the focused box open the docs of method, constructor and instance boxes', async () => {
    const { log, model, laid } = await prepare('golden_linreg');
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const fit = callNode(model, 'LinearRegression.fit');
    const ctor = callNode(model, 'LinearRegression');
    const inst = instOf(model, 'LinearRegression');
    (el(fit.id).querySelector('.md-docs-btn') as Element).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(docs.at(-1)).toEqual({
      target: { module: fit.module, name: 'LinearRegression.fit' },
      node: fit.id,
    });
    for (const n of [ctor, inst]) {
      el(n.id).dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    }
    expect(docs.slice(-2).map((d) => [d.target.name, d.node])).toEqual([
      ['LinearRegression', ctor.id],
      ['LinearRegression', inst.id],
    ]);
    expect(docs.at(-1)!.target.module).toBe(ctor.module);
    expect(el(fit.id).getAttribute('aria-keyshortcuts')).toBe('?');
  });

  test('without a handler there is no button and "?" does nothing', async () => {
    const { model, laid } = await prepare('golden_linreg');
    const c = setup(false);
    c.setGraph(model, laid);
    const fit = callNode(model, 'LinearRegression.fit');
    expect(host.querySelector('.md-docs-btn')).toBeNull();
    el(fit.id).dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    expect(docs).toEqual([]);
  });
});

describe('attribute docs (svl-3du)', () => {
  test('data boxes map their summary type to the real class (svl-8e9)', async () => {
    const { model } = await prepare('golden_linreg');
    const arr = instOf(model, 'array');
    expect(attrDocTarget(model, arr, 'shape')).toEqual({
      module: 'numpy',
      name: 'ndarray.shape',
      attr: true,
    });
    expect(attrDocTarget(model, arr, 'dtype').name).toBe('ndarray.dtype');
    expect(nodeDocTarget(model, arr)).toEqual({ module: 'numpy', name: 'ndarray' });
    const fake = { ...arr, className: 'DF' } as InstanceNode;
    expect(attrDocTarget(model, fake, 'shape')).toEqual({
      module: 'pandas',
      name: 'DataFrame.shape',
      attr: true,
    });
    expect(attrDocTarget(model, { ...arr, className: 'Series' }, 'dtype').name).toBe(
      'Series.dtype',
    );
    expect(attrDocTarget(model, { ...arr, className: 'sparse' }, 'nnz')).toEqual({
      module: 'scipy.sparse',
      name: 'spmatrix.nnz',
      attr: true,
    });
  });

  test('an attribute-read box documents that attribute of its owner class', async () => {
    const { log, model, laid } = await prepare('edge_expr');
    const read = model.nodes.find((n) => n.kind === 'expr' && n.text === 'model.coef_')!;
    const inst = instOf(model, 'LinearRegression');
    expect(nodeDocTarget(model, read)).toEqual({
      module: 'sklearn.linear_model._base',
      name: 'LinearRegression.coef_',
      attr: true,
    });
    expect(attrDocTarget(model, inst, 'alpha')).toEqual({
      module: 'sklearn.linear_model._base',
      name: 'LinearRegression.alpha',
      attr: true,
    });
    const other = model.nodes.find((n) => n.kind === 'expr' && n.text === 'X_train - mean')!;
    expect(nodeDocTarget(model, other)).toBeNull();
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    expect(host.querySelector(`[data-docs-btn="${read.id}"]`)).not.toBeNull();
    el(read.id).dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    expect(docs).toEqual([
      {
        target: {
          module: 'sklearn.linear_model._base',
          name: 'LinearRegression.coef_',
          attr: true,
        },
        node: read.id,
      },
    ]);
  });

  test('instance rows: the button and a focused row open the attribute docs; a row click does not', async () => {
    const { log, model, laid } = await prepare('edge_expr');
    const c = setup();
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    const inst = instOf(model, 'LinearRegression');
    const rows = [...host.querySelectorAll('.md-attr[data-doc-attr]')].filter(
      (r) => !r.classList.contains('md-hidden'),
    );
    const coef = rows.find((r) => r.getAttribute('data-doc-name') === 'LinearRegression.coef_')!;
    expect(coef).toBeDefined();
    expect(coef.getAttribute('tabindex')).toBe('0');
    expect(coef.getAttribute('data-doc-node')).toBe(inst.id);
    coef.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(docs).toEqual([]);
    coef.querySelector('.md-docs-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    coef.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
    coef.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    const want = {
      target: { module: 'sklearn.linear_model._base', name: 'LinearRegression.coef_', attr: true },
      node: inst.id,
    };
    expect(docs).toEqual([want, want, want]);
  });

  test('without a docs handler rows have no button and are not focusable', async () => {
    const { log, model, laid } = await prepare('edge_expr');
    const c = setup(false);
    c.setGraph(model, laid);
    c.setState(stateAt(model, log, model.steps.length), log);
    expect(host.querySelector('.md-attr .md-docs-btn')).toBeNull();
    expect(host.querySelector('.md-attr[tabindex]')).toBeNull();
  });
});
