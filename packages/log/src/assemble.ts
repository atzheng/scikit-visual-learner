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
   * `currentCall` (if newer than every stub and event) become interrupted events.
   */
  finish(status?: RunStatus, currentCall?: CurrentCall | null): EventLog;
  /** A valid EventLog of what has arrived so far; status 'ok' until 'done'. Open stubs are not included. */
  snapshot(): EventLog;
}

export function createAssembler(): Assembler {
  let runId: number | null = null;
  let sites: Site[] = [];
  let values: Record<Token, ValueSummary> = {};
  let events: Event[] = []; // sorted by i
  let open = new Map<number, OpenEvent>();
  let bindings = new Map<number, [number, string, Token][]>();
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
        if (runId !== null && msg.runId < runId) return;
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
        const finished = new Set(events.map((e) => e.i));
        for (const o of msg.open) {
          if (!finished.has(o.i)) open.set(o.i, o);
        }
        Object.assign(values, msg.values);
        for (const [scope, event, name, token] of msg.bindings) {
          const list = bindings.get(scope) ?? [];
          list.push([event, name, token]);
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
        bindings: (bindings.get(id) ?? []).slice(),
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
      count: evs.filter((e) => e.merge_key === merge_key).length + 1,
      merge_key,
      error: null,
      interrupted: true,
    };
  }

  return {
    push,
    snapshot: () => build('ok', events.slice()),
    finish(override, currentCall) {
      const final = override ?? status;
      const evs = events.slice();
      if (final === 'timeout' || final === 'stopped') {
        const stubs = [...open.values()].sort((a, b) => a.i - b.i);
        for (const s of stubs) {
          evs.push(interrupted(s.i, s.site, s.kind, s.name, s.module, evs));
        }
        const maxI = evs.reduce((m, e) => Math.max(m, e.i), -1);
        if (currentCall && currentCall.i > maxI) {
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
