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
import type {
  CallNode,
  Execution,
  GEdge,
  GNode,
  GraphModel,
  ImportNode,
  InstanceNode,
} from './graph';
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

/**
 * A chip wire is exactly the two wires its object's box would have had, joined. The object is never bound to
 * a name, mutated or output twice, and has exactly one use in the whole log: the one the wire ends at.
 */
function checkChip(log: EventLog, g: GraphModel, ed: GEdge): void {
  const c = ed.chip!;
  const key = keyOf(c.token);
  expect(ed.uses, ed.id).toHaveLength(1);
  expect(ed.uses[0]!.token, ed.id).toBe(c.token);
  expect(
    g.nodes.some((x) => x.kind === 'instance' && x.versions.some((v) => keyOf(v.token) === key)),
    `${ed.id}: a chip's object has no box`,
  ).toBe(false);
  for (const sc of log.scopes)
    for (const [, name, t] of sc.bindings)
      expect(keyOf(t), `${ed.id} bound to ${name}`).not.toBe(key);
  const uses: number[] = [];
  let made = 0;
  for (const e of log.events) {
    for (const [b, a] of e.mutates) {
      expect(keyOf(b), ed.id).not.toBe(key);
      expect(keyOf(a), ed.id).not.toBe(key);
    }
    made += e.outputs.filter((t) => keyOf(t) === key).length;
    const owner = e.kind === 'method' && e.owner !== null && keyOf(e.owner) === key;
    for (const x of e.inputs)
      if (x.value !== undefined && keyOf(x.value) === key && !(owner && x.param === 'self'))
        uses.push(e.i);
    if (owner) uses.push(e.i);
  }
  expect(made, `${ed.id} output once`).toBe(1);
  expect(uses, `${ed.id} used once, by the consumer`).toEqual([ed.uses[0]!.i]);
}

