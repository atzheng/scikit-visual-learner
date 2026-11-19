import { describe, expect, test } from 'vitest';
import { buildGraph } from './graph';
import type { CallNode, ExprNode, GraphModel, InstanceNode, SourceNode } from './graph';
import type { Event, EventLog, Input, Site, ValueSummary } from './types';
import { validateLog } from './validate';

// ---- tiny builder for hand-written logs
class B {
  sites: Site[] = [];
  events: Event[] = [];
  values: Record<string, ValueSummary> = {};
  bindings: [number, string, string][] = [];
  n = 0;

  site(text: string, line: number, extra: Partial<Site> = {}): number {
    const id = this.sites.length;
    this.sites.push({
      id,
      kind: 'call',
      line,
      col: 0,
      end_line: line,
      end_col: text.length,
      text,
      func_text: text.split('(')[0],
      ...extra,
    });
    return id;
  }
  val(token: string, type: string, extra: Partial<ValueSummary> = {}): string {
    this.values[token] = { type, ...extra };
    return token;
  }
  ev(site: number, kind: Event['kind'], name: string, extra: Partial<Event> = {}): Event {
    const i = this.n++;
    const e: Event = {
      i,
      ret: i,
      site,
      scope: 0,
      kind,
      name,
      module: kind === 'expr' || kind === 'store' ? null : 'lib',
      owner: null,
      inputs: [],
      outputs: [],
      returns_self: false,
      mutates: [],
      count: 1,
      merge_key: `s${site}`,
      error: null,
      ...extra,
    };
    this.events.push(e);
    return e;
  }
  bind(name: string, token: string): void {
    this.bindings.push([this.n - 1, name, token]);
  }
  log(extra: Partial<EventLog> = {}): EventLog {
    const log: EventLog = {
      version: 2,
      status: 'ok',
      error: null,
      sites: this.sites,
      scopes: [
        {
          id: 0,
          name: '<module>',
          parent_event: null,
          lexical_parent: null,
          bindings: this.bindings,
        },
      ],
      values: this.values,
      events: this.events,
      output: [],
      diagnostics: [],
      ...extra,
    };
    return validateLog(JSON.parse(JSON.stringify(log)));
  }
}
const wired = (param: string, value: string, origin: Input['origin'] = 'name'): Input => ({
  param,
  origin,
  value,
});
const konst = (param: string, text: string): Input => ({ param, origin: 'const', text });

const build = (log: EventLog): GraphModel => buildGraph(log, { expanded: new Set() });
type Many<T> = [T, T, T, T, ...T[]];
const calls = (m: GraphModel): Many<CallNode> =>
  m.nodes.filter((n): n is CallNode => n.kind === 'call') as Many<CallNode>;
const insts = (m: GraphModel): Many<InstanceNode> =>
  m.nodes.filter((n): n is InstanceNode => n.kind === 'instance') as Many<InstanceNode>;
const byName = (m: GraphModel, name: string): CallNode => {
  const c = calls(m).find((n) => n.name === name);
  if (!c) throw new Error(`no call ${name}`);
  return c;
};
const edgeInto = (m: GraphModel, node: string, port: string | null) =>
  m.edges.filter((e) => e.to.node === node && e.to.port === port);

/** df = pd.read_csv(); X_train, X_test = split(df, test_size=0.2) */
function splitLog(): EventLog {
  const b = new B();
  const s0 = b.site('pd.read_csv("a.csv")', 1);
  const s1 = b.site('train_test_split(df, test_size=0.2)', 2, { unpack: 2 });
  b.val('v1.0', 'DF', { shape: [10, 3] });
  b.ev(s0, 'function', 'read_csv', { inputs: [konst('filepath', '"a.csv"')], outputs: ['v1.0'] });
  b.bind('df', 'v1.0');
  b.val('v2.0', 'DF');
  b.val('v3.0', 'DF');
  b.ev(s1, 'function', 'train_test_split', {
    inputs: [wired('arrays[0]', 'v1.0'), konst('test_size', '0.2')],
    outputs: ['v2.0', 'v3.0'],
  });
  b.bind('X_train', 'v2.0');
  b.bind('X_test', 'v3.0');
  return b.log();
}

