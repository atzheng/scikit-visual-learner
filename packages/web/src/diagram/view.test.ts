import type { StagePlan } from '@machines/render';
import { describe, expect, it } from 'vitest';
import { canvasPoint, distToPolyline, nearestWire, readView, writeView } from './view';

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

describe('nearestWire under a stage scale', () => {
  it('hits the wire where it is drawn at k < 1, and misses where the unscaled wire would be', () => {
    const k = 0.6;
    const origin = { left: 100, top: 50 };
    // wire 'a' is the plan line x = 0 from y 0 to 100: drawn at x = 100, y 50..110
    const on = canvasPoint(100 + 2, 50 + 24, origin, k);
    expect(nearestWire(plan, on.x, on.y)?.edge).toBe('a');
    const off = canvasPoint(100 + 40, 50 + 24, origin, k);
    expect(nearestWire(plan, off.x, off.y)).toBeNull();
    // without the scale the point 40 px right would be 40 px away; with it the wire at plan x=100 ('b') is 66 away
    expect(canvasPoint(160, 80, origin, k)).toEqual({ x: 100, y: 50 });
  });
});

describe('view preference', () => {
  it('defaults to two and survives a missing or denied storage', () => {
    expect(readView()).toBe('two');
    expect(() => writeView('full')).not.toThrow();
  });
});
