// Golden tests over the real fixtures (CONTRACTS.md section 9): stream cross-check, graph snapshots,
// the no-false-wires invariant and the slide-level structure of the three golden programs.
// `UPDATE_GRAPHS=1` rewrites fixtures/graphs/*.json from fixtures/logs/*.json (`pnpm fixtures` does this).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAssembler } from './assemble';
import { buildGraph, keyOf } from './graph';
import type { CallNode, Execution, GEdge, GNode, GraphModel, InstanceNode } from './graph';
import type { FromWorker } from './messages';
import type { EventLog } from './types';
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
                x.ret < u.i,
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

describe('golden_split', () => {
  const g = graphOf('golden_split');
  const split = only(calls(g, 'train_test_split'));

  it('read_csv feeds dropna, which feeds the X and y expressions, which feed the split', () => {
    const readCsv = only(calls(g, 'read_csv'));
    const dropna = only(calls(g, 'DataFrame.dropna'));
    expect(edgesInto(g, dropna, 'in:self').map((e) => e.from.node)).toEqual([readCsv.id]);
    const xEdge = only(edgesInto(g, split, 'in:arrays[0]'));
    const yEdge = only(edgesInto(g, split, 'in:arrays[1]'));
    const x = upstream(g, xEdge);
    const y = upstream(g, yEdge);
    expect(x.kind === 'expr' && x.text).toBe('df[["beds", "baths", "sqft", "year_built"]]');
    expect(y.kind === 'expr' && y.text).toBe('df["price"]');
    expect([xEdge.dashed, yEdge.dashed]).toEqual([true, true]);
    expect([xEdge.nameLabel, yEdge.nameLabel]).toEqual(['X', 'y']);
    for (const ex of [x, y]) expect(edgesInto(g, ex).map((e) => e.from.node)).toEqual([dropna.id]);
  });

  it('test_size is a const port and the four outputs are named', () => {
    expect(split.inPorts.find((p) => p.id === 'in:test_size')?.constText).toBe('test_size = 0.2');
    expect(edgesInto(g, split, 'in:test_size')).toEqual([]);
    expect(split.outPorts.map((p) => p.nameLabel)).toEqual([
      'X_train',
      'X_test',
      'y_train',
      'y_test',
    ]);
    expect(split.outPorts.map((p) => p.typeLabel)).toEqual(['DF', 'DF', 'Series', 'Series']);
  });

  it('X_train and X_test are not wired to each other (nothing is drawn after the split)', () => {
    expect(edgesOutOf(g, split)).toEqual([]);
    expect(instances(g)).toEqual([]);
  });
});

describe('golden_onehot', () => {
  const g = graphOf('golden_onehot');
  const inst = only(instances(g));
  const split = only(calls(g, 'train_test_split'));
  const fit = only(calls(g, 'OneHotEncoder.fit'));
  const [t1, t2] = calls(g, 'OneHotEncoder.transform') as [CallNode, CallNode];

  it('has one OneHotEncoder instance with fit and two transform boxes inside it', () => {
    expect(inst.className).toBe('OneHotEncoder');
    expect(inst.varName).toBe('enc');
    expect(inst.params).toEqual([{ name: 'handle_unknown', text: '"ignore"' }]);
    expect(calls(g, 'OneHotEncoder.transform')).toHaveLength(2);
    expect(t1.id).not.toBe(t2.id);
    for (const c of [fit, t1, t2]) expect(c.parent).toBe(inst.id);
  });

  it('fit mutates the encoder and has no output wire', () => {
    expect(fit.outPorts).toEqual([]);
    expect(edgesOutOf(g, fit)).toEqual([]);
    expect(inst.versions.map((v) => v.i)).toContain(fit.executions[0]?.i);
  });

  it('wires train and test to the right boxes; outputs are sparse', () => {
    const e1 = only(edgesInto(g, t1, 'in:X'));
    const e2 = only(edgesInto(g, t2, 'in:X'));
    expect([e1.nameLabel, e1.from]).toEqual(['X_train', { node: split.id, port: 'out:0' }]);
    expect([e2.nameLabel, e2.from]).toEqual(['X_test', { node: split.id, port: 'out:1' }]);
    expect(only(edgesInto(g, fit, 'in:X')).nameLabel).toBe('X_train');
    expect(t1.outPorts.map((p) => [p.typeLabel, p.nameLabel])).toEqual([['sparse', 'train_enc']]);
    expect(t2.outPorts.map((p) => [p.typeLabel, p.nameLabel])).toEqual([['sparse', 'test_enc']]);
  });
});