describe('function events', () => {
  test('call node with ports, const text, labels', () => {
    const m = build(splitLog());
    const [read, split] = calls(m);
    expect(read.name).toBe('read_csv');
    expect(read.inPorts).toEqual([
      {
        id: 'in:filepath',
        param: 'filepath',
        typeLabel: '',
        nameLabel: null,
        constText: 'filepath = "a.csv"',
      },
    ]);
    // an object's box shows its type and shape: its ports keep only the name
    expect(read.outPorts).toEqual([{ id: 'out:0', param: '0', typeLabel: '', nameLabel: 'df' }]);
    expect(split.inPorts.map((p) => [p.id, p.typeLabel, p.constText])).toEqual([
      ['in:arrays[0]', '', undefined],
      ['in:test_size', '', 'test_size = 0.2'],
    ]);
    expect(split.outPorts.map((p) => p.nameLabel)).toEqual(['X_train', 'X_test']);
    expect(split.executions[0]).toMatchObject({
      i: 1,
      inputs: { 'in:arrays[0]': 'v1.0' },
      outputs: { 'out:0': 'v2.0', 'out:1': 'v3.0' },
    });
    // read_csv -> df box -> split; the split's two outputs are two boxes
    const [df, xTrain, xTest] = insts(m);
    expect(insts(m).map((b) => [b.varName, b.className, b.createdBy])).toEqual([
      ['df', 'DF', read.id],
      ['X_train', 'DF', split.id],
      ['X_test', 'DF', split.id],
    ]);
    const wires = m.edges.map((e) => [e.from, e.to, e.nameLabel, e.dashed]);
    expect(wires).toHaveLength(4);
    expect(wires).toEqual(
      expect.arrayContaining([
        [{ node: read.id, port: 'out:0' }, { node: df.id, port: null }, null, false],
        [{ node: df.id, port: null }, { node: split.id, port: 'in:arrays[0]' }, null, false],
        [{ node: split.id, port: 'out:0' }, { node: xTrain.id, port: null }, null, false],
        [{ node: split.id, port: 'out:1' }, { node: xTest.id, port: null }, null, false],
      ]),
    );
    expect(edgeInto(m, split.id, 'in:arrays[0]')[0]!.uses).toEqual([{ i: 1, token: 'v1.0' }]);
    expect(m.steps).toEqual([0, 1]);
    expect(read.order).toBeLessThan(split.order);
  });

  test('label input is drawn on the port, not wired', () => {
    const b = new B();
    const s = b.site('FunctionTransformer(np.log1p)', 1);
    b.ev(s, 'function', 'apply', {
      inputs: [{ param: 'func', origin: 'name', text: 'np.log1p' }],
      outputs: ['v1.0'],
    });
    b.val('v1.0', 'DF');
    const m = build(b.log());
    expect(calls(m)[0]!.inPorts[0]!.constText).toBe('func = np.log1p');
    // nothing is wired into the call; its result is a box
    expect(m.edges.map((e) => e.to.port)).toEqual([null]);
  });
});

