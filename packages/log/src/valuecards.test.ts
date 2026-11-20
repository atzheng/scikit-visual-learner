import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildGraph } from './graph';
import type { GraphModel } from './graph';
import { lineStageAt, shelfAt, shelfOrder, stageAt } from './stage';
import type { EventLog } from './types';
import { valueCards, valueNames } from './valuecards';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'logs');
const load = (n: string): { log: EventLog; g: GraphModel } => {
  const log = JSON.parse(readFileSync(join(ROOT, `${n}.json`), 'utf8')) as EventLog;
  return { log, g: buildGraph(log) };
};
const shelfNames = (g: GraphModel, log: EventLog, s: number): string[] =>
  shelfAt(g, s, log)
    .filter((e) => e.kind === 'value')
    .map(
      (e) =>
        `${valueNames(e.value!, s === g.steps.length ? null : g.steps[s - 1]!).join(',')}=${e.value!.text}`,
    );

describe('value cards (svl-o6m)', () => {
  test('golden_linreg: r2 is on the stage at its call, then on the shelf', () => {
    const { log, g } = load('golden_linreg');
    const last = g.steps.length;
    // the score call makes r2: it is an output on the stage, not yet on the shelf
    const st = stageAt(g, log, last)!;
    const out = st.participants.find((p) => p.kind === 'value')!;
    expect(out.role).toBe('output');
    expect(out.node).toBe('val:r2:0');
    expect(out.token).toBe('s13');
    expect(st.values).toEqual([]); // no inline duplicate
    expect(shelfNames(g, log, last - 1)).toEqual([]);
    // at the end of the run it is on the shelf with the instances
    const end = shelfAt(g, last, log);
    expect(end.at(-1)).toMatchObject({ kind: 'value', node: 'val:r2:0', filled: 1 });
    expect(end.at(-1)!.value!.text).toBe('0.4162894314248661');
    // without the log nothing changes: no value entries
    expect(shelfAt(g, last).some((e) => e.kind === 'value')).toBe(false);
  });

  test('step 0 is empty and shelfAt never lists a card before its event', () => {
    const { log, g } = load('edge_values');
    expect(shelfAt(g, 0, log)).toEqual([]);
    for (let s = 1; s < g.steps.length; s++)
      for (const e of shelfAt(g, s, log)) expect(e.at).toBeLessThan(g.steps[s - 1]!);
  });

  test('rebinding: a different value is a different card, never the same object', () => {
    const { log, g } = load('edge_values');
    const cards = shelfOrder(g, log).filter((e) => e.kind === 'value');
    // n = a.sum() (shared with m), n = a.max(), n += 1: three values, three cards, three ids and tokens
    const n = cards.filter((e) => e.value!.names[0]!.name === 'n');
    expect(n.map((e) => e.value!.text)).toEqual(['6', '3', '4']);
    expect(new Set(n.map((e) => e.node)).size).toBe(3);
    expect(new Set(n.map((e) => e.value!.token)).size).toBe(3);
    // n leaves the first card when rebound, but m still holds it: it stays until the end of the run
    expect(n.map((e) => e.value!.until)).toEqual([null, 4, null]);
    expect(n[0]!.value!.names).toEqual([
      { name: 'n', from: 2, until: 3 },
      { name: 'm', from: 2, until: null },
    ]);
    // at the end only the current cards are on the shelf, under the names that hold them now
    expect(shelfNames(g, log, g.steps.length).sort()).toEqual(['c=12', 'm=6', 'n=4', 'z=1']);
    // `n = a.max()` (event 3): n=6 and m=6 are one card on the shelf, the new n=3 is on the stage
    const s = g.steps.indexOf(3) + 1;
    expect(shelfNames(g, log, s)).toEqual(['n,m=6']);
    const st = stageAt(g, log, s)!;
    expect(
      st.participants.filter((p) => p.kind === 'value').map((p) => `${p.role}:${p.node}`),
    ).toEqual(['output:val:n:1']);
  });

  test('names that share a token share one card, listed as the line writes them', () => {
    const { log, g } = load('edge_values');
    const cards = valueCards(log);
    const c0 = cards.find((c) => c.id === 'val:n:0')!;
    expect(cards.filter((c) => c.token === c0.token)).toHaveLength(1);
    // `m = n` made no event: m joins at the latest event before the binding
    expect(c0.names[1]).toMatchObject({ name: 'm', from: 2 });
    // before the rebinding both names, after it only m
    expect(valueNames(c0, 2)).toEqual(['n']);
    expect(valueNames(c0, 3)).toEqual(['n', 'm']);
    expect(valueNames(c0, 5)).toEqual(['m']);
    expect(valueNames(c0, null)).toEqual(['m']);
    // the add call takes m, and the card says m, not n
    const add = log.events.find((e) => e.name === 'add')!;
    const st = stageAt(g, log, g.steps.indexOf(add.i) + 1)!;
    const ins = st.participants.filter((p) => p.kind === 'value' && p.role === 'input');
    expect(ins.map((p) => p.node)).toEqual(['val:n:0', 'val:n:0']);
    expect(valueNames(c0, add.i)).toEqual(['m']);
  });

  test('a name rebound to a function ends its card', () => {
    const { log, g } = load('edge_values');
    const k = valueCards(log).find((c) => c.name === 'k')!;
    expect(k.until).toBe(k.at); // `k = print` ran before the next step
    for (let s = 1; s <= g.steps.length; s++)
      expect(shelfNames(g, log, s).some((x) => x.startsWith('k='))).toBe(false);
    // at its own step it is the output of the mean call
    const st = stageAt(g, log, g.steps.indexOf(k.at) + 1)!;
    expect(st.participants.some((p) => p.node === k.id && p.role === 'output')).toBe(true);
  });

  test('a card passed to a call is an input on the stage, flown in from the shelf', () => {
    const { log, g } = load('edge_values');
    const add = log.events.find((e) => e.name === 'add')!;
    const s = g.steps.indexOf(add.i) + 1;
    const st = stageAt(g, log, s)!;
    const v = st.participants.filter((p) => p.kind === 'value');
    expect(v.map((p) => `${p.role}:${p.node}:${p.param}`)).toEqual([
      'input:val:n:0:x1',
      'input:val:n:0:x2',
      'output:val:c:0:0',
    ]);
    expect(shelfNames(g, log, s).sort()).toEqual(['m=6', 'n=4']);
  });

  test('volatile names get no card', () => {
    const { log } = load('edge_alias_volatile');
    const volatile = new Set(
      log.sites.filter((s) => s.kind === 'bind' && s.volatile).flatMap((s) => s.targets ?? []),
    );
    for (const c of valueCards(log)) expect(volatile.has(c.name)).toBe(false);
  });

  test('lineStageAt lists a value card once with its role', () => {
    const { log, g } = load('golden_linreg');
    const line = lineStageAt(g, log, g.steps.length)!;
    const v = line.objects.find((o) => o.kind === 'value')!;
    expect(v.node).toBe('val:r2:0');
    expect(v.uses).toEqual([{ call: 0, role: 'output' }]);
  });
});
