// Event log types: CONTRACTS.md section 2. Keep field-for-field in sync.

/** Reference values: "v<obj>.<version>"; scalars: "s<n>". */
export type Token = string;
export type RunStatus = 'ok' | 'error' | 'timeout' | 'stopped' | 'limit';

export interface EventLog {
  version: 2;
  status: RunStatus;
  error: RunError | null;
  sites: Site[];
  scopes: Scope[];
  values: Record<Token, ValueSummary>;
  events: Event[];
  output: OutputEntry[];
  diagnostics: string[];
}

export type Origin =
  | { origin: 'const'; text: string }
  | { origin: 'name'; name: string }
  | { origin: 'call'; site: number }
  | { origin: 'expr'; text: string; reads: string[] }
  | { origin: 'unknown' };

export interface Site {
  id: number;
  kind: 'call' | 'bind' | 'store' | 'ret' | 'import';
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  text: string;
  func_text?: string;
  func_line?: number;
  args?: Origin[];
  keywords?: Record<string, Origin>;
  unpack?: number;
  targets?: string[];
  value?: Origin;
  where?: 'local' | 'global' | 'nonlocal';
  root?: string;
  /** `import` sites: the names one module-level import statement binds. */
  imports?: ImportBinding[];
}

export interface ImportBinding {
  /** The name the statement binds (`pd`, `LinearRegression`). */
  name: string;
  /** `import m` -> m; `import m as x` -> m; `from m import a` -> m. */
  module: string;
  /** `from m import a [as b]` -> a; null for `import m`. */
  attr: string | null;
  /** Bound exactly once in the whole module and no star import: nothing can have rebound it. */
  sole: boolean;
}

export interface Scope {
  id: number;
  name: string;
  parent_event: number | null;
  lexical_parent: number | null;
  bindings: [event: number, name: string, token: Token][];
}

export type Preview =
  | { kind: 'table'; columns: string[]; index: string[]; rows: string[][] }
  | { kind: 'matrix'; rows: string[][] };

export interface ValueSummary {
  type: string;
  shape?: number[];
  dtype?: string;
  dtypes?: string[];
  columns?: string[];
  preview?: Preview;
  repr?: string;
  attrs?: Record<string, Token>;
  methods?: { name: string; doc: string }[];
  machine?: boolean;
}

export type EventKind =
  'function' | 'method' | 'constructor' | 'student_function' | 'expr' | 'store';

export interface Input {
  param: string;
  origin: Origin['origin'];
  value?: Token;
  text?: string;
}

export interface EventError {
  type: string;
  message: string;
  handled: boolean;
  propagated?: true;
}

export interface Event {
  i: number;
  ret: number;
  site: number;
  scope: number;
  kind: EventKind;
  name: string;
  module: string | null;
  owner: Token | null;
  inputs: Input[];
  outputs: Token[];
  returns_self: boolean;
  mutates: [before: Token, after: Token][];
  count: number;
  slot?: true;
  merge_key: string;
  error: EventError | null;
  interrupted?: true;
}

export type TracebackFrame =
  | { kind: 'student'; line: number; text: string; name: string; repeat?: number }
  | { kind: 'library'; count: number; modules: string[] };

export interface RunError {
  type: string;
  message: string;
  line: number | null;
  traceback: TracebackFrame[];
}

export type OutputEntry =
  | { i: number; stream: 'stdout' | 'stderr' | 'warning'; text: string }
  | { i: number; stream: 'figure'; png: string; width: number; height: number };
