import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildGraph, keyOf } from './graph';
import type { InstanceNode } from './graph';
import { lineStageAt, shelfAt, shelfOrder, stageAt } from './stage';
import type { EventLog } from './types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'logs');
const names = readdirSync(ROOT)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort();
const readLog = (n: string): EventLog =>
  JSON.parse(readFileSync(join(ROOT, `${n}.json`), 'utf8')) as EventLog;

/** One line per step, for snapshots and the PR body. `*` marks an object changed in place. */
function compact(n: string): string[] {
  const log = readLog(n);
  const g = buildGraph(log);
  const lines: string[] = [];
  for (let s = 0; s <= g.steps.length; s++) {
    const st = stageAt(g, log, s);
    if (!st) {
      lines.push(`${s}: -`);
      continue;
    }
    const name = (id: string): string => {
      const x = g.nodes.find((y) => y.id === id);
      return x?.kind === 'instance'
        ? `${x.varName ?? x.className}`
        : x?.kind === 'import'
          ? `import ${x.name}`
          : x?.kind === 'def'
            ? `${x.defKind === 'class' ? 'class' : 'def'} ${x.name}`
            : id;
    };
    const ps = st.participants.map(
      (p) =>
        `${p.role}:${p.kind === 'chip' ? `chip(${p.chip!.type})` : name(p.node)}${p.port ? `@${p.port}` : ''}${p.changed ? '*' : ''}`,
    );
    const vs = st.values.map((v) => `${v.role}:${v.param}=${v.text ?? '?'}`);
    const nd = g.nodes.find((x) => x.id === st.node)!;
    const label =
      nd.kind === 'call'
        ? nd.name
        : nd.kind === 'import'
          ? `import ${nd.name}`
          : nd.kind === 'def'
            ? `${nd.defKind === 'class' ? 'class' : 'def'} ${nd.name}`
            : nd.kind;
    lines.push(
      `${s}: L${st.line} ${label} [${ps.join(' ')}]${vs.length ? ` {${vs.join(' ')}}` : ''}`,
    );
  }
  return lines;
}

describe('stageAt and shelfOrder on the golden fixtures', () => {
  for (const n of names) {
    test(n, () => {
      const log = readLog(n);
      const g = buildGraph(log);
      expect(stageAt(g, log, 0)).toBeNull();
      const shelf = shelfOrder(g);
      // creation order, every instance and import once
      expect(shelf.map((e) => e.at)).toEqual([...shelf.map((e) => e.at)].sort((a, b) => a - b));
      expect(new Set(shelf.map((e) => e.node)).size).toBe(shelf.length);
      expect(shelf.length).toBe(
        g.nodes.filter((x) => x.kind === 'instance' || x.kind === 'import' || x.kind === 'def')
          .length,
      );
      const byId = new Map(g.nodes.map((x) => [x.id, x]));
      for (let s = 1; s <= g.steps.length; s++) {
        const st = stageAt(g, log, s);
        if (!st) continue;
        expect(st.i).toBe(g.steps[s - 1]);
        for (const p of st.participants) {
          if (p.kind === 'chip') {
            expect(byId.has(p.node), 'a chip has no box').toBe(false);
            expect(p.edge).not.toBeNull();
            continue;
          }
          expect(byId.get(p.node)?.kind).toBe(p.kind);
          if (p.kind === 'import' || p.kind === 'def') continue;
          // no false participants: the object really is one of the event's own tokens
          const ex = st.execution;
          if (ex) {
            const toks = [ex.owner, ...Object.values(ex.inputs), ...Object.values(ex.outputs)];
            expect(toks.some((t) => t !== null && keyOf(t) === p.object)).toBe(true);
          }
          if (p.edge) expect(g.edges.some((e) => e.id === p.edge)).toBe(true);
        }
        const keys = st.participants.map((p) => `${p.role}/${p.node}/${p.object}/${p.param}`);
        expect(new Set(keys).size).toBe(keys.length);
      }
      expect(compact(n)).toMatchSnapshot();
      expect(shelf.map((e) => [e.kind, e.node, e.at, e.objects])).toMatchSnapshot();
    });
  }
});

