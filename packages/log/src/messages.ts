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

export type ToWorker =
  | { type: 'init'; interruptBuffer?: SharedArrayBuffer; currentCall?: SharedArrayBuffer }
  | { type: 'run'; runId: number; source: string; config: RunConfig }
  | { type: 'file'; name: string; bytes: ArrayBuffer };

export type FromWorker =
  | {
      type: 'progress';
      phase: 'pyodide' | 'packages' | 'recorder' | 'datasets';
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
      bindings: [scope: number, event: number, name: string, token: Token][];
      output: OutputEntry[];
      diagnostics: string[];
    }
  | { type: 'done'; runId: number; status: RunStatus; error: RunError | null }
  | { type: 'fileWritten'; name: string; rows?: number };

/** `currentCall` buffer contents decoded: the innermost open recorded call. */
export interface CurrentCall {
  i: number;
  site: number;
}
