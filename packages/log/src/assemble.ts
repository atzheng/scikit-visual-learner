// Assembler: worker messages -> EventLog (CONTRACTS.md section 7).
import type { CurrentCall, FromWorker, OpenEvent } from './messages';
import type {
  Event,
  EventLog,
  OutputEntry,
  RunError,
  RunStatus,
  Scope,
  Site,
  Token,
  ValueSummary,
} from './types';

export interface Assembler {
  push(msg: FromWorker): void;
  /**
   * Final log. `status` overrides the status from 'done' (the client passes 'timeout' or
   * 'stopped' when it kills the worker). For those two, remaining open stubs and
   * `currentCall` (if no stub or event has its `i`) become interrupted events.
   */
  finish(status?: RunStatus, currentCall?: CurrentCall | null): EventLog;
  /** A valid EventLog of what has arrived so far; status 'ok' until 'done', then the done status and error. Open stubs are not included. */
  snapshot(): EventLog;
}

/** `runId`: when given, only that run is accepted (including its `started`). */
export function createAssembler(expectedRunId?: number): Assembler {
  let runId: number | null = null;
  let sites: Site[] = [];
  let values: Record<Token, ValueSummary> = {};
  let events: Event[] = []; // sorted by i
  let open = new Map<number, OpenEvent>();
  let bindings = new Map<number, { b: [number, string, Token]; key?: string }[]>();
  let output: OutputEntry[] = [];
  let diagnostics: string[] = [];
  let status: RunStatus = 'ok';
  let error: RunError | null = null;

  function reset(): void {
    sites = [];
    values = {};
    events = [];
    open = new Map();
    bindings = new Map();
    output = [];
    diagnostics = [];
    status = 'ok';
    error = null;
  }

  function insert(ev: Event): void {
    if (ev.slot) {
      const newer = events.some(
        (e) => e.slot === true && e.merge_key === ev.merge_key && e.i > ev.i,
      );
      if (newer) return; // out-of-order batch: never let an older slot replace a newer one
      events = events.filter((e) => !(e.slot === true && e.merge_key === ev.merge_key));
    }
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.i < ev.i) lo = mid + 1;
      else hi = mid;
    }
    if (events[lo]?.i === ev.i) events[lo] = ev;
    else events.splice(lo, 0, ev);
  }

  function push(msg: FromWorker): void {
    switch (msg.type) {
      case 'started':
        if (expectedRunId !== undefined && msg.runId !== expectedRunId) return;
        if (runId !== null && msg.runId <= runId) return;
        runId = msg.runId;
        reset();
        sites = msg.sites;
        return;
      case 'batch': {
        if (msg.runId !== runId) return;
        for (const ev of msg.events) {
          insert(ev);
          open.delete(ev.i);
        }
        // `open` is the full stack at flush time: replace, don't accumulate.
        const finished = new Set(events.map((e) => e.i));
        open = new Map(msg.open.filter((o) => !finished.has(o.i)).map((o) => [o.i, o]));
        Object.assign(values, msg.values);
        for (const [scope, event, name, token, key] of msg.bindings) {
          let list = bindings.get(scope) ?? [];
          if (key !== undefined) {
            if (list.some((x) => x.key === key && x.b[0] > event)) continue;
            list = list.filter((x) => x.key !== key);
          }
          list.push(
            key === undefined ? { b: [event, name, token] } : { b: [event, name, token], key },
          );
          bindings.set(scope, list);
        }
        output.push(...msg.output);
        diagnostics.push(...msg.diagnostics);
        return;
      }
      case 'done':
        if (msg.runId !== runId) return;
        status = msg.status;
        error = msg.error;
        if (msg.status !== 'timeout' && msg.status !== 'stopped') open.clear();
        return;
      default:
        return; // progress, ready, fileWritten belong to the client
    }
  }

  function scopes(): Scope[] {
    const ids = new Set<number>([0, ...bindings.keys()]);
    return [...ids]
      .sort((a, b) => a - b)
      .map((id) => ({
        id,
        name: id === 0 ? '<module>' : `<scope ${id}>`,
        parent_event: null,
        lexical_parent: id === 0 ? null : 0,
        bindings: (bindings.get(id) ?? [])
          .map((x, k) => ({ x, k }))
          .sort((a, c) => a.x.b[0] - c.x.b[0] || a.k - c.k)
          .map(({ x }) => x.b),
      }));
  }

  function build(finalStatus: RunStatus, evs: Event[]): EventLog {
    return {
      version: 2,
      status: finalStatus,
      error,
      sites: sites.slice(),
      scopes: scopes(),
      values: { ...values },
      events: evs,
      output: output.slice(),
      diagnostics: diagnostics.slice(),
    };
  }

  function interrupted(
    i: number,
    site: number,
    kind: Event['kind'],
    name: string,
    module: string | null,
    evs: Event[],
  ): Event {
    const merge_key = `s${site}`;
    return {
      i,
      ret: i,
      site,
      scope: 0,
      kind,
      name,
      module,
      owner: null,
      inputs: [],
      outputs: [],
      returns_self: false,
      mutates: [],
      count: evs.reduce((m, e) => (e.merge_key === merge_key ? Math.max(m, e.count) : m), 0) + 1,
      merge_key,
      error: null,
      interrupted: true,
    };
  }

  return {
    push,
    snapshot: () => build(status, events.slice()),
    finish(override, currentCall) {
      const final = override ?? status;
      const evs = events.slice();
      if (final === 'timeout' || final === 'stopped') {
        const stubs = [...open.values()].sort((a, b) => a.i - b.i);
        for (const s of stubs) {
          evs.push(interrupted(s.i, s.site, s.kind, s.name, s.module, evs));
        }
        // evs now holds finished events and stub-derived events; add the currentCall
        // event unless one with that `i` exists (it may be an outer call whose inner
        // calls already finished, so its `i` can be lower than theirs).
        if (currentCall && !evs.some((e) => e.i === currentCall.i)) {
          const site = sites[currentCall.site];
          const name = site?.func_text ?? site?.text ?? '?';
          evs.push(interrupted(currentCall.i, currentCall.site, 'function', name, null, evs));
        }
        evs.sort((a, b) => a.i - b.i);
      }
      return build(final, evs);
    },
  };
}
