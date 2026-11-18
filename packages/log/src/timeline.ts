// Timeline state (CONTRACTS.md section 8, SPEC "Timeline"). Pure: (model, log, step) -> StepState.
import type { Execution, GEdge, GNode, GraphModel } from './graph';
import type { Event, EventLog, OutputEntry, Token } from './types';

export interface StepState {
  /** Event i at this step (steps[step-1]); null at step 0. */
  current: number | null;
  visibleNodes: Set<string>;
  visibleEdges: Set<string>;
  /** Per visible call/expr/store node: latest execution with i <= current. */
  activeExecution: Map<string, Execution>;
  /** Per visible edge: the token of its latest available use. */
  activeToken: Map<string, Token>;
  /** Set when the current event is a method on a machine. */
  attrsBefore?: Record<string, Token>;
  attrsAfter?: Record<string, Token>;
  output: OutputEntry[];
  /** Merged boxes only (n > 1): k = count of the active execution, n = total count. */
  badge: Map<string, { k: number; n: number }>;
}

interface UseInfo {
  token: Token;
  i: number;
  /** First step threshold at which this use is drawn: max(consumer i, producer ret). */
  at: number;
}
interface EdgeIndex {
  id: string;
  minAt: number;
  uses: UseInfo[]; // sorted by i
}
interface ExecNode {
  id: string;
  executions: Execution[];
  n: number;
}
interface Index {
  first: Map<string, number>; // node id -> first i at which it is visible (non-source)
  execNodes: ExecNode[];
  edges: EdgeIndex[];
  sourceEdges: Map<string, number[]>; // source node id -> indices into edges
  events: Event[];
}

const keyOf = (t: Token): string => (t.startsWith('v') ? t.slice(0, t.indexOf('.')) : t);

