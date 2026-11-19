// Golden tests over the real fixtures (CONTRACTS.md section 9): stream cross-check, graph snapshots,
// the no-false-wires invariant and the slide-level structure of the three golden programs.
// `UPDATE_GRAPHS=1` rewrites fixtures/graphs/*.json from fixtures/logs/*.json (`pnpm fixtures` does this).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAssembler } from './assemble';
import { buildGraph, keyOf } from './graph';
import { stateAt, stepOfEvent } from './timeline';
import type { CallNode, Execution, GEdge, GNode, GraphModel, InstanceNode } from './graph';
import type { FromWorker } from './messages';
import type { EventLog, Token } from './types';
import { validateLog } from './validate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures');
const names = readdirSync(join(ROOT, 'logs'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort();

const readLog = (n: string): EventLog =>
  JSON.parse(readFileSync(join(ROOT, 'logs', `${n}.json`), 'utf8')) as EventLog;
const readStream = (n: string): FromWorker[] =>
  readFileSync(join(ROOT, 'streams', `${n}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as FromWorker);
const graphPath = (n: string): string => join(ROOT, 'graphs', `${n}.json`);
const dumps = (g: GraphModel): string => JSON.stringify(g, null, 2) + '\n';

if (process.env.UPDATE_GRAPHS) {
  for (const n of names) writeFileSync(graphPath(n), dumps(buildGraph(readLog(n))));
}

describe('fixtures', () => {
  it('has the 26 programs', () => {
    expect(names.length).toBe(27);
  });

  describe.each(names)('%s', (n) => {
    it('assembling the stream gives the log', () => {
      const asm = createAssembler();
      for (const m of readStream(n)) asm.push(m);
      expect(asm.finish()).toEqual(readLog(n));
    });

    it('log is valid', () => {
      expect(() => validateLog(readLog(n))).not.toThrow();
    });

    it('buildGraph(log) equals the checked-in graph', () => {
      expect(existsSync(graphPath(n))).toBe(true);
      const expected = JSON.parse(readFileSync(graphPath(n), 'utf8')) as GraphModel;
      expect(JSON.parse(dumps(buildGraph(readLog(n))))).toEqual(expected);
    });

    it('has no false wires: every use is backed by the log', () => {
      const g = buildGraph(readLog(n));
      const byId = new Map(g.nodes.map((x) => [x.id, x]));
      const execsOf = (x: GNode | undefined): Execution[] =>
        x && (x.kind === 'call' || x.kind === 'expr' || x.kind === 'store') ? x.executions : [];
      for (const ed of g.edges) {
        if (ed.callee) continue; // callee wires carry no value: checked below
        const from = byId.get(ed.from.node);
        const to = byId.get(ed.to.node);
        expect(from, ed.id).toBeDefined();
        expect(to, ed.id).toBeDefined();
        expect(ed.uses.length, ed.id).toBeGreaterThan(0);
        for (const u of ed.uses) {
          // consumer side: an execution at i took exactly this token on this port
          if (to?.kind === 'call' || to?.kind === 'expr' || to?.kind === 'store') {
            const ex = execsOf(to).find((x) => x.i === u.i);
            expect(ex, `${ed.id} consumer @${u.i}`).toBeDefined();
            const ins =
              ed.to.port === null ? Object.values(ex?.inputs ?? {}) : [ex?.inputs[ed.to.port]];
            expect(ins, `${ed.id} consumes ${u.token}`).toContain(u.token);
          }
          // producer side: the token is an output of an execution that had returned before the consumer began
          if (from?.kind === 'call' || from?.kind === 'expr' || from?.kind === 'store') {
            const port = ed.from.port;
            const ok = execsOf(from).some(
              (x) =>
                (port === null ? Object.values(x.outputs) : [x.outputs[port]]).includes(u.token) &&
                // an instance has no execution: its creating wire is used exactly at the creator's return
                (to?.kind === 'instance' ? x.ret === u.i : x.ret < u.i),
            );
            expect(ok, `${ed.id} produced ${u.token} before @${u.i}`).toBe(true);
          } else if (from?.kind === 'instance') {
            expect(
              from.versions.some((v) => keyOf(v.token) === keyOf(u.token)),
              `${ed.id} instance holds ${u.token}`,
            ).toBe(true);
          }
        }
      }
    });

    it('callee wires: the import binds the call root name, and nothing rebound it', () => {
      const log = readLog(n);
      const g = buildGraph(log);
      const byId = new Map(g.nodes.map((x) => [x.id, x]));
      const evOf = new Map(log.events.map((e) => [e.i, e]));
      for (const ed of g.edges) {
        const imp = byId.get(ed.from.node);
        // an import node has callee wires only, and no value wire touches it
        if (imp?.kind === 'import') expect(ed.callee, ed.id).toBe(true);
        expect(byId.get(ed.to.node)?.kind, ed.id).not.toBe('import');
        if (!ed.callee) continue;
        expect(imp?.kind, ed.id).toBe('import');
        if (imp?.kind !== 'import') continue;
        const site = log.sites[imp.site]!;
        const b = site.imports?.find((x) => x.name === imp.name);
        expect(site.kind).toBe('import');
        expect(b?.sole, `${imp.name} is bound once in the whole module`).toBe(true);
        expect(ed.uses.length).toBeGreaterThan(0);
        for (const u of ed.uses) {
          const call = log.sites[evOf.get(u.i)!.site]!;
          expect(call.func_text?.split('.')[0], ed.id).toBe(imp.name);
          expect([call.line, call.col], 'the call follows the import').toSatisfy(
            ([l, c]: number[]) => l! > site.end_line || (l === site.end_line && c! >= site.end_col),
          );
        }
      }
    });

    it('every object is one box: no object token is a source, no object is in two boxes', () => {
      const g = buildGraph(readLog(n));
      for (const x of g.nodes)
        if (x.kind === 'source') expect(x.token.startsWith('s'), x.id).toBe(true);
      const owner = new Map<string, string>();
      for (const b of g.nodes.filter((x): x is InstanceNode => x.kind === 'instance')) {
        for (const v of b.versions) {
          const k = keyOf(v.token);
          expect(owner.get(k) ?? b.id, `object ${k}`).toBe(b.id);
          owner.set(k, b.id);
        }
      }
    });

    it('is deterministic and does not mutate the log', () => {
      const log = readLog(n);
      const before = JSON.stringify(log);
      expect(dumps(buildGraph(log))).toBe(dumps(buildGraph(log)));
      expect(JSON.stringify(log)).toBe(before);
    });
  });
});

// ---- slide-level structure of the three golden programs (explicit, not just snapshots)

const graphOf = (n: string): GraphModel => buildGraph(readLog(n));
const calls = (g: GraphModel, name: string): CallNode[] =>
  g.nodes.filter((x): x is CallNode => x.kind === 'call' && x.name === name);
const instances = (g: GraphModel, className?: string): InstanceNode[] =>
  g.nodes.filter(
    (x): x is InstanceNode =>
      x.kind === 'instance' && (className === undefined || x.className === className),
  );
const only = <T>(xs: T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0] as T;
};
const edgesInto = (g: GraphModel, node: GNode, port?: string): GEdge[] =>
  g.edges.filter((e) => e.to.node === node.id && (port === undefined || e.to.port === port));
const edgesOutOf = (g: GraphModel, node: GNode): GEdge[] =>
  g.edges.filter((e) => e.from.node === node.id);
const upstream = (g: GraphModel, edge: GEdge): GNode =>
  g.nodes.find((x) => x.id === edge.from.node)!;

/** The box (instance node) whose creating wire leaves `node`'s output `port`. */
const boxFrom = (g: GraphModel, node: GNode, port: string | null): InstanceNode =>
  only(
    g.edges
      .filter((e) => e.from.node === node.id && e.from.port === port)
      .map((e) => g.nodes.find((x) => x.id === e.to.node))
      .filter((x): x is InstanceNode => x?.kind === 'instance'),
  );

describe('golden_split', () => {
  const g = graphOf('golden_split');
  const split = only(calls(g, 'train_test_split'));

  it('read_csv creates the df box; dropna sits inside it and creates the next df box', () => {
    const readCsv = only(calls(g, 'read_csv'));
    const dropna = only(calls(g, 'DataFrame.dropna'));
    const first = boxFrom(g, readCsv, 'out:0');
    expect(first.className).toBe('DF');
    expect(first.varName).toBe('df'); // the new binding gets the prime: `df = df.dropna()` makes df′
    expect(dropna.parent).toBe(first.id);
    expect(edgesInto(g, dropna, 'in:self')).toEqual([]); // the owner is the box, not a port
    const second = boxFrom(g, dropna, 'out:0');
    expect(second.varName).toBe('df′');
    expect(second.id).not.toBe(first.id);
  });

  it('the X and y expressions read the df box and create the X and y boxes, which feed the split', () => {
    const df = boxFrom(g, only(calls(g, 'DataFrame.dropna')), 'out:0');
    const xEdge = only(edgesInto(g, split, 'in:arrays[0]'));
    const yEdge = only(edgesInto(g, split, 'in:arrays[1]'));
    const xBox = upstream(g, xEdge) as InstanceNode;
    const yBox = upstream(g, yEdge) as InstanceNode;
    expect([xBox.kind, xBox.varName, xBox.className]).toEqual(['instance', 'X', 'DF']);
    expect([yBox.kind, yBox.varName, yBox.className]).toEqual(['instance', 'y', 'Series']);
    expect([xEdge.nameLabel, yEdge.nameLabel]).toEqual([null, null]); // the box carries the name
    for (const [box, text] of [
      [xBox, 'df[["beds", "baths", "sqft", "year_built"]]'],
      [yBox, 'df["price"]'],
    ] as const) {
      const wire = only(edgesInto(g, box));
      const ex = upstream(g, wire);
      expect(ex.kind === 'expr' && ex.text).toBe(text);
      expect(wire.dashed).toBe(true);
      expect(edgesInto(g, ex).map((e) => [e.from.node, e.dashed])).toEqual([[df.id, true]]);
    }
  });

  it('test_size is a const port and the four outputs are four named boxes', () => {
    expect(split.inPorts.find((p) => p.id === 'in:test_size')?.constText).toBe('test_size = 0.2');
    expect(edgesInto(g, split, 'in:test_size')).toEqual([]);
    expect(split.outPorts.map((p) => p.nameLabel)).toEqual([
      'X_train',
      'X_test',
      'y_train',
      'y_test',
    ]);
    // the boxes show the type; the ports do not repeat it
    expect(split.outPorts.map((p) => p.typeLabel)).toEqual(['', '', '', '']);
    const boxes = split.outPorts.map((p) => boxFrom(g, split, p.id));
    expect(boxes.map((b) => [b.varName, b.className])).toEqual([
      ['X_train', 'DF'],
      ['X_test', 'DF'],
      ['y_train', 'Series'],
      ['y_test', 'Series'],
    ]);
    expect(new Set(boxes.map((b) => b.id)).size).toBe(4);
  });

  it('X_train and X_test are not wired to each other (nothing is drawn after the split)', () => {
    expect(
      edgesOutOf(g, split).every(
        (e) => g.nodes.find((x) => x.id === e.to.node)?.kind === 'instance',
      ),
    ).toBe(true);
    for (const b of instances(g).filter((x) => x.createdBy === split.id)) {
      expect(edgesOutOf(g, b)).toEqual([]);
    }
  });
});

describe('golden_onehot', () => {
  const g = graphOf('golden_onehot');
  const inst = only(instances(g, 'OneHotEncoder'));
  const split = only(calls(g, 'train_test_split'));
  const ctor = only(calls(g, 'OneHotEncoder'));
  const fit = only(calls(g, 'OneHotEncoder.fit'));
  const t = only(calls(g, 'OneHotEncoder.transform'));

  it('a constructor box creates the instance; fit and one transform box (x2) sit inside it', () => {
    expect(inst.className).toBe('OneHotEncoder');
    expect(inst.varName).toBe('enc');
    expect(inst.params).toEqual([{ name: 'handle_unknown', text: '"ignore"' }]);
    expect(ctor.parent).toBeNull();
    expect(ctor.inPorts.map((p) => p.constText)).toEqual(['handle_unknown = "ignore"']);
    expect(inst.createdBy).toBe(ctor.id);
    expect(edgesInto(g, inst).map((e) => [e.from.node, e.from.port])).toEqual([[ctor.id, 'out:0']]);
    expect(t.executions.map((x) => x.count)).toEqual([1, 2]);
    for (const c of [fit, t]) expect(c.parent).toBe(inst.id);
  });

  it('fit mutates the encoder and has no output wire', () => {
    expect(fit.outPorts).toEqual([]);
    expect(edgesOutOf(g, fit)).toEqual([]);
    expect(inst.versions.map((v) => v.i)).toContain(fit.executions[0]?.i);
  });

  it('the shared transform box switches its wires per execution; outputs are sparse', () => {
    const [e1, e2] = edgesInto(g, t, 'in:X') as [GEdge, GEdge];
    expect(edgesInto(g, t, 'in:X')).toHaveLength(2);
    const xTrain = boxFrom(g, split, 'out:0');
    const xTest = boxFrom(g, split, 'out:1');
    expect([e1.from, e1.uses.map((u) => u.i)]).toEqual([
      { node: xTrain.id, port: null },
      [t.executions[0]?.i],
    ]);
    expect([e2.from, e2.uses.map((u) => u.i)]).toEqual([
      { node: xTest.id, port: null },
      [t.executions[1]?.i],
    ]);
    expect(only(edgesInto(g, fit, 'in:X')).from.node).toBe(xTrain.id);
    // the out-port carries the latest name; each execution's output is its own box
    expect(t.outPorts.map((p) => [p.typeLabel, p.nameLabel])).toEqual([['', 'test_enc']]);
    expect(instances(g, 'sparse').map((b) => [b.varName, b.createdBy, b.versions.length])).toEqual([
      ['train_enc', t.id, 1],
      ['test_enc', t.id, 1],
    ]);
  });
});

describe('golden_linreg', () => {
  const g = graphOf('golden_linreg');
  const inst = only(instances(g, 'LinearRegression'));
  const split = only(calls(g, 'train_test_split'));
  const fit = only(calls(g, 'LinearRegression.fit'));
  const predict = only(calls(g, 'LinearRegression.predict'));
  const score = only(calls(g, 'LinearRegression.score'));

  it('has one LinearRegression instance with fit, predict and score inside it', () => {
    expect(inst.className).toBe('LinearRegression');
    expect(inst.varName).toBe('model');
    for (const c of [fit, predict, score]) expect(c.parent).toBe(inst.id);
  });

  it('the LinearRegression() box creates the instance; the method slots are uncalled from that step', () => {
    const ctor = only(calls(g, 'LinearRegression'));
    expect(inst.createdBy).toBe(ctor.id);
    expect(edgesInto(g, inst).map((e) => [e.from.node, e.from.port])).toEqual([[ctor.id, 'out:0']]);
    const log = readLog('golden_linreg');
    const atCtor = stateAt(g, log, stepOfEvent(g, ctor.executions[0]!.i)!);
    expect(atCtor.currentNode).toBe(ctor.id);
    for (const c of [fit, predict, score]) {
      expect(atCtor.visibleNodes.has(c.id), c.name).toBe(true);
      expect(atCtor.uncalled.has(c.id), c.name).toBe(true);
    }
    const atFit = stateAt(g, log, stepOfEvent(g, fit.executions[0]!.i)!);
    expect(atFit.uncalled.has(fit.id)).toBe(false);
    expect(atFit.uncalled.has(predict.id)).toBe(true);
    expect(stateAt(g, log, g.steps.length).uncalled.size).toBe(0);
  });

  it('fit mutates the model, has no output wire, and gets X_train and y_train only', () => {
    expect(fit.outPorts).toEqual([]);
    expect(edgesOutOf(g, fit)).toEqual([]);
    expect(inst.versions.map((v) => v.i)).toContain(fit.executions[0]?.i);
    expect(edgesInto(g, fit).map((e) => [e.from.node, e.to.port, e.nameLabel])).toEqual([
      [boxFrom(g, split, 'out:0').id, 'in:X', null],
      [boxFrom(g, split, 'out:2').id, 'in:y', null],
    ]);
  });

  it('predict creates the pred box; score gives a scalar; both are fed from the test boxes', () => {
    expect(predict.outPorts.map((p) => [p.typeLabel, p.nameLabel])).toEqual([['', 'pred']]);
    expect(boxFrom(g, predict, 'out:0')).toMatchObject({ className: 'array', varName: 'pred' });
    expect(score.outPorts.map((p) => [p.typeLabel, p.nameLabel])).toEqual([['float', 'r2']]);
    const xTest = boxFrom(g, split, 'out:1');
    const yTest = boxFrom(g, split, 'out:3');
    expect(edgesInto(g, predict).map((e) => e.from.node)).toEqual([xTest.id]);
    expect(edgesInto(g, score).map((e) => e.from.node)).toEqual([xTest.id, yTest.id]);
  });
});

describe('edge cases on real logs', () => {
  it('chained fit(...).predict(...) draws both on the same instance; fit has no out wire', () => {
    const g = graphOf('edge_fit_chain');
    const inst = only(instances(g, 'LinearRegression'));
    const fit = only(calls(g, 'LinearRegression.fit'));
    expect(fit.parent).toBe(inst.id);
    expect(only(calls(g, 'LinearRegression.predict')).parent).toBe(inst.id);
    expect(fit.outPorts).toEqual([]);
  });

  it('a data method sits in its DataFrame box; in-place mutation is a new version of that box', () => {
    const g = graphOf('edge_inplace');
    const df = only(instances(g, 'DF'));
    const dropna = only(calls(g, 'DataFrame.dropna'));
    const sort = only(calls(g, 'DataFrame.sort_values'));
    for (const c of [dropna, sort]) {
      expect(c.parent).toBe(df.id);
      expect(c.inPorts.map((p) => p.id)).not.toContain('in:self'); // the owner is the box
      expect(c.outPorts).toEqual([]); // no out:mut wire: the box gets a version instead
      expect(edgesOutOf(g, c)).toEqual([]);
    }
    expect(df.versions.map((v) => v.i)).toEqual(
      expect.arrayContaining([dropna.executions[0]!.i, sort.executions[0]!.i]),
    );
    expect(df.versions.length).toBe(3);
    // stepping: the box is there from read_csv; each in-place method moves it to its next version
    const log = readLog('edge_inplace');
    const at = (c: CallNode): Token | undefined =>
      stateAt(g, log, stepOfEvent(g, c.executions[0]!.i)!).activeVersion.get(df.id);
    expect(at(dropna)).toBe(df.versions[1]!.token);
    expect(at(sort)).toBe(df.versions[2]!.token);
    expect(at(dropna)).not.toBe(df.versions[0]!.token);
    // the version tokens keep the object (one box, never two)
    expect(new Set(df.versions.map((v) => keyOf(v.token))).size).toBe(1);
  });

  it('a loop merges into one box per site and one instance, with the counts kept', () => {
    const g = graphOf('edge_loop');
    const fit = only(calls(g, 'Ridge.fit'));
    expect(fit.executions.length).toBeGreaterThan(20);
    expect(fit.executions.at(-1)?.count).toBe(30);
    expect(instances(g, 'Ridge')).toHaveLength(1);
    expect(instances(g, 'Ridge')[0]?.varName).toBe('model'); // the loop's objects share the box and the name
  });

  it('models["rf"].fit is drawn on the right instance only', () => {
    const g = graphOf('edge_dict_models');
    const rf = only(instances(g, 'RandomForestRegressor'));
    expect(only(calls(g, 'RandomForestRegressor.fit')).parent).toBe(rf.id);
    expect(calls(g, 'Ridge.fit')).toEqual([]);
  });

  it('GridSearchCV leaves the original estimator unfitted and wires it into the search', () => {
    const g = graphOf('edge_gridsearch');
    const ridge = only(instances(g, 'Ridge'));
    const search = only(instances(g, 'GridSearchCV'));
    expect(ridge.versions).toHaveLength(1);
    const ctor = only(calls(g, 'GridSearchCV'));
    expect(g.edges.some((e) => e.from.node === ridge.id && e.to.node === ctor.id)).toBe(true);
    expect(g.edges.some((e) => e.from.node === ctor.id && e.to.node === search.id)).toBe(true);
  });

  it('errors ride on the execution, handled or not', () => {
    const bad = only(calls(graphOf('edge_error'), 'LinearRegression.fit'));
    expect(bad.executions[0]?.error).toMatchObject({ type: 'ValueError', handled: false });
    // two call sites of one method share one box; each execution keeps its own error
    const fit = only(calls(graphOf('edge_handled'), 'LinearRegression.fit'));
    expect(fit.executions.map((x) => x.error?.handled ?? null)).toEqual([true, null]);
    expect(fit.executions.map((x) => x.count)).toEqual([1, 2]);
  });

  it('a student function is a student box and a student class instance is an instance node', () => {
    const g = graphOf('edge_student_fn');
    expect(only(calls(g, 'load')).student).toBe(true);
    expect(only(instances(g, 'Pipeline')).className).toBe('Pipeline');
  });

  it('an attribute read of a machine is an expr node wired from the machine', () => {
    const g = graphOf('edge_expr');
    expect(g.nodes.some((x) => x.kind === 'source' && x.label === 'coefs')).toBe(false);
    const x = only(g.nodes.filter((n) => n.kind === 'expr' && n.text === 'model.coef_'));
    const into = g.edges.filter((e) => e.to.node === x.id);
    expect(into).toHaveLength(1);
    expect(into[0]?.dashed).toBe(true);
    expect(into[0]?.from.node).toBe(only(instances(g, 'LinearRegression')).id);
    // the expression's result is the coefs box
    const out = only(edgesOutOf(g, x));
    expect(g.nodes.find((n) => n.id === out.to.node)).toMatchObject({
      kind: 'instance',
      className: 'array',
      varName: 'coefs',
    });
  });

  it('programs that record nothing give an empty graph', () => {
    for (const n of ['edge_input', 'edge_syntax']) {
      const g = graphOf(n);
      expect(g.nodes).toEqual([]);
      expect(g.steps).toEqual([]);
    }
  });
});
