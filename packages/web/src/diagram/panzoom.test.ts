import { describe, expect, test } from 'vitest';
import {
  MAX_K,
  MIN_K,
  centerOn,
  ensureVisible,
  fitView,
  isVisible,
  panBy,
  zoomAt,
} from './panzoom';

const vp = { w: 400, h: 300 };

describe('pan/zoom', () => {
  test('zoomAt keeps the pointer fixed', () => {
    const v = zoomAt({ x: 10, y: 20, k: 1 }, 2, 100, 50);
    expect(v.k).toBe(2);
    // the diagram point under (100, 50) before is (90, 30)
    expect(90 * v.k + v.x).toBeCloseTo(100);
    expect(30 * v.k + v.y).toBeCloseTo(50);
  });
  test('zoom is clamped', () => {
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 1000, 0, 0).k).toBe(MAX_K);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 1e-9, 0, 0).k).toBe(MIN_K);
  });
  test('fit never magnifies and centres', () => {
    const small = fitView({ w: 100, h: 50 }, vp);
    expect(small.k).toBe(1);
    expect(small.x).toBe(150);
    const big = fitView({ w: 1600, h: 300 }, vp);
    expect(big.k).toBeCloseTo((400 - 32) / 1600);
    expect(fitView({ w: 0, h: 0 }, vp)).toEqual({ x: 0, y: 0, k: 1 });
  });
  test('centerOn / isVisible / ensureVisible', () => {
    const v = { x: 0, y: 0, k: 1 };
    const r = { x: 900, y: 10, w: 100, h: 40 };
    expect(isVisible(v, r, vp)).toBe(false);
    const c = centerOn(v, r, vp);
    expect(isVisible(c, r, vp)).toBe(true);
    expect(c.x + 950).toBeCloseTo(200);
    const inside = { x: 20, y: 20, w: 50, h: 20 };
    expect(ensureVisible(v, inside, vp)).toBe(v);
    expect(ensureVisible(v, r, vp)).toEqual(c);
  });
  test('panBy', () => {
    expect(panBy({ x: 1, y: 2, k: 3 }, 4, 5)).toEqual({ x: 5, y: 7, k: 3 });
  });
});