describe('golden_linreg, hand-checked', () => {
  test('every step', () => {
    // Checked by hand against fixtures/programs/golden_linreg.py.
    expect(compact('golden_linreg')).toEqual([
      '0: -',
      '1: L4 import pd [created:import pd]',
      '2: L5 import LinearRegression [created:import LinearRegression]',
      '3: L6 import train_test_split [created:import train_test_split]',
      // read_csv's result is an unnamed temporary: a chip, not a shelf object
      '4: L8 read_csv [callee:import pd output:chip(DF)@out:0] {input:filepath_or_buffer="listings.csv"}',
      '5: L8 DataFrame.dropna [input:chip(DF)@in:self created:df@out:0]',
      '6: L9 expr [input:df created:X]',
      '7: L10 expr [input:df created:y]',
      '8: L11 train_test_split [callee:import train_test_split input:X@in:arrays[0] input:y@in:arrays[1] created:X_train@out:0 created:X_test@out:1 created:y_train@out:2 created:y_test@out:3] {input:test_size=0.2 input:random_state=0}',
      '9: L12 LinearRegression [callee:import LinearRegression created:model@out:0]',
      '10: L13 LinearRegression.fit [owner:model* input:X_train@in:X input:y_train@in:y]',
      '11: L14 LinearRegression.predict [owner:model input:X_test@in:X created:pred@out:0]',
      '12: L15 LinearRegression.score [owner:model input:X_test@in:X input:y_test@in:y] {output:0=0.4162894314248661}',
    ]);
  });

  test('shelf order: imports, then objects in creation order', () => {
    const log = readLog('golden_linreg');
    const g = buildGraph(log);
    const label = (id: string): string => {
      const x = g.nodes.find((y) => y.id === id)!;
      return x.kind === 'instance' ? (x.varName ?? x.className) : x.kind === 'import' ? x.name : id;
    };
    expect(shelfOrder(g).map((e) => label(e.node))).toEqual([
      'pd',
      'LinearRegression',
      'train_test_split',
      'df',
      'X',
      'y',
      'X_train',
      'X_test',
      'y_train',
      'y_test',
      'model',
      'pred',
    ]);
  });
});