describe('instances and methods', () => {
  function scalerLog(): EventLog {
    const b = new B();
    const sTrain = b.site('X_train = pd.DataFrame(a)', 1);
    const sTest = b.site('X_test = pd.DataFrame(b)', 2);
    const sCtor = b.site('scaler = StandardScaler(with_std=True)', 3);
    const sFit = b.site('scaler.fit(X_train)', 4);
    const sT1 = b.site('scaler.transform(X_train)', 5);
    const sT2 = b.site('scaler.transform(X_test)', 6);
    b.val('v1.0', 'DF');
    b.ev(sTrain, 'constructor', 'DataFrame', { outputs: ['v1.0'] });
    b.bind('X_train', 'v1.0');
    b.val('v2.0', 'DF');
    b.ev(sTest, 'constructor', 'DataFrame', { outputs: ['v2.0'] });
    b.bind('X_test', 'v2.0');
    b.val('v3.0', 'StandardScaler', { machine: true });
    b.ev(sCtor, 'constructor', 'StandardScaler', {
      inputs: [konst('with_std', 'True')],
      outputs: ['v3.0'],
    });
    b.bind('scaler', 'v3.0');
    b.val('v3.1', 'StandardScaler', { machine: true });
    b.ev(sFit, 'method', 'StandardScaler.fit', {
      owner: 'v3.0',
      inputs: [wired('X', 'v1.0')],
      returns_self: true,
      mutates: [['v3.0', 'v3.1']],
    });
    b.val('v4.0', 'array');
    b.ev(sT1, 'method', 'StandardScaler.transform', {
      owner: 'v3.1',
      inputs: [wired('X', 'v1.0')],
      outputs: ['v4.0'],
    });
    b.val('v5.0', 'array');
    b.ev(sT2, 'method', 'StandardScaler.transform', {
      owner: 'v3.1',
      inputs: [wired('X', 'v2.0')],
      outputs: ['v5.0'],
    });
    return b.log();
  }

  test('constructor -> instance with params; methods are one box per site, owner not a port', () => {
    const m = build(scalerLog());
    const inst = insts(m).find((x) => x.className === 'StandardScaler')!;
    // every object is a box: two DataFrames, the scaler and the two transform results
    expect(insts(m).map((x) => x.className)).toEqual([
      'DF',
      'DF',
      'StandardScaler',
      'array',
      'array',
    ]);
    expect(inst).toMatchObject({
      className: 'StandardScaler',
      varName: 'scaler',
      createdAt: 2,
      createdBy: calls(m).find((c) => c.name === 'StandardScaler')!.id,
      params: [{ name: 'with_std', text: 'True' }],
    });
    expect(inst.versions).toEqual([
      { i: 2, token: 'v3.0' },
      { i: 3, token: 'v3.1' },
    ]);
    const methods = calls(m).filter((c) => c.parent === inst.id);
    expect(methods.map((c) => c.name)).toEqual(['StandardScaler.fit', 'StandardScaler.transform']);
    expect(methods[1]!.executions.map((x) => x.count)).toEqual([1, 2]);
    expect(new Set(methods.map((c) => c.id)).size).toBe(2);
    for (const c of methods) expect(c.inPorts.map((p) => p.param)).toEqual(['X']);
    const fit = methods[0]!;
    expect(fit.outPorts).toEqual([]); // returns_self, machine mutates: no out-port
    // DataFrame constructors are plain call nodes
    expect(
      calls(m)
        .filter((c) => c.parent === null)
        .map((c) => c.name),
    ).toEqual(['DataFrame', 'DataFrame', 'StandardScaler']);
    // the constructor is a call box whose output wire creates the instance; its args are ports
    const ctor = calls(m).find((c) => c.name === 'StandardScaler')!;
    expect(ctor.inPorts.map((p) => p.constText)).toEqual(['with_std = True']);
    expect(edgeInto(m, inst.id, null).map((e) => [e.from.node, e.from.port])).toEqual([
      [ctor.id, 'out:0'],
    ]);
    // the two transform executions each create their own result box, from the shared transform box
    const outs = insts(m).filter((x) => x.className === 'array');
    expect(outs.map((x) => x.createdBy)).toEqual([methods[1]!.id, methods[1]!.id]);
    // X_train feeds fit and the first transform: wired from its own box, never from the constructor
    const xTrain = insts(m)[0]!;
    expect(edgeInto(m, methods[0]!.id, 'in:X').map((e) => e.from.node)).toEqual([xTrain.id]);
  });

  test('machine passed as argument is an edge from the instance border', () => {
    const b = new B();
    const sC = b.site('model = Ridge()', 1);
    const sX = b.site('cross_val_score(model, X)', 2);
    b.val('v1.0', 'Ridge', { machine: true });
    b.ev(sC, 'constructor', 'Ridge', { outputs: ['v1.0'] });
    b.val('s1', 'float');
    b.val('v9.0', 'DF');
    b.ev(sX, 'function', 'cross_val_score', {
      inputs: [wired('estimator', 'v1.0'), wired('X', 'v9.0')],
      outputs: ['s1'],
    });
    const m = build(b.log());
    const inst = insts(m)[0];
    const cvs = byName(m, 'cross_val_score');
    expect(edgeInto(m, cvs.id, 'in:estimator')[0]!.from).toEqual({ node: inst.id, port: null });
    expect(cvs.inPorts[0]!.typeLabel).toBe(''); // the box shows the type
    // the other argument is an object with no producing event: a lazy box, not a source
    expect(edgeInto(m, cvs.id, 'in:X')[0]!.from.node).toBe(insts(m)[1]!.id);
  });

  test('function returning a machine: function node + instance with createdBy', () => {
    const b = new B();
    const sC = b.site('sc = StandardScaler()', 1);
    const sP = b.site('pipe = make_pipeline(sc, Ridge())', 2);
    b.val('v1.0', 'StandardScaler', { machine: true });
    b.ev(sC, 'constructor', 'StandardScaler', { outputs: ['v1.0'] });
    b.bind('sc', 'v1.0');
    b.val('v2.0', 'Pipeline', { machine: true });
    b.ev(sP, 'function', 'make_pipeline', {
      inputs: [wired('steps[0]', 'v1.0')],
      outputs: ['v2.0'],
    });
    b.bind('pipe', 'v2.0');
    const m = build(b.log());
    const fn = byName(m, 'make_pipeline');
    const [scaler, pipe] = insts(m);
    expect(fn.name).toBe('make_pipeline');
    expect(pipe).toMatchObject({
      className: 'Pipeline',
      varName: 'pipe',
      createdBy: fn.id,
      createdAt: 1,
    });
    expect(edgeInto(m, fn.id, 'in:steps[0]')[0]!.from).toEqual({ node: scaler.id, port: null });
    expect(edgeInto(m, pipe.id, null)[0]!.from).toEqual({ node: fn.id, port: 'out:0' });
  });

  test('a method on data sits in its box; in-place mutation is a new version of the box, not an out-port', () => {
    const b = new B();
    const s0 = b.site('df = load()', 1);
    const s1 = b.site('df.dropna(inplace=True)', 2);
    b.val('v1.0', 'DF');
    b.ev(s0, 'function', 'load', { outputs: ['v1.0'] });
    b.bind('df', 'v1.0');
    b.val('v1.1', 'DF');
    b.ev(s1, 'method', 'DataFrame.dropna', {
      owner: 'v1.0',
      inputs: [wired('self', 'v1.0'), konst('inplace', 'True')],
      mutates: [['v1.0', 'v1.1']],
      returns_self: false,
    });
    const m = build(b.log());
    const dn = byName(m, 'DataFrame.dropna');
    const [df] = insts(m);
    expect(dn.parent).toBe(df.id);
    expect(dn.inPorts.map((p) => p.param)).toEqual(['inplace']); // the owner is the box, not a port
    expect(dn.outPorts).toEqual([]);
    expect(dn.executions[0]!.outputs).toEqual({});
    expect(df.versions).toEqual([
      { i: 0, token: 'v1.0' },
      { i: 1, token: 'v1.1' },
    ]);
    expect(insts(m)).toHaveLength(1);
  });

  test('a method returning a new object creates a second box from the method box; the new binding gets the prime', () => {
    const b = new B();
    const s0 = b.site('df = load()', 1);
    const s1 = b.site('df = df.dropna()', 2);
    b.val('v1.0', 'DF');
    b.ev(s0, 'function', 'load', { outputs: ['v1.0'] });
    b.val('v2.0', 'DF');
    b.ev(s1, 'method', 'DataFrame.dropna', {
      owner: 'v1.0',
      inputs: [wired('self', 'v1.0')],
      outputs: ['v2.0'],
    });
    b.bindings.push([0, 'df', 'v1.0'], [1, 'df', 'v2.0']);
    const m = build(b.log());
    const dn = byName(m, 'DataFrame.dropna');
    const [first, second] = insts(m);
    expect([first.varName, second.varName]).toEqual(['df', 'df′']);
    expect(dn.parent).toBe(first.id);
    expect(second.createdBy).toBe(dn.id);
    expect(edgeInto(m, second.id, null).map((e) => e.from)).toEqual([
      { node: dn.id, port: 'out:0' },
    ]);
    // a call that returns its argument gives no second box and no wire
    expect(m.edges).toHaveLength(2);
  });

  test('a call returning one of its arguments adds no box and no wire', () => {
    const b = new B();
    const s0 = b.site('a = load()', 1);
    const s1 = b.site('same = np.asarray(a)', 2);
    b.val('v1.0', 'array');
    b.ev(s0, 'function', 'load', { outputs: ['v1.0'] });
    b.ev(s1, 'function', 'asarray', { inputs: [wired('a', 'v1.0')], outputs: ['v1.0'] });
    const m = build(b.log());
    expect(insts(m)).toHaveLength(1);
    expect(edgeInto(m, byName(m, 'asarray').id, 'in:a').map((e) => e.from.node)).toEqual([
      insts(m)[0]!.id,
    ]);
    expect(m.edges.filter((e) => e.from.node === byName(m, 'asarray').id)).toEqual([]);
  });

  test('machine with no producing event gets a lazy instance', () => {
    const b = new B();
    const s = b.site('m.predict(X)', 1);
    b.val('v1.0', 'Ridge', { machine: true });
    b.val('v2.0', 'array');
    b.ev(s, 'method', 'Ridge.predict', { owner: 'v1.0', outputs: ['v2.0'] });
    const m = build(b.log());
    // the machine's box is lazy; the prediction is a box created by the predict method inside it
    expect(insts(m).map((x) => x.className)).toEqual(['Ridge', 'array']);
    expect(calls(m)[0].parent).toBe(insts(m)[0].id);
    expect(insts(m)[1]!.createdBy).toBe(calls(m)[0].id);
  });
});