describe('golden_linreg', () => {
  const g = graphOf('golden_linreg');
  const inst = only(instances(g));
  const split = only(calls(g, 'train_test_split'));
  const fit = only(calls(g, 'LinearRegression.fit'));
  const predict = only(calls(g, 'LinearRegression.predict'));
  const score = only(calls(g, 'LinearRegression.score'));

  it('has one LinearRegression instance with fit, predict and score inside it', () => {
    expect(inst.className).toBe('LinearRegression');
    expect(inst.varName).toBe('model');
    for (const c of [fit, predict, score]) expect(c.parent).toBe(inst.id);
  });

  it('fit mutates the model, has no output wire, and gets X_train and y_train only', () => {
    expect(fit.outPorts).toEqual([]);
    expect(edgesOutOf(g, fit)).toEqual([]);
    expect(inst.versions.map((v) => v.i)).toContain(fit.executions[0]?.i);
    expect(
      edgesInto(g, fit).map((e) => [e.from.node, e.from.port, e.to.port, e.nameLabel]),
    ).toEqual([
      [split.id, 'out:0', 'in:X', 'X_train'],
      [split.id, 'out:2', 'in:y', 'y_train'],
    ]);
  });

  it('predict gives an array and score a scalar output, both fed from the test split', () => {
    expect(predict.outPorts.map((p) => [p.typeLabel, p.nameLabel])).toEqual([['array', 'pred']]);
    expect(score.outPorts.map((p) => [p.typeLabel, p.nameLabel])).toEqual([['float', 'r2']]);
    expect(edgesInto(g, predict).map((e) => [e.from.port, e.nameLabel])).toEqual([
      ['out:1', 'X_test'],
    ]);
    expect(edgesInto(g, score).map((e) => [e.from.port, e.nameLabel])).toEqual([
      ['out:1', 'X_test'],
      ['out:3', 'y_test'],
    ]);
  });
});

describe('edge cases on real logs', () => {
  it('chained fit(...).predict(...) draws both on the same instance; fit has no out wire', () => {
    const g = graphOf('edge_fit_chain');
    const inst = only(instances(g));
    const fit = only(calls(g, 'LinearRegression.fit'));
    expect(fit.parent).toBe(inst.id);
    expect(only(calls(g, 'LinearRegression.predict')).parent).toBe(inst.id);
    expect(fit.outPorts).toEqual([]);
  });

  it('a data method has self as an in-port; in-place mutation is a changed-in-place out-port', () => {
    const g = graphOf('edge_inplace');
    const dropna = only(calls(g, 'DataFrame.dropna'));
    expect(dropna.inPorts.map((p) => p.id)).toContain('in:self');
    expect(dropna.outPorts.map((p) => [p.id, p.changedInPlace])).toEqual([['out:mut:self', true]]);
    const sort = only(calls(g, 'DataFrame.sort_values'));
    expect(only(edgesInto(g, sort, 'in:self')).from).toEqual({
      node: dropna.id,
      port: 'out:mut:self',
    });
  });

  it('a loop merges into one box per site and one instance, with the counts kept', () => {
    const g = graphOf('edge_loop');
    const fit = only(calls(g, 'Ridge.fit'));
    expect(fit.executions.length).toBeGreaterThan(20);
    expect(fit.executions.at(-1)?.count).toBe(30);
    expect(instances(g)).toHaveLength(1);
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
    expect(g.edges.some((e) => e.from.node === ridge.id && e.to.node === search.id)).toBe(true);
  });

  it('errors ride on the execution, handled or not', () => {
    const bad = only(calls(graphOf('edge_error'), 'LinearRegression.fit'));
    expect(bad.executions[0]?.error).toMatchObject({ type: 'ValueError', handled: false });
    const fits = calls(graphOf('edge_handled'), 'LinearRegression.fit');
    expect(fits).toHaveLength(2);
    expect(fits.map((c) => c.executions[0]?.error?.handled ?? null)).toEqual([true, null]);
  });

  it('a student function is a student box and a student class instance is an instance node', () => {
    const g = graphOf('edge_student_fn');
    expect(only(calls(g, 'load')).student).toBe(true);
    expect(only(instances(g)).className).toBe('Pipeline');
  });

  it('an attribute read of a machine is an expr node wired from the machine', () => {
    const g = graphOf('edge_expr');
    expect(g.nodes.some((x) => x.kind === 'source' && x.label === 'coefs')).toBe(false);
    const x = only(g.nodes.filter((n) => n.kind === 'expr' && n.text === 'model.coef_'));
    const into = g.edges.filter((e) => e.to.node === x.id);
    expect(into).toHaveLength(1);
    expect(into[0]?.dashed).toBe(true);
    expect(g.edges.some((e) => e.from.node === x.id && e.nameLabel === 'coefs')).toBe(true);
  });

  it('programs that record nothing give an empty graph', () => {
    for (const n of ['edge_input', 'edge_syntax']) {
      const g = graphOf(n);
      expect(g.nodes).toEqual([]);
      expect(g.steps).toEqual([]);
    }
  });
});
