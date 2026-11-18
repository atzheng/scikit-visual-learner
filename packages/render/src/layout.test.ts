import { describe, expect, test } from 'vitest';
import type {
  CallNode,
  Execution,
  GEdge,
  GNode,
  GraphModel,
  InstanceNode,
  Port,
} from '@machines/log';
import { buildElkGraph, layout } from './layout';
import type { Laid, LaidNode } from './layout';

const measure = (text: string): number => text.length * 7;

// ---- hand-written model builders
const ex = (i = 0): Execution => ({
  i,
  ret: i,
  inputs: {},
  outputs: {},
  count: 1,
  owner: null,
  error: null,
  interrupted: false,
});
const inP = (param: string, typeLabel = 'DF'): Port => ({
  id: `in:${param}`,
  param,
  typeLabel,
  nameLabel: null,
});
const constP = (param: string, text: string): Port => ({
  id: `in:${param}`,
  param,
  typeLabel: '',
  nameLabel: null,
  constText: `${param} = ${text}`,
});
const outP = (k: number, typeLabel: string, nameLabel: string | null): Port => ({
  id: `out:${k}`,
  param: String(k),
  typeLabel,
  nameLabel,
});
function call(
  id: string,
  name: string,
  order: number,
  inPorts: Port[],
  outPorts: Port[],
  parent: string | null = null,
): CallNode {
  return {
    kind: 'call',
    id,
    parent,
    order,
    mergeKey: id,
    name,
    module: 'lib',
    executions: [ex(order)],
    inPorts,
    outPorts,
    student: false,
  };
}
function inst(
  id: string,
  order: number,
  className: string,
  varName: string | null,
  params: string[] = [],
): InstanceNode {
  return {
    kind: 'instance',
    id,
    parent: null,
    order,
    className,
    varName,
    createdAt: 0,
    createdBy: null,
    params: params.map((p) => ({ name: p, text: '1' })),
    versions: [],
  };
}
const src = (id: string, order: number, label: string): GNode => ({
  kind: 'source',
  id,
  parent: null,
  order,
  label,
  token: 't1',
});
const expr = (id: string, order: number, text: string): GNode => ({
  kind: 'expr',
  id,
  parent: null,
  order,
  text,
  executions: [ex(order)],
});
const edge = (
  id: string,
  from: [string, string | null],
  to: [string, string | null],
  dashed = false,
): GEdge => ({
  id,
  from: { node: from[0], port: from[1] },
  to: { node: to[0], port: to[1] },
  dashed,
  uses: [],
  nameLabel: null,
});
const model = (nodes: GNode[], edges: GEdge[]): GraphModel => ({ nodes, edges, steps: [] });

/** Golden "split": df -> X, y -> train_test_split -> 4 outputs. */
function splitModel(): GraphModel {
  return model(
    [
      src('src:a', 100000 - 0.5, 'df'),
      expr('x:X', 100000, 'df[features]'),
      expr('x:y', 100100, 'df["price"]'),
      call(
        'n:split',
        'train_test_split',
        200000,
        [inP('X'), inP('y', 'Series'), constP('test_size', '0.2')],
        [
          outP(0, 'DF', 'X_train'),
          outP(1, 'DF', 'X_test'),
          outP(2, 'Series', 'y_train'),
          outP(3, 'Series', 'y_test'),
        ],
      ),
    ],
    [
      edge('e1', ['src:a', null], ['x:X', null], true),
      edge('e2', ['src:a', null], ['x:y', null], true),
      edge('e3', ['x:X', null], ['n:split', 'in:X'], true),
      edge('e4', ['x:y', null], ['n:split', 'in:y'], true),
    ],
  );
}