describe('expr, store and source nodes', () => {
  function exprLog(reachesMachine: boolean): EventLog {
    const b = new B();
    const s0 = b.site('df = load()', 1);
    const sx = b.site('df["price"]', 2, { kind: 'bind' });
    const sy = b.site('y2 = y - 1', 3, { kind: 'bind' });
    const sf = b.site('model.fit(df, y2)', 4);
    const sc = b.site('model = Ridge()', 0);
    b.val('v1.0', 'DF');
    b.ev(s0, 'function', 'load', { outputs: ['v1.0'] });
    b.bind('df', 'v1.0');
    b.val('v2.0', 'Series');
    b.ev(sx, 'expr', 'df["price"]', { inputs: [wired('df', 'v1.0')], outputs: ['v2.0'] });
    b.bind('y', 'v2.0');
    b.val('s5', 'float');
    b.ev(sy, 'expr', 'y - 1', { inputs: [wired('y', 'v2.0')], outputs: ['s5'] });
    b.val('v7.0', 'Ridge', { machine: true });
    b.ev(sc, 'constructor', 'Ridge', { outputs: ['v7.0'] });
    b.bind('model', 'v7.0');
    if (reachesMachine)
      b.ev(sf, 'method', 'Ridge.fit', {
        owner: 'v7.0',
        returns_self: true,
        inputs: [wired('X', 'v1.0'), wired('y', 's5')],
      });
    return b.log();
  }
  test('expr nodes are dashed and kept when reaching a machine, transitively', () => {
    const m = build(exprLog(true));
    const exprs = m.nodes.filter((n): n is ExprNode => n.kind === 'expr');
    expect(exprs.map((x) => x.text)).toEqual(['df["price"]', 'y - 1']);
    const dashed = m.edges.filter((e) => e.dashed);
    // df box -> expr1 -> y box -> expr2 -> fit
    expect(dashed).toHaveLength(4);
    const fitY = m.edges.find((e) => e.to.port === 'in:y');
    expect(fitY?.from.node).toBe(exprs[1]!.id);
    expect(fitY?.dashed).toBe(true);
    const yBox = insts(m).find((x) => x.className === 'Series')!;
    expect(yBox.varName).toBe('y');
    expect(yBox.createdBy).toBe(exprs[0]!.id);
    expect(m.edges.find((e) => e.to.node === exprs[1]!.id)?.from.node).toBe(yBox.id);
    expect(m.edges.find((e) => e.to.node === exprs[1]!.id)?.nameLabel).toBeNull(); // the box names it
  });
  test('expr nodes reaching nothing are dropped, with their edges', () => {
    const m = build(exprLog(false));
    // `df["price"]` creates the y box, so it stays; `y - 1` gives a scalar nobody uses, so it goes
    expect(m.nodes.filter((n) => n.kind === 'expr').map((n) => (n as ExprNode).text)).toEqual([
      'df["price"]',
    ]);
    expect(m.edges.every((e) => !e.from.node.startsWith('src:'))).toBe(true);
    expect(m.edges.some((e) => e.to.node.startsWith('x:') && !e.dashed)).toBe(false);
    expect(m.steps).toEqual([0, 1, 3]); // load, the y expression, the Ridge constructor
  });

  test('store node: inputs old version and rhs, output new version', () => {
    const b = new B();
    const s0 = b.site('df = load()', 1);
    const s1 = b.site('df["c"] = k', 2, { kind: 'store' });
    b.val('v1.0', 'DF');
    b.val('v1.1', 'DF');
    b.val('s1', 'int');
    b.ev(s0, 'function', 'load', { outputs: ['v1.0'] });
    b.bind('df', 'v1.0');
    b.ev(s1, 'store', 'df["c"] = k', {
      inputs: [wired('df', 'v1.0'), wired('value', 's1')],
      outputs: ['v1.1'],
    });
    const m = build(b.log());
    const store = m.nodes.find((n) => n.kind === 'store');
    expect(store).toBeDefined();
    expect(edgeInto(m, store!.id, null).map((e) => e.from.node.startsWith('src:'))).toEqual([
      false,
      true,
    ]);
  });

  test('source nodes: token with no producer, and a version bump with no event', () => {
    const b = new B();
    const s0 = b.site('f(x)', 1);
    const s1 = b.site('g(df)', 2);
    b.val('s1', 'int');
    b.val('s2', 'int');
    b.val('v1.1', 'DF'); // bumped by code the recorder did not see
    b.ev(s0, 'function', 'f', { inputs: [wired('x', 's1')], outputs: ['s9'] });
    b.val('s9', 'int');
    b.bind('x', 's1');
    b.ev(s0, 'function', 'f', { inputs: [wired('x', 's2')], outputs: ['s9'], count: 2 });
    b.bind('x', 's2');
    b.ev(s1, 'function', 'g', { inputs: [wired('x', 'v1.1')] });
    b.bind('df', 'v1.1');
    const m = build(b.log());
    const srcs = m.nodes.filter((n): n is SourceNode => n.kind === 'source');
    expect(srcs.map((s) => s.label)).toEqual(['x']); // the two loop tokens share one source
    // a bumped object with no producing event is a (lazy) box, not a source
    expect(insts(m).map((x) => [x.varName, x.className, x.createdBy])).toEqual([
      ['df', 'DF', null],
    ]);
    expect(srcs[0]!.token).toBe('s2');
    expect(m.edges.filter((e) => e.from.node === srcs[0]!.id)[0]!.uses.map((u) => u.token)).toEqual(
      ['s1', 's2'],
    );
    expect(srcs[0]!.order).toBeLessThan(calls(m)[0]!.order);
  });
});