describe('review fixes (svl-61q.1)', () => {
  const stages = (n: string) => {
    const log = readLog(n);
    const g = buildGraph(log);
    return { log, g, all: g.steps.map((_, k) => stageAt(g, log, k + 1)!) };
  };

  test('a store lists the written object once, keyed on object, with before and after', () => {
    for (const n of names) {
      for (const st of stages(n).all) {
        if (st.kind !== 'store' && st.kind !== 'expr') continue;
        const objs = st.participants.map((p) => p.object);
        expect(new Set(objs).size, `${n} step ${st.i}`).toBe(objs.length);
      }
    }
    const { all } = stages('edge_store');
    const stores = all.filter((s) => s.kind === 'store');
    expect(stores.length).toBeGreaterThan(1);
    const first = stores[0]!;
    expect(first.participants).toHaveLength(1);
    const p = first.participants[0]!;
    expect([p.role, p.changed, p.token, p.after]).toEqual(['output', true, 'v0.0', 'v0.1']);
    // `mask` is a different object: it stays an input next to the written df
    expect(stores[1]!.participants.map((x) => [x.role, x.changed])).toEqual([
      ['input', false],
      ['output', true],
    ]);
  });

  test('a failed call says so and keeps changed', () => {
    const { all } = stages('edge_error');
    const failed = all.filter((s) => s.failed);
    expect(failed.length).toBeGreaterThan(0);
    for (const s of failed) expect(s.error).not.toBeNull();
    expect(failed.some((s) => s.participants.some((p) => p.changed))).toBe(true);
    expect(all.filter((s) => !s.failed).every((s) => s.error === null)).toBe(true);
  });

  test('shelfAt on edge_loop: one Ridge box filling up; later passes are not new boxes', () => {
    const { g, all } = stages('edge_loop');
    const ridge = g.nodes.find(
      (x): x is InstanceNode => x.kind === 'instance' && x.className === 'Ridge',
    )!;
    const ctors = all.filter((s) =>
      s.participants.some((p) => p.node === ridge.id && p.role === 'created'),
    );
    expect(ctors.length).toBeGreaterThan(2);
    expect(ctors.map((s) => s.participants.find((p) => p.role === 'created')!.newBox)).toEqual(
      ctors.map((_, k) => k === 0),
    );
    // while the constructor runs, the object is on the stage: not yet filled
    ctors.forEach((s, k) => {
      const slot = shelfAt(g, g.steps.indexOf(s.i) + 1).find((e) => e.node === ridge.id);
      expect(slot?.filled).toBe(k === 0 ? undefined : k);
    });
    const end = shelfAt(g, g.steps.length);
    expect(end.find((e) => e.node === ridge.id)?.filled).toBe(
      ridge.versions.filter((v) => v.kind === 'new').length,
    );
    expect(end.map((e) => e.node)).toEqual(shelfOrder(g).map((e) => e.node));
    expect(shelfAt(g, 0)).toEqual([]);
    const order = shelfOrder(g).map((e) => e.node);
    for (let s = 0; s <= g.steps.length; s++) {
      const at = shelfAt(g, s).map((e) => e.node);
      expect(at).toEqual(order.slice(0, at.length));
    }
  });

  test('dropped is 0 on whole graphs and counts cut participants on a truncated one', () => {
    for (const n of names) {
      const { g, all } = stages(n);
      if (g.tooMany === undefined)
        for (const s of all)
          expect(s.dropped, `${n} ${s.i} ${JSON.stringify(s.participants)}`).toBe(0);
    }
    const log = readLog('large_pandas');
    const g = buildGraph(log, { maxNodes: 40 });
    expect(g.tooMany).toBeDefined();
    let dropped = 0;
    for (let s = 1; s <= g.steps.length; s++) dropped += stageAt(g, log, s)?.dropped ?? 0;
    expect(dropped).toBeGreaterThan(0);
  });
});

