import type { EventLog, GraphModel } from '@machines/log';
import { describe, expect, it } from 'vitest';
import { chipTarget, dotState, railCell, stepsByLine } from './rail';
import { stepForKey } from './steps';

const log = {
  sites: [{ line: 3 }, { line: 5 }, { line: 5 }],
  events: [
    { i: 0, site: 0 },
    { i: 1, site: 1 },
    { i: 2, site: 2 },
    { i: 3, site: 1 },
    { i: 4, site: 0 },
  ],
} as unknown as EventLog;
// event 2 is not a step
const model = { nodes: [], edges: [], steps: [0, 1, 3, 4] } as unknown as GraphModel;

describe('stepsByLine', () => {
  it('maps lines to 1-based steps in time order, loops repeating', () => {
    expect([...stepsByLine(model, log)]).toEqual([
      [3, [1, 4]],
      [5, [2, 3]],
    ]);
  });
});

describe('railCell', () => {
  it('shows a dot per execution with ran/current/pending states', () => {
    expect(railCell([1, 4], 1)).toEqual({
      mode: 'dots',
      dots: [
        { step: 1, state: 'current' },
        { step: 4, state: 'pending' },
      ],
    });
    expect(dotState(1, 2)).toBe('ran');
  });
  it('collapses past 8 executions and reports k of n only when current', () => {
    const steps = Array.from({ length: 30 }, (_, i) => i * 2 + 1);
    expect(railCell(steps.slice(0, 8), 0).mode).toBe('dots');
    expect(railCell(steps, 2)).toEqual({ mode: 'chip', n: 30, k: null });
    expect(railCell(steps, 7)).toEqual({ mode: 'chip', n: 30, k: 4 });
  });
  it('chip click goes to the next execution, wrapping', () => {
    expect(chipTarget([1, 5, 9], 5)).toBe(9);
    expect(chipTarget([1, 5, 9], 9)).toBe(1);
    expect(chipTarget([], 3)).toBeNull();
  });
});

describe('rail keys', () => {
  it('Down and j go later, Up and k earlier, Home/End jump, clamped', () => {
    const k = (key: string, step: number) => stepForKey({ key }, step, 10, { rail: true });
    expect(k('ArrowDown', 3)).toBe(4);
    expect(k('j', 3)).toBe(4);
    expect(k('ArrowUp', 3)).toBe(2);
    expect(k('k', 0)).toBe(0);
    expect(k('Home', 5)).toBe(0);
    expect(k('End', 5)).toBe(10);
    expect(k('x', 5)).toBeNull();
  });
});
