import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, type EventLog } from '@machines/log';
import { describe, expect, it } from 'vitest';
import { stepCounter } from './counter';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'logs',
);
const load = (n: string) => {
  const log = JSON.parse(readFileSync(join(ROOT, `${n}.json`), 'utf8')) as EventLog;
  return { log, model: buildGraph(log) };
};

describe('stepCounter', () => {
  it('has text for no steps and for the start', () => {
    expect(stepCounter(null, null, 0, 0).primary).toBe('No steps');
    const { log, model } = load('golden_linreg');
    const max = model.steps.length;
    const c = stepCounter(model, log, 0, max);
    expect(c.primary).toBe('Start');
    expect(c.spoken).toBe(`Start, step 0 of ${max}`);
  });

  it('counts inside the line group and keeps the overall step secondary', () => {
    const { log, model } = load('edge_line_calls');
    const max = model.steps.length;
    const all = Array.from({ length: max }, (_, k) => stepCounter(model, log, k + 1, max));
    const multi = all.filter((c) => c.lineTotal > 1);
    expect(multi.length).toBeGreaterThan(1);
    for (const [k, c] of all.entries()) {
      expect(c.overall).toBe(`${k + 1}/${max}`);
      expect(c.spoken).toContain(`step ${k + 1} of ${max}`);
      expect(c.inLine).toBeLessThanOrEqual(c.lineTotal);
      if (c.lineTotal > 1) expect(c.primary).toMatch(/^Line \d+ · (call|step) \d+ of \d+$/);
      else expect(c.primary).toMatch(/^(Line \d+|Step \d+)$/);
    }
    // within a group the total is constant and the index climbs by one
    const first = multi[0]!;
    const i = all.indexOf(first);
    expect(first.inLine).toBe(1);
    expect(all[i + 1]!.inLine).toBe(2);
    expect(all[i + 1]!.lineTotal).toBe(first.lineTotal);
    expect(all[i + first.lineTotal - 1]!.inLine).toBe(first.lineTotal);
  });

  it('reads "call" when every step of the line is a call', () => {
    const { log, model } = load('edge_line_calls');
    const max = model.steps.length;
    const texts = Array.from(
      { length: max },
      (_, k) => stepCounter(model, log, k + 1, max).primary,
    );
    expect(texts.some((t) => / · call \d+ of \d+$/.test(t))).toBe(true);
  });
});
