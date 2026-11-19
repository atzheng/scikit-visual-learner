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
    expect(read.outPorts).toEqual([{ id: 'out:0', param: '0', typeLabel: 'DF', nameLabel: 'df' }]);
    expect(split.inPorts.map((p) => [p.id, p.typeLabel, p.constText])).toEqual([
      ['in:arrays[0]', 'DF', undefined],
      ['in:test_size', '', 'test_size = 0.2'],
    ]);
    expect(split.outPorts.map((p) => p.nameLabel)).toEqual(['X_train', 'X_test']);
    expect(split.executions[0]).toMatchObject({
      i: 1,
      inputs: { 'in:arrays[0]': 'v1.0' },
      outputs: { 'out:0': 'v2.0', 'out:1': 'v3.0' },
    });
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0]).toMatchObject({
      from: { node: read.id, port: 'out:0' },
      to: { node: split.id, port: 'in:arrays[0]' },
      dashed: false,
      nameLabel: 'df',
    });
    expect(m.edges[0]!.uses).toEqual([{ i: 1, token: 'v1.0' }]);
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
    expect(m.edges).toEqual([]);
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
    const [inst] = insts(m);
    expect(insts(m)).toHaveLength(1);
    expect(inst).toMatchObject({
      className: 'StandardScaler',
      varName: 'scaler',
      createdAt: 2,
      createdBy: null,
      params: [{ name: 'with_std', text: 'True' }],
    });
    expect(inst.versions).toEqual([
      { i: 2, token: 'v3.0' },
      { i: 3, token: 'v3.1' },
    ]);
    const methods = calls(m).filter((c) => c.parent === inst.id);
    expect(methods.map((c) => c.name)).toEqual([
      'StandardScaler.fit',
      'StandardScaler.transform',
      'StandardScaler.transform',
    ]);
    expect(new Set(methods.map((c) => c.id)).size).toBe(3);
    for (const c of methods) expect(c.inPorts.map((p) => p.param)).toEqual(['X']);
    const fit = methods[0]!;
    expect(fit.outPorts).toEqual([]); // returns_self, machine mutates: no out-port
    // DataFrame constructors are plain call nodes
    expect(
      calls(m)
        .filter((c) => c.parent === null)
        .map((c) => c.name),
    ).toEqual(['DataFrame', 'DataFrame']);
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
    const cvs = calls(m)[0];
    expect(edgeInto(m, cvs.id, 'in:estimator')[0]!.from).toEqual({ node: inst.id, port: null });
    expect(cvs.inPorts[0]!.typeLabel).toBe('Ridge');
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
    const fn = calls(m)[0];
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

  test('data method gets a self port; mutates on data gives a changedInPlace out-port', () => {
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
    expect(dn.parent).toBeNull();
    expect(dn.inPorts.map((p) => p.param)).toEqual(['self', 'inplace']);
    expect(dn.outPorts).toEqual([
      { id: 'out:mut:self', param: 'self', typeLabel: 'DF', nameLabel: 'df', changedInPlace: true },
    ]);
    expect(dn.executions[0]!.outputs).toEqual({ 'out:mut:self': 'v1.1' });
  });

  test('mutates on a machine updates versions of the instance, including nested machines', () => {
    const b = new B();
    const sa = b.site('a = A()', 1);
    const sb = b.site('b = B()', 2);
    const sf = b.site('a.fit(X)', 3);
    b.val('v1.0', 'A', { machine: true });
    b.val('v2.0', 'B', { machine: true });
    b.val('v1.1', 'A', { machine: true });
    b.val('v2.1', 'B', { machine: true });
    b.ev(sa, 'constructor', 'A', { outputs: ['v1.0'] });
    b.ev(sb, 'constructor', 'B', { outputs: ['v2.0'] });
    b.ev(sf, 'method', 'A.fit', {
      owner: 'v1.0',
      returns_self: true,
      mutates: [
        ['v1.0', 'v1.1'],
        ['v2.0', 'v2.1'],
      ],
    });
    const m = build(b.log());
    const [ia, ib] = insts(m);
    expect(ia.versions.map((v) => v.token)).toEqual(['v1.0', 'v1.1']);
    expect(ib.versions).toEqual([
      { i: 1, token: 'v2.0' },
      { i: 2, token: 'v2.1' },
    ]);
  });

  test('machine with no producing event gets a lazy instance', () => {
    const b = new B();
    const s = b.site('m.predict(X)', 1);
    b.val('v1.0', 'Ridge', { machine: true });
    b.val('v2.0', 'array');
    b.ev(s, 'method', 'Ridge.predict', { owner: 'v1.0', outputs: ['v2.0'] });
    const m = build(b.log());
    expect(insts(m)).toHaveLength(1);
    expect(calls(m)[0].parent).toBe(insts(m)[0].id);
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
    expect(dashed).toHaveLength(3); // df -> expr1, expr1 -> expr2, expr2 -> fit
    const fitY = m.edges.find((e) => e.to.port === 'in:y');
    expect(fitY?.from.node).toBe(exprs[1]!.id);
    expect(fitY?.dashed).toBe(true);
    expect(m.edges.find((e) => e.to.node === exprs[1]!.id)?.nameLabel).toBe('y');
  });
  test('expr nodes reaching nothing are dropped, with their edges', () => {
    const m = build(exprLog(false));
    expect(m.nodes.some((n) => n.kind === 'expr')).toBe(false);
    expect(m.edges).toEqual([]);
    expect(m.steps).toEqual([0, 3]); // load and the Ridge constructor
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
    expect(srcs.map((s) => s.label)).toEqual(['x', 'df']); // the two loop tokens share one source
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
    expect(c.outPorts[0]!.typeLabel).toBe('DF');
    expect(m.edges).toHaveLength(1); // one source edge; uses per execution
    expect(m.edges[0]!.uses).toHaveLength(4);
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
    const self = m.edges.find((e) => e.from.node === e.to.node);
    expect(self?.uses).toEqual([{ i: 1, token: 'v2.0' }]);
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
  test('X = X.drop(...) puts a prime on the superseded wire', () => {
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
    expect(drop.outPorts[0]!.nameLabel).toBe('X');
    expect(edgeInto(m, drop.id, 'in:self')[0]!.nameLabel).toBe('X′');
    expect(edgeInto(m, byName(m, 'fit').id, 'in:X')[0]!.nameLabel).toBe('X');
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
    expect(new Set(ids(a)).size).toBe(4);
    expect(ids(a).filter((id) => ids(c).includes(id))).toHaveLength(3);
    expect(ids(a)[0]).toBe(ids(c)[0]);
    expect(ids(a)[2]).toBe(ids(c)[2]);
    expect(ids(a)[3]).toBe(ids(c)[3]);
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

  test('in-place data method: mutate port is out:mut:self, matching in:self', () => {
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
    expect(f.inPorts.map((p) => p.id)).toContain('in:self');
    expect(f.outPorts.map((p) => p.id)).toEqual(['out:mut:self']);
  });
});

describe('producer order', () => {
  test('a consumer that ran before the producing event gets a source node, not a wire', () => {
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
    expect(from?.kind).toBe('source');
  });
});