function findEvent(events: Event[], i: number): Event | undefined {
  let lo = 0;
  let hi = events.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = events[mid]!;
    if (e.i === i) return e;
    if (e.i < i) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

const cache = new WeakMap<GraphModel, WeakMap<EventLog, Index>>();

function buildIndex(model: GraphModel, log: EventLog): Index {
  const nodeById = new Map<string, GNode>();
  const first = new Map<string, number>();
  const execNodes: ExecNode[] = [];
  // node id -> token -> [exec i, ret][] of the executions that output it
  const produced = new Map<string, Map<Token, [number, number][]>>();
  for (const n of model.nodes) {
    nodeById.set(n.id, n);
    if (n.kind === 'instance') first.set(n.id, n.createdAt);
    else if (n.kind !== 'source') {
      if (n.executions.length > 0) first.set(n.id, n.executions[0]!.i);
      const last = n.executions[n.executions.length - 1];
      execNodes.push({ id: n.id, executions: n.executions, n: last ? last.count : 0 });
      const m = new Map<Token, [number, number][]>();
      for (const ex of n.executions)
        for (const t of Object.values(ex.outputs)) {
          const l = m.get(t);
          if (l) l.push([ex.i, ex.ret]);
          else m.set(t, [[ex.i, ex.ret]]);
        }
      produced.set(n.id, m);
    }
  }

  const producerRet = (e: GEdge, token: Token, useI: number): number => {
    const from = nodeById.get(e.from.node);
    if (!from || from.kind === 'source') return -Infinity;
    if (from.kind === 'instance') {
      const v = from.versions.find((x) => x.token === token);
      if (v) return findEvent(log.events, v.i)?.ret ?? -Infinity;
      const ev = findEvent(log.events, from.createdAt);
      // A lazy instance has no producing event: its "creator" is just its first consumer.
      if (ev && (ev.kind === 'constructor' || ev.outputs.some((t) => keyOf(t) === keyOf(token))))
        return ev.ret;
      return -Infinity;
    }
    const list = produced.get(from.id)?.get(token);
    if (!list) return -Infinity;
    let pick = list[0]!;
    for (const p of list) if (p[0] < useI) pick = p;
    return pick[1];
  };

  const edges: EdgeIndex[] = [];
  const sourceEdges = new Map<string, number[]>();
  for (const e of model.edges) {
    const uses = e.uses
      .map((u) => ({ token: u.token, i: u.i, at: Math.max(u.i, producerRet(e, u.token, u.i)) }))
      .sort((a, b) => a.i - b.i);
    let minAt = Infinity;
    for (const u of uses) if (u.at < minAt) minAt = u.at;
    const idx = edges.push({ id: e.id, minAt, uses }) - 1;
    const from = nodeById.get(e.from.node);
    if (from && from.kind === 'source') {
      const l = sourceEdges.get(from.id);
      if (l) l.push(idx);
      else sourceEdges.set(from.id, [idx]);
    }
  }
  return { first, execNodes, edges, sourceEdges, events: log.events };
}

function indexFor(model: GraphModel, log: EventLog): Index {
  let byLog = cache.get(model);
  if (!byLog) cache.set(model, (byLog = new WeakMap()));
  let idx = byLog.get(log);
  if (!idx) byLog.set(log, (idx = buildIndex(model, log)));
  return idx;
}

/** Index of the last execution with i <= cur, or -1. */
function lastAtOrBefore(execs: Execution[], cur: number): number {
  let lo = 0;
  let hi = execs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (execs[mid]!.i <= cur) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * State of the diagram at `step` (0 = nothing, steps.length = everything). Visibility is cumulative:
 * a node shows from its first execution (instances: createdAt); a wire shows from the first use whose
 * consumer has started and whose producer has returned.
 */
export function stateAt(model: GraphModel, log: EventLog, step: number): StepState {
  const ix = indexFor(model, log);
  const total = model.steps.length;
  const s = Math.max(0, Math.min(total, Math.trunc(step)));
  const atEnd = s === total;
  const current = s === 0 ? null : model.steps[s - 1]!;
  // At the end everything is shown, even things ready only after the last drawn step.
  const cur = atEnd ? Infinity : current === null ? -1 : current;

  const visibleNodes = new Set<string>();
  const visibleEdges = new Set<string>();
  const activeExecution = new Map<string, Execution>();
  const activeToken = new Map<string, Token>();
  const badge = new Map<string, { k: number; n: number }>();

  for (const [id, i] of ix.first) if (i <= cur) visibleNodes.add(id);
  for (const en of ix.execNodes) {
    if (!visibleNodes.has(en.id)) continue;
    const k = lastAtOrBefore(en.executions, cur);
    if (k < 0) continue;
    const ex = en.executions[k]!;
    activeExecution.set(en.id, ex);
    if (en.n > 1) badge.set(en.id, { k: ex.count, n: en.n });
  }
  for (const e of ix.edges) {
    if (e.minAt > cur) continue;
    visibleEdges.add(e.id);
    for (let u = e.uses.length - 1; u >= 0; u--) {
      const use = e.uses[u]!;
      if (use.at <= cur) {
        activeToken.set(e.id, use.token);
        break;
      }
    }
  }
  // A source is shown when any consumer of its edges is.
  for (const [id, idxs] of ix.sourceEdges)
    if (idxs.some((k) => visibleEdges.has(ix.edges[k]!.id))) visibleNodes.add(id);

  const state: StepState = {
    current,
    visibleNodes,
    visibleEdges,
    activeExecution,
    activeToken,
    // Entries with i = -1 (before any event) are always visible; with nothing drawn, show all.
    output: atEnd ? log.output.slice() : log.output.filter((o) => o.i <= cur),
    badge,
  };

  if (current !== null) {
    const ev = findEvent(ix.events, current);
    if (ev && ev.kind === 'method' && ev.owner && log.values[ev.owner]?.machine) {
      const m = ev.mutates.find(([b]) => keyOf(b) === keyOf(ev.owner!));
      const before = m ? m[0] : ev.owner;
      const after = m ? m[1] : ev.owner;
      const a = log.values[before]?.attrs;
      const b = log.values[after]?.attrs;
      if (a) state.attrsBefore = a;
      if (b) state.attrsAfter = b;
    }
  }
  return state;
}

const MAX_LABEL = 80;

/** "line 10: train_test_split(X, y, test_size=0.2)", for the event list and screen readers. */
export function eventLabel(log: EventLog, i: number): string {
  const ev = findEvent(log.events, i);
  if (!ev) return `event ${i}`;
  const site = log.sites[ev.site];
  let text = (site ? site.text : ev.name).replace(/\s+/g, ' ').trim();
  if (text.length > MAX_LABEL) text = text.slice(0, MAX_LABEL - 1) + '…';
  let label = `${site ? `line ${site.line}` : `event ${i}`}: ${text}`;
  if (ev.error && !ev.error.handled) label += ` (error: ${ev.error.type})`;
  else if (ev.error) label += ` (handled ${ev.error.type})`;
  if (ev.interrupted) label += ' (stopped here)';
  return label;
}