describe('edge_student_fn: def and class steps and their callees (svl-jl3)', () => {
  test('every step', () => {
    // Checked by hand against fixtures/programs/edge_student_fn.py: load and Pipeline are linked to
    // their def steps; pipe.run is a method (its owner is pipe), so it gets no callee.
    const lines = compact('edge_student_fn').filter((l) => !l.includes('import'));
    expect(lines[0]).toBe('0: -');
    expect(lines[1]).toMatch(/^\d+: L\d+ def load \[created:def load\]$/);
    expect(lines[2]).toMatch(/^\d+: L\d+ class Pipeline \[created:class Pipeline\]$/);
    expect(lines[3]).toMatch(/ load \[callee:def load /);
    expect(lines[4]).toMatch(/ Pipeline \[callee:class Pipeline created:pipe@out:0\]/);
    expect(lines[5]).toMatch(/ Pipeline\.run \[owner:pipe /);
    expect(lines.some((l) => l.includes('callee:') && l.includes('run'))).toBe(false);
  });
});

describe('lineStageAt: line groups (svl-qol)', () => {
  for (const n of names) {
    test(`${n}: groups are runs of steps on overlapping lines; calls keep their own stages`, () => {
      const log = readLog(n);
      const g = buildGraph(log);
      const byI = new Map(log.events.map((e) => [e.i, e]));
      expect(lineStageAt(g, log, 0)).toBeNull();
      let prevFirst = 0;
      for (let s = 1; s <= g.steps.length; s++) {
        const ls = lineStageAt(g, log, s);
        const st = stageAt(g, log, s);
        expect(ls === null).toBe(st === null);
        if (!ls || !st) continue;
        // the last call is the step itself; earlier calls are earlier steps of the same group, in order
        expect(ls.current).toBe(ls.calls[ls.calls.length - 1]!.stage);
        expect(ls.calls[ls.calls.length - 1]!.current).toBe(true);
        expect(ls.calls.filter((c) => c.current)).toHaveLength(1);
        expect(ls.calls.map((c) => c.step)).toEqual(
          ls.calls.map((_, k) => ls.first + k).slice(0, ls.calls.length),
        );
        expect(ls.first).toBeLessThanOrEqual(s);
        expect(ls.first).toBeGreaterThanOrEqual(prevFirst);
        prevFirst = ls.first;
        // every call of a group lies in lines that overlap the current one's, and no box runs twice
        const lines = ls.calls.map((c) => {
          const site = log.sites[byI.get(g.steps[c.step - 1]!)!.site]!;
          return [site.line, site.end_line] as const;
        });
        const lo = Math.min(...lines.map((l) => l[0]));
        const hi = Math.max(...lines.map((l) => l[1]));
        for (const [a, b] of lines) expect(a <= hi && b >= lo).toBe(true);
        if (ls.calls.length > 1) {
          expect(new Set(ls.calls.map((c) => c.stage.node)).size).toBe(ls.calls.length);
          for (const c of ls.calls) expect(['call', 'expr', 'store']).toContain(c.stage.kind);
        }
        // each object once, and only objects some call's own stage lists
        expect(new Set(ls.objects.map((o) => o.key)).size).toBe(ls.objects.length);
        const uses = ls.objects.reduce((a, o) => a + o.uses.length, 0);
        expect(uses).toBe(ls.calls.reduce((a, c) => a + c.stage.participants.length, 0));
        // a group is the same from any of its steps
        const again = lineStageAt(g, log, ls.first);
        expect(again!.calls).toHaveLength(1);
        expect(again!.first).toBe(ls.first);
      }
    });
  }

  test('golden_linreg: read_csv and dropna share a line, and the chip is one object', () => {
    const log = readLog('golden_linreg');
    const g = buildGraph(log);
    const name = (s: number): string => {
      const n = g.nodes.find((x) => x.id === stageAt(g, log, s)?.node);
      return n && n.kind === 'call' ? n.name : '';
    };
    const read = [...g.steps.keys()].map((k) => k + 1).find((s) => name(s) === 'read_csv')!;
    const drop = [...g.steps.keys()].map((k) => k + 1).find((s) => name(s) === 'DataFrame.dropna')!;
    expect(drop).toBe(read + 1);
    const a = lineStageAt(g, log, read)!;
    expect(a.calls).toHaveLength(1);
    const b = lineStageAt(g, log, drop)!;
    expect(b.first).toBe(read);
    expect(b.calls.map((c) => c.current)).toEqual([false, true]);
    const chip = b.objects.find((o) => o.kind === 'chip')!;
    expect(chip.uses.map((u) => [u.call, u.role])).toEqual([
      [0, 'output'],
      [1, 'input'],
    ]);
    // the next line starts a new group
    const next = lineStageAt(g, log, drop + 1)!;
    expect(next.first).toBe(drop + 1);
    expect(next.calls).toHaveLength(1);
  });

  test('loops: a second pass over the same line is a new group', () => {
    let seen = 0;
    for (const n of names) {
      const log = readLog(n);
      const g = buildGraph(log);
      for (let s = 2; s <= g.steps.length; s++) {
        const a = stageAt(g, log, s - 1);
        const b = stageAt(g, log, s);
        if (a && b && a.node === b.node) {
          seen++;
          expect(lineStageAt(g, log, s)!.first).toBe(s);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