/** Golden "linreg": split -> model.fit(X_train, y_train) -> model.predict(X_test) inside one instance. */
function linregModel(): GraphModel {
  const split = call(
    'n:split',
    'train_test_split',
    100000,
    [inP('X'), inP('y', 'Series')],
    [
      outP(0, 'DF', 'X_train'),
      outP(1, 'DF', 'X_test'),
      outP(2, 'Series', 'y_train'),
      outP(3, 'Series', 'y_test'),
    ],
  );
  const fit = call('n:fit@i:m', 'fit', 300000, [inP('X'), inP('y', 'Series')], [], 'i:m');
  const predict = call(
    'n:pred@i:m',
    'predict',
    400000,
    [inP('X')],
    [outP(0, 'array', 'pred')],
    'i:m',
  );
  return model(
    [
      src('src:X', 100000 - 0.5, 'X'),
      src('src:y', 100000 - 0.4, 'y'),
      split,
      inst('i:m', 200000, 'LinearRegression', 'model', ['fit_intercept']),
      fit,
      predict,
    ],
    [
      edge('e1', ['src:X', null], ['n:split', 'in:X']),
      edge('e2', ['src:y', null], ['n:split', 'in:y']),
      edge('e3', ['n:split', 'out:0'], ['n:fit@i:m', 'in:X']),
      edge('e4', ['n:split', 'out:2'], ['n:fit@i:m', 'in:y']),
      edge('e5', ['n:split', 'out:1'], ['n:pred@i:m', 'in:X']),
    ],
  );
}

/** Pipeline: make_pipeline returns a machine (instance below it), plus a self-edge loop `x = g(x)`. */
function pipelineModel(): GraphModel {
  const mk = call(
    'n:mk',
    'make_pipeline',
    100000,
    [inP('steps', 'tuple')],
    [outP(0, 'Pipeline', 'pipe')],
  );
  const g = call('n:g', 'g', 200000, [inP('x', 'DF'), constP('k', '3')], [outP(0, 'DF', 'x')]);
  return model(
    [
      inst('i:sc', 99999, 'StandardScaler', 'scaler'),
      mk,
      inst('i:pipe', 100001, 'Pipeline', 'pipe'),
      expr('x:e', 150000, 'df.dropna()'),
      g,
    ],
    [
      edge('e1', ['i:sc', null], ['n:mk', 'in:steps']),
      edge('e2', ['n:mk', 'out:0'], ['i:pipe', null]),
      edge('e3', ['x:e', null], ['n:g', 'in:x'], true),
      edge('self', ['n:g', 'out:0'], ['n:g', 'in:x']),
    ],
  );
}

const N = (l: Laid, id: string) => {
  const v = l.nodes[id];
  if (!v) throw new Error(`no node ${id}`);
  return v;
};
const E = (l: Laid, id: string) => {
  const v = l.edges[id];
  if (!v) throw new Error(`no edge ${id}`);
  return v.points;
};
const P = (l: LaidNode, id: string) => {
  const v = l.ports[id];
  if (!v) throw new Error(`no port ${id}`);
  return v;
};
const finite = (v: number): boolean => Number.isFinite(v);

function checkGeometry(m: GraphModel, laid: Laid): void {
  expect(finite(laid.width) && finite(laid.height) && laid.width > 0 && laid.height > 0).toBe(true);
  for (const n of m.nodes) {
    const l = N(laid, n.id);
    expect(l, n.id).toBeDefined();
    for (const v of [l.x, l.y, l.w, l.h]) expect(finite(v)).toBe(true);
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.y).toBeGreaterThanOrEqual(0);
    expect(l.x + l.w).toBeLessThanOrEqual(laid.width + 0.01);
    expect(l.y + l.h).toBeLessThanOrEqual(laid.height + 0.01);
    if (n.kind !== 'call') continue;
    // ports on the right border
    for (const p of n.inPorts) {
      const lp = P(l, p.id);
      expect(lp.y).toBeCloseTo(l.y, 3);
      expect(lp.x).toBeGreaterThanOrEqual(l.x - 0.01);
      expect(lp.x).toBeLessThanOrEqual(l.x + l.w + 0.01);
    }
    for (const p of n.outPorts) {
      const lp = P(l, p.id);
      expect(lp.y).toBeCloseTo(l.y + l.h, 3);
      expect(lp.x).toBeGreaterThanOrEqual(l.x - 0.01);
      expect(lp.x).toBeLessThanOrEqual(l.x + l.w + 0.01);
    }
    // left-to-right in signature order, with room for the labels
    for (const list of [n.inPorts, n.outPorts]) {
      for (let k = 1; k < list.length; k++) {
        const a = P(l, list[k - 1]!.id);
        const b = P(l, list[k]!.id);
        expect(b.x).toBeGreaterThan(a.x);
        expect(b.x - a.x).toBeGreaterThanOrEqual((a.w + b.w) / 2 - 0.01);
      }
    }
  }
  // parents contain children
  for (const n of m.nodes) {
    if (n.parent === null) continue;
    const p = N(laid, n.parent);
    const c = N(laid, n.id);
    expect(c.x).toBeGreaterThanOrEqual(p.x);
    expect(c.y).toBeGreaterThanOrEqual(p.y + (p.headerH ?? 0) + (p.attrsH ?? 0));
    expect(c.x + c.w).toBeLessThanOrEqual(p.x + p.w + 0.01);
    expect(c.y + c.h).toBeLessThanOrEqual(p.y + p.h + 0.01);
  }
  for (const e of m.edges) {
    const pts = E(laid, e.id);
    expect(pts.length, e.id).toBeGreaterThanOrEqual(2);
    for (const [x, y] of pts) expect(finite(x) && finite(y)).toBe(true);
  }
}