describe('merging', () => {
  test('same merge key: one node, executions sorted, slot execution included, count of latest', () => {
    const b = new B();
    const s = b.site('f(x)', 1);
    b.val('v1.0', 'DF');
    for (const [k, n] of [
      [0, 1],
      [1, 2],
      [2, 3],
    ] as const) {
      b.val(`v${k + 10}.0`, 'DF');
      b.ev(s, 'function', 'f', {
        inputs: [wired('x', 'v1.0')],
        outputs: [`v${k + 10}.0`],
        count: n,
      });
    }
    const log = b.log();
    // slot execution with a later i and a larger count (non-contiguous i)
    log.events.push({
      ...(log.events[2] as Event),
      i: 40,
      ret: 40,
      count: 50,
      slot: true,
      outputs: ['v10.0'],
    });
    const m = build(log);
    expect(calls(m)).toHaveLength(1);
    const c = calls(m)[0];
    expect(c.executions.map((x) => [x.i, x.count])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [40, 50],
    ]);
    expect(c.outPorts[0]!.typeLabel).toBe('');
    // one wire from x's (lazy) box, with a use per execution; one creation wire to the call site's box
    const fromX = m.edges.filter((e) => e.to.port === 'in:x');
    expect(fromX).toHaveLength(1);
    expect(fromX[0]!.uses).toHaveLength(4);
    expect(m.edges).toHaveLength(2);
    expect(insts(m)).toHaveLength(2);
    expect(m.steps).toEqual([0, 1, 2, 40]);
  });

  test('loop: edge carries uses per consumer execution and a self edge appears', () => {
    const b = new B();
    const s = b.site('x = f(x)', 1);
    b.val('v1.0', 'DF');
    b.val('v2.0', 'DF');
    b.val('v3.0', 'DF');
    b.ev(s, 'function', 'f', { inputs: [wired('x', 'v1.0')], outputs: ['v2.0'], count: 1 });
    b.ev(s, 'function', 'f', { inputs: [wired('x', 'v2.0')], outputs: ['v3.0'], count: 2 });
    const m = build(b.log());
    // f -> its box -> f again: the second execution consumes the box the first one created
    const f = byName(m, 'f');
    const box = insts(m).find((x) => x.createdBy === f.id)!;
    expect(box.versions.map((v) => v.token)).toEqual(['v2.0', 'v3.0']);
    const back = m.edges.find((e) => e.from.node === box.id && e.to.node === f.id);
    expect(back?.uses).toEqual([{ i: 1, token: 'v2.0' }]);
  });

  test('instances created in a loop by one site merge', () => {
    const b = new B();
    const s = b.site('m = Ridge()', 1);
    for (const t of ['v1.0', 'v2.0']) {
      b.val(t, 'Ridge', { machine: true });
      b.ev(s, 'constructor', 'Ridge', { outputs: [t], count: t === 'v1.0' ? 1 : 2 });
    }
    const m = build(b.log());
    expect(insts(m)).toHaveLength(1);
    expect(insts(m)[0].versions.map((v) => v.token)).toEqual(['v1.0', 'v2.0']);
  });
});

