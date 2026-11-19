import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildGraph, keyOf } from './graph';
import { shelfOrder, stageAt } from './stage';
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
          : id;
    };
    const ps = st.participants.map(
      (p) =>
        `${p.role}:${p.kind === 'chip' ? `chip(${p.chip!.type})` : name(p.node)}${p.port ? `@${p.port}` : ''}${p.changed ? '*' : ''}`,
    );
    const vs = st.values.map((v) => `${v.role}:${v.param}=${v.text ?? '?'}`);
    const nd = g.nodes.find((x) => x.id === st.node)!;
    const label =
      nd.kind === 'call' ? nd.name : nd.kind === 'import' ? `import ${nd.name}` : nd.kind;
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
        g.nodes.filter((x) => x.kind === 'instance' || x.kind === 'import').length,
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
          if (p.kind === 'import') continue;
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
      '4: L8 read_csv [output:chip(DF)@out:0] {input:filepath_or_buffer="listings.csv"}',
      '5: L8 DataFrame.dropna [input:chip(DF)@in:self created:df@out:0]',
      '6: L9 expr [input:df created:X]',
      '7: L10 expr [input:df created:y]',
      '8: L11 train_test_split [input:X@in:arrays[0] input:y@in:arrays[1] created:X_train@out:0 created:X_test@out:1 created:y_train@out:2 created:y_test@out:3] {input:test_size=0.2 input:random_state=0}',
      '9: L12 LinearRegression [created:model@out:0]',
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
