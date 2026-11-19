// Worker protocol: CONTRACTS.md section 7.
import type {
  Event,
  EventKind,
  OutputEntry,
  RunError,
  RunStatus,
  Site,
  Token,
  ValueSummary,
} from './types';

export interface RunConfig {
  draw_modules: string[];
  draw_builtins: boolean;
  draw_container_methods: boolean;
  machine_classes: string[];
  wall_ms: number;
  max_events: number;
  per_site: number;
  preview_bytes: number;
  hash_cells: number;
}

export interface OpenEvent {
  i: number;
  site: number;
  kind: EventKind;
  name: string;
  module: string | null;
}

/**
 * What to document: an event's callee (`module` + `name`, as logged), or `module: null` with a full dotted
 * name (`sklearn.linear_model.LinearRegression.fit`). Student definitions (module `__main__`) are read from
 * `source` (the program text that produced the event); it is ignored for library targets.
 */
export interface DocTarget {
  module: string | null;
  name: string;
  source?: string;
  /** The last part of `name` is an attribute (constructor parameter, fitted attribute, property), not a method. */
  attr?: boolean;
}

export interface DocEntry {
  /** Parameter, attribute or return name; '' for a Returns/Raises entry that is only a type. */
  name: string;
  type: string;
  /** Plain text; paragraphs separated by a blank line; backticks mark code; no reST roles. */
  desc: string;
}

export type DocSection =
  | { title: string; kind: 'entries'; entries: DocEntry[] } // Parameters, Returns, Raises, Attributes, ...
  | { title: 'See Also'; kind: 'seealso'; items: { name: string; desc: string }[] }
  | { title: 'Examples'; kind: 'examples'; blocks: { kind: 'code' | 'text'; text: string }[] }
  | { title: string; kind: 'text'; text: string }; // Notes, References, Warnings

/** Official documentation for one function, class or method, from the docstrings in the interpreter. */
export interface Doc {
  /** Public dotted path, e.g. `sklearn.linear_model.LinearRegression.fit`. */
  qualname: string;
  kind: 'function' | 'class' | 'method' | 'attribute';
  signature: string | null;
  summary: string;
  description: string;
  sections: DocSection[];
  /** Versioned official page, or null (student code, unknown library). The UI shows it as a plain link. */
  url: string | null;
  source: 'numpydoc' | 'plain' | 'none';
}

export type ToWorker =
  | { type: 'init'; interruptBuffer?: SharedArrayBuffer; currentCall?: SharedArrayBuffer }
  | { type: 'run'; runId: number; source: string; config: RunConfig }
  | { type: 'file'; name: string; bytes: ArrayBuffer }
  | { type: 'docs'; reqId: number; target: DocTarget };

export type FromWorker =
  | {
      type: 'progress';
      phase: 'pyodide' | 'packages' | 'recorder' | 'datasets' | 'matplotlib';
      done: number;
      total: number;
    }
  | { type: 'ready'; versions: Record<string, string> }
  | { type: 'started'; runId: number; sites: Site[] }
  | {
      type: 'batch';
      runId: number;
      events: Event[];
      open: OpenEvent[];
      values: Record<Token, ValueSummary>;
      bindings: [scope: number, event: number, name: string, token: Token, slot_key?: string][];
      output: OutputEntry[];
      diagnostics: string[];
    }
  | { type: 'done'; runId: number; status: RunStatus; error: RunError | null }
  | { type: 'fileWritten'; name: string; rows?: number }
  | { type: 'docs'; reqId: number; doc: Doc };

/** `currentCall` buffer contents decoded: the innermost open recorded call. */
export interface CurrentCall {
  i: number;
  site: number;
}
