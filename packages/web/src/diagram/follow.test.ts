import type { GraphModel, StepState } from '@machines/log';
import { describe, expect, test } from 'vitest';
import { READABLE_K, followNodes, followView, unionRect } from './follow';

const node = (id: string, parent: string | null = null) =>
  ({ id, parent, kind: 'call' }) as unknown as GraphModel['nodes'][number];
const edge = (id: string, from: string, to: string) =>
  ({
    id,
    from: { node: from, port: null },
    to: { node: to, port: null },
  }) as unknown as GraphModel['edges'][number];
const state = (cur: string | null, edges: string[]) =>
  ({ currentNode: cur, visibleEdges: new Set(edges) }) as unknown as StepState;

describe('followNodes', () => {
  const model: GraphModel = {
    nodes: [node('a'), node('b', 'i'), node('c'), node('i'), node('far')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e4', 'far', 'a')],
    steps: [],
  };
  test('current node, wired neighbours, owner; no hidden wire', () => {
    expect(followNodes(model, state('b', ['e1', 'e2'])).sort()).toEqual(['a', 'b', 'c', 'i']);
    expect(followNodes(model, state('b', ['e1'])).sort()).toEqual(['a', 'b', 'i']);
    expect(followNodes(model, state(null, ['e1']))).toEqual([]);
  });
});

describe('followView', () => {
  const vp = { w: 800, h: 600 };
  const content = { w: 6000, h: 3000 };
  const focus = { x: 3000, y: 1000, w: 300, h: 200 };
  test('a diagram that fits readably is simply fitted', () => {
    const v = followView({ x: 5, y: 5, k: 1 }, focus, focus, { w: 700, h: 400 }, vp);
    expect(v.k).toBeGreaterThanOrEqual(READABLE_K);
    expect(v.x).toBeGreaterThanOrEqual(0);
  });
  test('a big diagram zooms to a readable scale centred on the focus', () => {
    const v = followView({ x: 0, y: 0, k: 0.1 }, focus, focus, content, vp);
    expect(v.k).toBe(1);
    expect(3150 * v.k + v.x).toBeCloseTo(400);
    expect(1100 * v.k + v.y).toBeCloseTo(300);
  });
  test('the scale never drops below the readable one, and the running box stays centred', () => {
    const wide = { x: 0, y: 0, w: 5000, h: 300 };
    const anchor = { x: 4800, y: 100, w: 200, h: 100 };
    const v = followView({ x: 0, y: 0, k: 0.1 }, wide, anchor, content, vp);
    expect(v.k).toBe(READABLE_K);
    expect(4900 * v.k + v.x).toBeCloseTo(400);
  });
  test('a focus already on screen at a readable scale does not move the view', () => {
    const view = { x: -2800, y: -900, k: 1 };
    expect(followView(view, focus, focus, content, vp)).toBe(view);
  });
  test('no focus: the top of the diagram at a readable scale', () => {
    expect(followView({ x: 0, y: 0, k: 1 }, null, null, content, vp).k).toBe(READABLE_K);
  });
});

test('unionRect', () => {
  expect(unionRect([])).toBeNull();
  expect(
    unionRect([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 20, y: 5, w: 10, h: 10 },
    ]),
  ).toEqual({ x: 0, y: 0, w: 30, h: 15 });
});