describe('buildElkGraph (pure)', () => {
  test('options, port order and child order', () => {
    const g = buildElkGraph(splitModel(), { measure });
    expect(g.layoutOptions).toMatchObject({
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.portConstraints': 'FIXED_ORDER',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    });
    expect(g.children!.map((c) => c.id)).toEqual(['src:a', 'x:X', 'x:y', 'n:split']);
    const split = g.children!.find((c) => c.id === 'n:split')!;
    expect(split.layoutOptions).toEqual({ 'elk.portConstraints': 'FIXED_ORDER' });
    expect(
      split.ports!.map((p) => [
        p.id,
        p.layoutOptions!['elk.port.side'],
        p.layoutOptions!['elk.port.index'],
      ]),
    ).toEqual([
      ['n:split#in:X', 'NORTH', '0'],
      ['n:split#in:y', 'NORTH', '1'],
      ['n:split#in:test_size', 'NORTH', '2'],
      ['n:split#out:0', 'SOUTH', '6'],
      ['n:split#out:1', 'SOUTH', '5'],
      ['n:split#out:2', 'SOUTH', '4'],
      ['n:split#out:3', 'SOUTH', '3'],
    ]);
    expect(g.edges!.map((e) => [e.sources[0], e.targets[0]])).toEqual([
      ['src:a', 'x:X'],
      ['src:a', 'x:y'],
      ['x:X', 'n:split#in:X'],
      ['x:y', 'n:split#in:y'],
    ]);
  });

  test('children sorted by order regardless of model array order; methods nested in instance', () => {
    const m = linregModel();
    m.nodes.reverse();
    const g = buildElkGraph(m, { measure });
    expect(g.children!.map((c) => c.id)).toEqual(['src:X', 'src:y', 'n:split', 'i:m']);
    const i = g.children!.find((c) => c.id === 'i:m')!;
    expect(i.children!.map((c) => c.id)).toEqual(['n:fit@i:m', 'n:pred@i:m']);
    expect(i.layoutOptions!['elk.padding']).toBe('[top=58,left=12,bottom=12,right=12]'); // 28 header + 1 row*18 + 12
  });

  test('sizes follow the measured text; a node whose parent is missing goes to the root', () => {
    const narrow = buildElkGraph(splitModel(), { measure: () => 1 }).children!.find(
      (c) => c.id === 'n:split',
    )!;
    const wide = buildElkGraph(splitModel(), { measure: () => 20 }).children!.find(
      (c) => c.id === 'n:split',
    )!;
    expect(wide.width!).toBeGreaterThan(narrow.width!);
    const m = model([call('n:a', 'a', 1, [], [], 'gone')], []);
    expect(buildElkGraph(m, { measure }).children!.map((c) => c.id)).toEqual(['n:a']);
  });

  test('edges to unknown nodes are dropped; unknown ports fall back to the node border', () => {
    const m = splitModel();
    m.edges.push(
      edge('bad', ['nope', null], ['n:split', 'in:X']),
      edge('fb', ['x:X', null], ['n:split', 'in:zzz']),
    );
    const g = buildElkGraph(m, { measure });
    expect(g.edges!.some((e) => e.id === 'bad')).toBe(false);
    expect(g.edges!.find((e) => e.id === 'fb')!.targets).toEqual(['n:split']);
  });
});

describe('layout (ELK)', () => {
  const models: [string, () => GraphModel][] = [
    ['split', splitModel],
    ['linreg', linregModel],
    ['pipeline + self-edge', pipelineModel],
  ];
  for (const [name, mk] of models) {
    test(`${name}: geometry`, async () => {
      const m = mk();
      checkGeometry(m, await layout(m, { measure }));
    });
    test(`${name}: deterministic`, async () => {
      const a = await layout(mk(), { measure });
      const b = await layout(mk(), { measure });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });
  }

  test('split: top-to-bottom in source order', async () => {
    const laid = await layout(splitModel(), { measure });
    const y = (id: string): number => N(laid, id).y;
    expect(y('src:a')).toBeLessThan(y('x:X'));
    expect(y('x:X')).toBeLessThan(y('n:split'));
    expect(y('x:y')).toBeLessThan(y('n:split'));
  });

  test('linreg: source order down the page, methods inside the instance', async () => {
    const m = linregModel();
    const laid = await layout(m, { measure });
    const n = (id: string) => N(laid, id);
    expect(n('src:X').y).toBeLessThan(n('n:split').y);
    expect(n('n:split').y + n('n:split').h).toBeLessThanOrEqual(n('n:fit@i:m').y);
    expect(n('i:m').w).toBeGreaterThan(n('n:fit@i:m').w);
    expect(n('i:m').headerH).toBe(28);
    expect(n('i:m').attrsH).toBe(18);
    // wires into the box end at its top border
    const e3 = E(laid, 'e3');
    expect(e3[e3.length - 1]![1]).toBeCloseTo(n('n:fit@i:m').y, 3);
  });

  test('attrRows reserve space in the instance', async () => {
    const m = linregModel();
    const a = await layout(m, { measure });
    const b = await layout(m, {
      measure,
      attrRows: { 'i:m': ['coef_ array', 'intercept_ float', 'n_features_in_ int'] },
    });
    expect(N(b, 'i:m').attrsH).toBe(54);
    expect(N(b, 'i:m').h).toBeGreaterThan(N(a, 'i:m').h);
    checkGeometry(m, b);
  });

  test('pipeline: function box above the instance it creates; self-edge routed', async () => {
    const m = pipelineModel();
    const laid = await layout(m, { measure });
    expect(N(laid, 'n:mk').y + N(laid, 'n:mk').h).toBeLessThanOrEqual(N(laid, 'i:pipe').y);
    const self = E(laid, 'self');
    expect(self.length).toBeGreaterThanOrEqual(2);
    const start = P(N(laid, 'n:g'), 'out:0');
    const end = P(N(laid, 'n:g'), 'in:x');
    expect(self[0]![0]).toBeCloseTo(start.x, 1);
    expect(self[self.length - 1]![0]).toBeCloseTo(end.x, 1);
  });

  test('empty model', async () => {
    const laid = await layout(model([], []), { measure });
    expect(laid.nodes).toEqual({});
  });

  test('300 nodes complete in under 1 s', async () => {
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    let prev: string | null = null;
    for (let k = 0; k < 300; k++) {
      const id = `n:${k}`;
      nodes.push(
        call(id, `f${k}`, (k + 1) * 100000, [inP('X'), constP('c', '1')], [outP(0, 'DF', `v${k}`)]),
      );
      if (prev) edges.push(edge(`e${k}`, [prev, 'out:0'], [id, 'in:X']));
      if (k > 3 && k % 3 === 0) edges.push(edge(`f${k}`, [`n:${k - 3}`, 'out:0'], [id, 'in:c']));
      prev = id;
    }
    const m = model(nodes, edges);
    await layout(m, { measure }); // warm up the JIT
    const t0 = performance.now();
    const laid = await layout(m, { measure });
    const dt = performance.now() - t0;
    console.log(`layout of 300 nodes: ${dt.toFixed(0)} ms`);
    expect(Object.keys(laid.nodes)).toHaveLength(300);
    expect(dt).toBeLessThan(1000);
  });
});
