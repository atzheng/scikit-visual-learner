import type { CallNode, EventLog, GraphModel, InstanceNode } from '@machines/log';
import { describe, expect, test } from 'vitest';
import {
  clampStep,
  eventSiteId,
  nextStep,
  nodeForSite,
  stepAtEvent,
  stepForKey,
  stepForNode,
} from './steps';

const exec = (i: number) => ({
  i,
  ret: i,
  inputs: {},
  outputs: {},
  count: 1,
  owner: null,
  error: null,
  interrupted: false,
});
const call = (id: string, ...is: number[]): CallNode => ({
  id,
  kind: 'call',
  parent: null,
  order: 0,
  mergeKey: id,
  name: id,
  module: null,
  executions: is.map(exec),
  inPorts: [],
  outPorts: [],
  student: false,
});
const inst: InstanceNode = {
  id: 'm',
  kind: 'instance',
  parent: null,
  order: 1,
  className: 'M',
  varName: 'm',
  createdAt: 3,
  createdBy: null,
  params: [],
  versions: [{ i: 5, token: 'v1.1' }],
};
// events 0..5; the steps are events 0, 2, 3, 5 (events 1 and 4 are not drawn)
const model: GraphModel = {
  nodes: [call('a', 0, 2), call('b', 3), inst],
  edges: [],
  steps: [0, 2, 3, 5],
};
const log = {
  events: [0, 1, 2, 3, 4, 5].map((i) => ({ i, site: 10 + i })),
} as unknown as EventLog;

describe('stepForKey', () => {
  test('arrows, home, end, paging, clamped', () => {
    expect(stepForKey({ key: 'ArrowRight' }, 2, 4)).toBe(3);
    expect(stepForKey({ key: 'ArrowRight' }, 4, 4)).toBe(4);
    expect(stepForKey({ key: 'ArrowLeft' }, 0, 4)).toBe(0);
    expect(stepForKey({ key: 'Home' }, 3, 4)).toBe(0);
    expect(stepForKey({ key: 'End' }, 1, 4)).toBe(4);
    expect(stepForKey({ key: 'PageDown' }, 1, 40)).toBe(11);
    expect(stepForKey({ key: 'PageUp' }, 3, 40)).toBe(0);
  });
  test('up/down only in vertical mode; modifiers and other keys ignored', () => {
    expect(stepForKey({ key: 'ArrowUp' }, 1, 4)).toBeNull();
    expect(stepForKey({ key: 'ArrowUp' }, 1, 4, { vertical: true })).toBe(2);
    expect(stepForKey({ key: 'ArrowDown' }, 1, 4, { vertical: true })).toBe(0);
    expect(stepForKey({ key: 'ArrowRight', shiftKey: true }, 1, 4)).toBeNull();
    expect(stepForKey({ key: 'ArrowRight', ctrlKey: true }, 1, 4)).toBeNull();
    expect(stepForKey({ key: 'a' }, 1, 4)).toBeNull();
  });
});

describe('step following', () => {
  test('clampStep', () => {
    expect(clampStep(-3, 4)).toBe(0);
    expect(clampStep(9, 4)).toBe(4);
    expect(clampStep(NaN, 4)).toBe(0);
  });
  test('a new run starts at the end; a student at the end follows; one who stepped back stays', () => {
    expect(nextStep(2, 9, 3, true)).toBe(3);
    expect(nextStep(5, 5, 8, false)).toBe(8);
    expect(nextStep(2, 5, 8, false)).toBe(2);
    expect(nextStep(7, 9, 3, false)).toBe(3);
  });
});

describe('event, node and site lookups', () => {
  test('stepAtEvent counts steps at or before the event', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => stepAtEvent(model, i))).toEqual([1, 1, 2, 3, 3, 4]);
  });
  test('stepForNode: latest execution up to the current step, else the earliest later one', () => {
    expect(stepForNode(model, 'a', 4)).toBe(2);
    expect(stepForNode(model, 'a', 1)).toBe(1);
    expect(stepForNode(model, 'b', 1)).toBe(3);
    expect(stepForNode(model, 'm', 4)).toBe(4); // version at event 5
    expect(stepForNode(model, 'm', 3)).toBe(3); // creation (event 3)
    expect(stepForNode(model, 'nope', 3)).toBeNull();
  });
  test('eventSiteId and nodeForSite', () => {
    expect(eventSiteId(log, 3)).toBe(13);
    expect(eventSiteId(log, 99)).toBeNull();
    expect(nodeForSite(model, log, 12)).toBe('a');
    expect(nodeForSite(model, log, 13)).toBe('b'); // call box wins over the instance created at event 3
    expect(nodeForSite(model, log, 15)).toBeNull();
    expect(nodeForSite(model, log, 11)).toBeNull();
  });
});
