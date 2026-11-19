/** Pure step logic: keyboard stepping, event/site/node lookups. No React, no DOM. */
import type { EventLog, GraphModel } from '@machines/log';

export function clampStep(step: number, max: number): number {
  return Math.min(Math.max(0, Math.trunc(step) || 0), Math.max(0, max));
}

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * The step a key moves to, or null when the key is not a stepping key. Left/Right step by one, Home/End
 * jump to the ends, PageUp/PageDown move by ten. `vertical` also accepts Up/Down (the slider's own keys).
 */
export function stepForKey(
  k: KeyLike,
  step: number,
  max: number,
  opts: { vertical?: boolean; rail?: boolean } = {},
): number | null {
  if (k.ctrlKey || k.metaKey || k.altKey) return null;
  let next: number;
  switch (k.key) {
    case 'ArrowLeft':
      if (k.shiftKey) return null;
      next = step - 1;
      break;
    case 'ArrowRight':
      if (k.shiftKey) return null;
      next = step + 1;
      break;
    case 'ArrowUp':
      // The rail runs top to bottom in time: Up is earlier. The slider's own Up is later.
      if (opts.rail) next = step - 1;
      else if (opts.vertical) next = step + 1;
      else return null;
      break;
    case 'ArrowDown':
      if (opts.rail) next = step + 1;
      else if (opts.vertical) next = step - 1;
      else return null;
      break;
    case 'j':
      if (k.shiftKey) return null;
      next = step + 1;
      break;
    case 'k':
      if (k.shiftKey) return null;
      next = step - 1;
      break;
    case 'PageUp':
      next = step - 10;
      break;
    case 'PageDown':
      next = step + 10;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = max;
      break;
    default:
      return null;
  }
  return clampStep(next, max);
}

/**
 * Where the slider goes when a streamed update arrives. A new run starts at its first step (step 1, the first
 * line) as soon as one exists, and stays at the student's step from then on: streaming never carries the slider
 * to the end. Step 0 stays reachable with Back and is kept if the student goes back to it.
 */
export function nextStep(prevStep: number, prevMax: number, newMax: number): number {
  if (prevMax === 0 && newMax > 0) return 1;
  return clampStep(prevStep, newMax);
}

/** Number of steps whose event index is <= i: the step at which event i is current (0 before any step). */
export function stepAtEvent(model: GraphModel, i: number): number {
  let lo = 0;
  let hi = model.steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (model.steps[mid]! <= i) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function executionEvents(model: GraphModel, nodeId: string): number[] | null {
  const n = model.nodes.find((x) => x.id === nodeId);
  if (!n) return null;
  if (n.kind === 'call' || n.kind === 'expr' || n.kind === 'store' || n.kind === 'import')
    return n.executions.map((e) => e.i);
  if (n.kind === 'instance') return [n.createdAt, ...n.versions.map((v) => v.i)];
  return null;
}

/**
 * The step to show when a box is clicked: its latest execution at or before `currentStep` (so clicking a
 * box that was just drawn lands on it), else its earliest later one. Null for boxes with no execution
 * (sources). Events that are not steps map to the step they happen under.
 */
export function stepForNode(model: GraphModel, nodeId: string, currentStep: number): number | null {
  const evs = executionEvents(model, nodeId);
  if (!evs || evs.length === 0) return null;
  const steps = evs.map((i) => stepAtEvent(model, i)).filter((s) => s >= 1);
  if (steps.length === 0) return null;
  const upTo = steps.filter((s) => s <= currentStep);
  return upTo.length ? Math.max(...upTo) : Math.min(...steps);
}

const siteByEvent = new WeakMap<EventLog, Map<number, number>>();

/** Site id of event `i` (cached per log; the log object is never mutated). */
export function eventSiteId(log: EventLog, i: number): number | null {
  let m = siteByEvent.get(log);
  if (!m) {
    m = new Map(log.events.map((e) => [e.i, e.site]));
    siteByEvent.set(log, m);
  }
  return m.get(i) ?? null;
}

const nodeBySite = new WeakMap<GraphModel, { log: EventLog; map: Map<number, string> }>();

/** The box drawn for a call site (the editor cursor's site), or null. Function boxes win over instances. */
export function nodeForSite(model: GraphModel, log: EventLog, siteId: number): string | null {
  let c = nodeBySite.get(model);
  if (!c || c.log !== log) {
    const map = new Map<number, string>();
    const add = (i: number, id: string): void => {
      const s = eventSiteId(log, i);
      if (s !== null && !map.has(s)) map.set(s, id);
    };
    for (const n of model.nodes) {
      if (n.kind === 'call' || n.kind === 'expr' || n.kind === 'store' || n.kind === 'import')
        for (const e of n.executions) add(e.i, n.id);
    }
    for (const n of model.nodes) if (n.kind === 'instance') add(n.createdAt, n.id);
    c = { log, map };
    nodeBySite.set(model, c);
  }
  return c.map.get(siteId) ?? null;
}