describe('name labels', () => {
  test('X = X.drop(...) puts the prime on the new binding', () => {
    const b = new B();
    const s0 = b.site('X = load()', 1);
    const s1 = b.site('X = X.drop("a")', 2);
    const s2 = b.site('fit(X)', 3);
    b.val('v1.0', 'DF');
    b.val('v2.0', 'DF');
    b.ev(s0, 'function', 'load', { outputs: ['v1.0'] });
    b.bind('X', 'v1.0');
    b.ev(s1, 'method', 'DataFrame.drop', {
      owner: 'v1.0',
      inputs: [wired('self', 'v1.0'), konst('labels', '"a"')],
      outputs: ['v2.0'],
    });
    b.bind('X', 'v2.0');
    b.ev(s2, 'function', 'fit', { inputs: [wired('X', 'v2.0')] });
    const m = build(b.log());
    const drop = byName(m, 'DataFrame.drop');
    expect(drop.outPorts[0]!.nameLabel).toBe('X′');
    const [old, cur] = insts(m);
    expect([old.varName, cur.varName]).toEqual(['X', 'X′']); // the new binding gets the prime
    expect(drop.parent).toBe(old.id);
    expect(edgeInto(m, byName(m, 'fit').id, 'in:X')[0]!.from.node).toBe(cur.id);
    expect(edgeInto(m, byName(m, 'fit').id, 'in:X')[0]!.nameLabel).toBeNull();
  });

  test('nested call output wires unlabelled', () => {
    const b = new B();
    const sg = b.site('g(x)', 1);
    const sf = b.site('f(g(x))', 1);
    b.val('v1.0', 'DF');
    b.val('v2.0', 'DF');
    b.ev(sg, 'function', 'g', { outputs: ['v1.0'] });
    b.ev(sf, 'function', 'f', { inputs: [wired('a', 'v1.0', 'call')], outputs: ['v2.0'] });
    const m = build(b.log());
    expect(m.edges[0]!.nameLabel).toBeNull();
  });
});

