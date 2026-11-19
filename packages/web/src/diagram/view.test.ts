import type { StagePlan } from '@machines/render';
import { describe, expect, it } from 'vitest';
import { distToPolyline, nearestWire, readView, writeView } from './view';

const wire = (edge: string | null, points: [number, number][]) => ({
  edge,
  from: '',
  to: '',
  points,
  arrow: true,
  label: null,
});
const plan = {
  wires: [
    wire('a', [
      [0, 0],
      [0, 100],
    ]),
    wire(null, [
      [50, 0],
      [50, 100],
    ]),
    wire('b', [
      [100, 0],
      [100, 50],
      [200, 50],
    ]),
  ],
} as unknown as StagePlan;

describe('nearestWire', () => {
  it('finds a wire within the tolerance and ignores the owner line', () => {
    expect(nearestWire(plan, 3, 40)?.edge).toBe('a');
    expect(nearestWire(plan, 50, 40)).toBeNull();
    expect(nearestWire(plan, 150, 55)?.edge).toBe('b');
    expect(nearestWire(plan, 30, 40)).toBeNull();
    expect(nearestWire(null, 0, 0)).toBeNull();
  });
  it('measures to a segment end, not the infinite line', () => {
    expect(
      distToPolyline(
        [
          [0, 0],
          [10, 0],
        ],
        20,
        0,
      ),
    ).toBe(10);
  });
});

describe('view preference', () => {
  it('defaults to two and survives a missing or denied storage', () => {
    expect(readView()).toBe('two');
    expect(() => writeView('full')).not.toThrow();
  });
});