describe('fixtures', () => {
  it('has the 28 programs', () => {
    expect(names.length).toBe(28);
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

    it.each([true, false])(
      'has no false wires, fold=%s: every use is backed by the log',
      (fold) => {
        const log = readLog(n);
        const g = buildGraph(log, { fold });
        if (!fold) expect(g.edges.some((x) => x.chip)).toBe(false);
        const byId = new Map(g.nodes.map((x) => [x.id, x]));
        const execsOf = (x: GNode | undefined): Execution[] =>
          x && (x.kind === 'call' || x.kind === 'expr' || x.kind === 'store') ? x.executions : [];
        for (const ed of g.edges) {
          const from = byId.get(ed.from.node);
          const to = byId.get(ed.to.node);
          expect(from, ed.id).toBeDefined();
          expect(to, ed.id).toBeDefined();
          expect(ed.uses.length, ed.id).toBeGreaterThan(0);
          if (ed.chip) checkChip(log, g, ed);
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
                  (port === null ? Object.values(x.outputs) : [x.outputs[port]]).includes(
                    u.token,
                  ) &&
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
      },
    );

    it('folding only removes unnamed one-use object boxes, and nothing else', () => {
      const log = readLog(n);
      const on = buildGraph(log);
      const off = buildGraph(log, { fold: false });
      const chips = on.edges.filter((x) => x.chip);
      expect(on.folded ?? 0).toBe(chips.length);
      if (off.tooMany !== undefined) return; // cut at the cap: the two forms keep different boxes
      const kept = new Set(on.nodes.map((x) => x.id));
      const dropped = off.nodes.filter((x) => !kept.has(x.id));
      expect(dropped.map((x) => x.id).sort()).toEqual(chips.map((x) => x.chip!.node).sort());
      for (const x of on.nodes)
        expect(
          off.nodes.some((y) => y.id === x.id),
          x.id,
        ).toBe(true);
    });

    it('import blocks: one per bound name of an import step, no wires, and a call names only a real import', () => {
      const log = readLog(n);
      const g = buildGraph(log);
      const byId = new Map(g.nodes.map((x) => [x.id, x]));
      for (const ed of g.edges) {
        expect(byId.get(ed.from.node)?.kind, ed.id).not.toBe('import');
        expect(byId.get(ed.to.node)?.kind, ed.id).not.toBe('import');
      }
      const imports = g.nodes.filter((x): x is ImportNode => x.kind === 'import');
      const ran = new Map<number, number[]>(); // import site -> steps
      for (const e of log.events)
        if (e.kind === 'import') ran.set(e.site, [...(ran.get(e.site) ?? []), e.i]);
      for (const imp of imports) {
        expect(
          imp.executions.map((x) => x.i),
          imp.id,
        ).toEqual(ran.get(imp.site));
        expect(
          log.sites[imp.site]!.imports?.some((b) => b.name === imp.name),
          imp.id,
        ).toBe(true);
      }
      // every bound name of every executed import statement has a block
      for (const [site] of ran)
        for (const b of log.sites[site]!.imports ?? [])
          expect(imports.some((x) => x.site === site && x.name === b.name)).toBe(true);
      // a call's `(module)` comes from a sole import of its root name that ran before it
      const evOf = new Map(log.events.map((e) => [e.i, e]));
      for (const c of g.nodes.filter((x): x is CallNode => x.kind === 'call')) {
        if (c.importedFrom === undefined) continue;
        const e = evOf.get(c.executions[0]!.i)!;
        const root = log.sites[e.site]!.func_text!.split('.')[0];
        const imp = imports.find((x) => x.name === root);
        expect(imp, `${c.id} (${c.importedFrom})`).toBeDefined();
        expect(log.sites[imp!.site]!.imports?.find((b) => b.name === root)?.sole).toBe(true);
        expect(Math.min(...imp!.executions.map((x) => x.i))).toBeLessThan(c.executions[0]!.i);
      }
    });

    it.each([true, false])(
      'every object is one box, fold=%s: no object token is a source, no object is in two boxes',
      (fold) => {
        const g = buildGraph(readLog(n), { fold });
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
      },
    );

    it('is deterministic and does not mutate the log', () => {
      const log = readLog(n);
      const before = JSON.stringify(log);
      expect(dumps(buildGraph(log))).toBe(dumps(buildGraph(log)));
      expect(dumps(buildGraph(log, { fold: false }))).toBe(dumps(buildGraph(log, { fold: false })));
      expect(JSON.stringify(log)).toBe(before);
    });
  });
});

// ---- slide-level structure of the three golden programs (explicit, not just snapshots)

const graphOf = (n: string): GraphModel => buildGraph(readLog(n), { fold: false });
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

  it('the three imports are the first three steps, each placing its object, before any call (svl-i6s)', () => {
    const log = readLog('golden_linreg');
    const imports = g.nodes.filter((x): x is ImportNode => x.kind === 'import');
    expect(imports.map((x) => [x.name, x.source])).toEqual([
      ['pd', 'pandas'],
      ['LinearRegression', 'sklearn.linear_model'],
      ['train_test_split', 'sklearn.model_selection'],
    ]);
    expect(g.steps.slice(0, 3)).toEqual(imports.map((x) => x.executions[0]!.i));
    const firstCall = Math.min(...[split, fit].map((c) => c.executions[0]!.i));
    expect(g.steps[2]!).toBeLessThan(firstCall);
    imports.forEach((imp, k) => {
      const st = stateAt(g, log, k + 1);
      expect(st.currentNode).toBe(imp.id);
      expect(st.current).toBe(imp.executions[0]!.i);
      // the block appears at its own step, not before, and the later ones are not there yet
      expect(st.visibleNodes.has(imp.id)).toBe(true);
      expect(imports.slice(k + 1).some((x) => st.visibleNodes.has(x.id))).toBe(false);
      expect(stateAt(g, log, k).visibleNodes.has(imp.id)).toBe(false);
      const site = log.sites[log.events.find((e) => e.i === st.current)!.site]!;
      expect(site.text).toMatch(/^(import|from) /);
    });
    expect(
      g.edges.some((e) => imports.some((x) => e.from.node === x.id || e.to.node === x.id)),
    ).toBe(false);
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