describe('errors and interruption', () => {
  test('error and interrupted executions carry through', () => {
    const b = new B();
    const s0 = b.site('fit(X)', 1);
    const s1 = b.site('scaler.fit(X)', 2);
    b.ev(s0, 'function', 'fit', { error: { type: 'ValueError', message: 'bad', handled: true } });
    b.ev(s1, 'function', 'scaler.fit', { module: null, interrupted: true, inputs: [] });
    const m = build(b.log());
    expect(calls(m)[0].executions[0]!.error).toMatchObject({ type: 'ValueError', handled: true });
    expect(calls(m)[0].executions[0]!.interrupted).toBe(false);
    expect(calls(m)[1]).toMatchObject({ name: 'scaler.fit', module: null });
    expect(calls(m)[1].executions[0]!.interrupted).toBe(true);
  });

  test('a failed constructor is a call node with the error', () => {
    const b = new B();
    const s = b.site('Ridge(alpha=-1)', 1);
    b.ev(s, 'constructor', 'Ridge', {
      error: { type: 'ValueError', message: 'x', handled: false },
    });
    const m = build(b.log());
    expect(calls(m)[0].executions[0]!.error?.type).toBe('ValueError');
    expect(insts(m)).toEqual([]);
  });
});

describe('limits, determinism, stability', () => {
  test('more than 300 nodes: first 300 by order, tooMany set', () => {
    const b = new B();
    for (let k = 0; k < 350; k++) {
      const s = b.site(`f${k}()`, k + 1);
      b.ev(s, 'function', `f${k}`);
    }
    const m = build(b.log());
    expect(m.nodes).toHaveLength(300);
    expect(m.tooMany).toBe(350);
    expect(m.nodes.map((n) => n.order)).toEqual(
      [...m.nodes.map((n) => n.order)].sort((a, c) => a - c),
    );
    expect(m.steps).toHaveLength(300);
    expect(build(splitLog()).tooMany).toBeUndefined();
  });

  test('deterministic', () => {
    expect(JSON.stringify(build(splitLog()))).toBe(JSON.stringify(build(splitLog())));
  });

  test('changing one unrelated line keeps the ids of unchanged nodes', () => {
    const make = (mid: string, shift: boolean): EventLog => {
      const b = new B();
      const s0 = b.site('a = load()', 1);
      const s1 = b.site(mid, 2);
      const s2 = b.site('b = load()', 3);
      const s3 = b.site('b = load()', 4); // same text twice: occurrence numbers
      b.val('v1.0', 'DF');
      b.val('s1', 'int');
      b.val('v2.0', 'DF');
      b.val('v3.0', 'DF');
      b.ev(s0, 'function', 'load', { outputs: ['v1.0'] });
      b.ev(s1, 'function', 'other', { outputs: [shift ? 's7' : 's1'] });
      b.val('s7', 'int');
      b.ev(s2, 'function', 'load', { outputs: ['v2.0'] });
      b.ev(s3, 'function', 'load', { outputs: ['v3.0'] });
      return b.log();
    };
    const a = build(make('print_a()', false));
    const c = build(make('print_b()', true));
    const ids = (m: GraphModel): string[] => m.nodes.map((n) => n.id);
    // 4 calls and the 3 boxes the loads create; only the `other` call changes its id
    expect(new Set(ids(a)).size).toBe(7);
    expect(ids(a).filter((id) => ids(c).includes(id))).toHaveLength(6);
    expect(ids(a)[0]).toBe(ids(c)[0]);
    expect(ids(a)[1]).toBe(ids(c)[1]);
    expect(ids(a)[5]).toBe(ids(c)[5]);
    expect(ids(a)[6]).toBe(ids(c)[6]);
  });

  test('5,000-event synthetic log builds in under 200 ms', () => {
    const b = new B();
    const sites: number[] = [];
    for (let k = 0; k < 100; k++) sites.push(b.site(`f${k}(x)`, k + 1));
    b.val('v0.0', 'DF');
    let prev = 'v0.0';
    for (let k = 0; k < 5000; k++) {
      const t = `v${k + 1}.0`;
      b.val(t, 'DF');
      b.ev(sites[k % 100]!, 'function', `f${k % 100}`, {
        inputs: [wired('x', prev)],
        outputs: [t],
        count: Math.floor(k / 100) + 1,
      });
      b.bind('x', t);
      prev = t;
    }
    const log = b.log();
    const t0 = performance.now();
    const m = build(log);
    const ms = performance.now() - t0;
    expect(m.nodes.length).toBeGreaterThan(50);
    expect(ms).toBeLessThan(200);
  });
});

