import type { GraphModel } from '@machines/log';
import { describe, expect, test } from 'vitest';
import { Relayouter, layoutSignature, stickyTier } from './pipeline';

const model = (ids: string[], edgeIds: string[] = []): GraphModel =>
  ({
    nodes: ids.map((id, k) => ({
      id,
      kind: 'expr',
      parent: null,
      order: k,
      text: id,
      executions: [],
    })),
    edges: edgeIds.map((id, k) => ({
      id,
      from: { node: ids[k]!, port: null },
      to: { node: ids[k + 1]!, port: null },
      dashed: false,
      uses: [],
      nameLabel: null,
    })),
    steps: [],
  }) as unknown as GraphModel;

describe('layoutSignature', () => {
  test('changes with node ids, edges and attrRows, not with step data', () => {
    const a = model(['x', 'y'], ['e']);
    const base = layoutSignature(a, {}, {});
    expect(layoutSignature({ ...a, steps: [1, 2] }, {}, {})).toBe(base);
    expect(layoutSignature(model(['x', 'y', 'z'], ['e']), {}, {})).not.toBe(base);
    expect(layoutSignature(a, { x: ['n int'] }, {})).not.toBe(base);
    expect(layoutSignature(a, {}, { e: 'DataFrame' })).not.toBe(base);
  });
});

describe('stickyTier', () => {
  test('never goes back down', () => {
    expect(stickyTier(model(['a', 'b']), 1)).toBe(1);
    expect(stickyTier(model(['a', 'b']), 0)).toBe(0);
  });
});

function harness(intervalMs = 500) {
  let t = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const runs: { input: string; resolve(v: string): void }[] = [];
  const applied: string[] = [];
  const r = new Relayouter<string, string>({
    intervalMs,
    signature: (s) => s.split(':')[0]!,
    run: (input) => new Promise((resolve) => runs.push({ input, resolve })),
    apply: (input, out) => applied.push(`${input}=>${out}`),
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { at: t + ms, fn };
      timers.push(e);
      return e;
    },
    clearTimer: (e) => {
      const k = timers.indexOf(e as (typeof timers)[number]);
      if (k >= 0) timers.splice(k, 1);
    },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const e of timers.filter((x) => x.at <= t)) {
      timers.splice(timers.indexOf(e), 1);
      e.fn();
    }
  };
  const settle = () => new Promise((res) => setTimeout(res, 0));
  return { r, runs, applied, advance, settle, timers };
}

describe('Relayouter', () => {
  test('streams: one layout per interval, newest input wins', async () => {
    const h = harness();
    h.r.update('a:1', false);
    h.advance(0);
    expect(h.runs.map((x) => x.input)).toEqual(['a:1']);
    h.r.update('b:2', false);
    h.r.update('c:3', false);
    expect(h.runs).toHaveLength(1); // busy
    h.runs[0]!.resolve('L1');
    await h.settle();
    expect(h.applied).toEqual(['a:1=>L1']);
    h.advance(100);
    expect(h.runs).toHaveLength(1); // still inside the interval
    h.advance(400);
    expect(h.runs.map((x) => x.input)).toEqual(['a:1', 'c:3']);
  });
  test('final input is laid out at once and cancels the pending timer', async () => {
    const h = harness();
    h.r.update('a:1', false);
    h.advance(0);
    h.runs[0]!.resolve('L1');
    await h.settle();
    h.r.update('b:2', false);
    expect(h.timers).toHaveLength(1);
    h.r.update('b:2', true);
    expect(h.timers).toHaveLength(0);
    expect(h.runs.map((x) => x.input)).toEqual(['a:1', 'b:2']);
  });
  test('same signature is applied without a layout', async () => {
    const h = harness();
    h.r.update('a:1', true);
    h.runs[0]!.resolve('L1');
    await h.settle();
    h.r.update('a:2', true);
    expect(h.runs).toHaveLength(1);
    expect(h.applied).toEqual(['a:1=>L1', 'a:2=>L1']);
  });
  test('reset drops a layout in flight', async () => {
    const h = harness();
    h.r.update('a:1', true);
    h.r.reset();
    h.runs[0]!.resolve('L1');
    await h.settle();
    expect(h.applied).toEqual([]);
    h.r.update('a:1', true);
    expect(h.runs).toHaveLength(2); // the cache was forgotten too
  });
  test('errors go to onError and do not wedge the queue', async () => {
    let err: unknown = null;
    const r = new Relayouter<string, string>({
      intervalMs: 0,
      signature: (s) => s,
      run: () => Promise.reject(new Error('boom')),
      apply: () => {},
      onError: (e) => (err = e),
    });
    r.update('a', true);
    await new Promise((res) => setTimeout(res, 0));
    expect(err).toBeInstanceOf(Error);
    r.update('b', true); // not stuck busy
  });
});