describe('methods split per owner instance', () => {
  test('loop over two models at one site: one box in each instance, per-box counts', () => {
    const b = new B();
    const sa = b.site('a = Ridge()', 1);
    const sb = b.site('b = Lasso()', 2);
    const sf = b.site('m.fit(X, y)', 3);
    b.val('v1.0', 'Ridge', { machine: true });
    b.val('v2.0', 'Lasso', { machine: true });
    b.val('v9.0', 'DF');
    b.ev(sa, 'constructor', 'Ridge', { outputs: ['v1.0'] });
    b.ev(sb, 'constructor', 'Lasso', { outputs: ['v2.0'] });
    const fit = (name: string, owner: string, count: number): void => {
      b.ev(sf, 'method', name, { owner, inputs: [wired('X', 'v9.0')], returns_self: true, count });
    };
    fit('Ridge.fit', 'v1.0', 1);
    fit('Lasso.fit', 'v2.0', 2);
    fit('Ridge.fit', 'v1.0', 3);
    const m = build(b.log());
    const [ia, ib] = insts(m);
    const fits = calls(m).filter((c) => c.name.endsWith('.fit'));
    expect(fits).toHaveLength(2);
    expect(new Set(fits.map((f) => f.id)).size).toBe(2);
    const ridge = fits.find((f) => f.name === 'Ridge.fit')!;
    const lasso = fits.find((f) => f.name === 'Lasso.fit')!;
    expect(ridge.parent).toBe(ia.id);
    expect(lasso.parent).toBe(ib.id);
    expect(ridge.executions.map((x) => [x.count, x.owner])).toEqual([
      [1, 'v1.0'],
      [2, 'v1.0'],
    ]);
    expect(lasso.executions.map((x) => x.count)).toEqual([1]);
  });

  test('dict of models: the owner is resolved by identity', () => {
    const b = new B();
    const s1 = b.site('models["rf"] = RF()', 1);
    const s2 = b.site('models["lr"] = LR()', 2);
    const s3 = b.site('models["rf"].fit(X)', 3);
    b.val('v1.0', 'RF', { machine: true });
    b.val('v2.0', 'LR', { machine: true });
    b.ev(s1, 'constructor', 'RF', { outputs: ['v1.0'] });
    b.ev(s2, 'constructor', 'LR', { outputs: ['v2.0'] });
    b.ev(s3, 'method', 'RF.fit', { owner: 'v1.0', returns_self: true });
    const m = build(b.log());
    expect(byName(m, 'RF.fit').parent).toBe(insts(m).find((i) => i.className === 'RF')!.id);
  });

  test('in-place data method: no self port and no mutate port; the box gets the version', () => {
    const b = new B();
    const s0 = b.site('X = load()', 1);
    const s1 = b.site('X.fillna(0, inplace=True)', 2);
    b.val('v1.0', 'DF');
    b.val('v1.1', 'DF');
    b.ev(s0, 'function', 'load', { outputs: ['v1.0'] });
    b.ev(s1, 'method', 'DataFrame.fillna', {
      owner: 'v1.0',
      inputs: [konst('value', '0')],
      mutates: [['v1.0', 'v1.1']],
    });
    const m = build(b.log());
    const f = byName(m, 'DataFrame.fillna');
    expect(f.inPorts.map((p) => p.id)).toEqual(['in:value']);
    expect(f.outPorts).toEqual([]);
    expect(f.parent).toBe(insts(m)[0]!.id);
    expect(insts(m)[0]!.versions.map((v) => v.token)).toEqual(['v1.0', 'v1.1']);
  });
});

describe('producer order', () => {
  test('an object used before its producing event is one box, not a source', () => {
    const b = new B();
    const s0 = b.site('np.round(coefs)', 1);
    const s1 = b.site('model.coef_', 2);
    b.val('v1.0', 'ndarray', { shape: [3] });
    b.ev(s0, 'function', 'np.round', { inputs: [wired('a', 'v1.0')], outputs: ['v2.0'] });
    b.val('v2.0', 'ndarray', { shape: [3] });
    b.ev(s1, 'expr', 'model.coef_', { inputs: [], outputs: ['v1.0'] });
    const m = build(b.log());
    const round = byName(m, 'np.round');
    const into = edgeInto(m, round.id, 'in:a');
    expect(into).toHaveLength(1);
    const from = m.nodes.find((n) => n.id === into[0]?.from.node);
    expect(from?.kind).toBe('instance'); // a lazy box for the object (no wire from the later expression)
    // the later expression returned that very object (same token), so it is the box's creator
    expect(insts(m).map((x) => x.createdBy?.startsWith('x:'))).toEqual([false, true]);
    expect(insts(m).map((x) => x.versions[0]!.token)).toEqual(['v2.0', 'v1.0']);
    expect(m.nodes.some((n) => n.kind === 'source')).toBe(false);
  });
});
