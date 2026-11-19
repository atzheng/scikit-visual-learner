# Code Diagrams contracts

The interfaces that beads share. SPEC.md says what the product does; this file fixes names, shapes and file locations so that beads built separately fit together. If a bead needs to change something here, change this file in the same commit and say so in the PR body.

Scope of the current plan: SPEC milestones 1–3 (spike, core diagram, timeline), plus share links, CSV upload, autosave, an offline service worker and matplotlib figures. Scopes (milestone 4) and Jupyter (milestone 5) are planned after the student test. Section 10 lists where this file decides something SPEC.md leaves open or contradicts. Where the two disagree, this file wins.

## 1. Layout and tooling

```
pyproject.toml            uv project for python/ (pytest, ruff); requires-python pinned to the Pyodide CPython minor
.python-version
python/machines/
  __init__.py             re-exports instrument, record, run
  transform.py            section 3: Instrument transformer and site table
  values.py               section 5: tokens, scalars, fingerprints, versions, summaries
  recorder.py             section 4: hooks, Recorder, events, call filtering, caps, streaming
  runtime.py              section 6: run()/record(): compile, namespace, output, warnings, input(), limits
  tracebacks.py           section 6: student-only traceback
  mpl.py                  section 6: matplotlib Agg setup, plt.show() -> figure output
  docs.py                 section 12: numpydoc parser, public qualnames, versioned doc URLs
python/tests/             pytest; test_transform.py, test_values.py, test_recorder.py, test_runtime.py,
                          test_golden.py, test_transparency.py
fixtures/
  programs/*.py           section 9: golden, edge-case and transparency programs
  data/*.csv              synthetic course datasets
  logs/*.json             expected event logs (generated, checked in)
  streams/*.jsonl         the worker messages for each program (generated, checked in)
  graphs/*.json           expected GraphModels (generated, checked in)
packages/log/src/         @machines/log — pure TS, no DOM
  types.ts                section 2 as TypeScript types
  messages.ts             section 7 worker message types
  assemble.ts             section 7: messages -> EventLog
  graph.ts                section 8: EventLog -> GraphModel
  timeline.ts             section 8: step state
  index.ts
packages/render/src/      @machines/render — framework-free; DOM + SVG
  layout.ts               GraphModel -> ELK -> Laid (section 8)
  svg.ts                  draw Laid into an <svg>
  mount.ts                mount(el, opts) -> DiagramController (section 8)
  theme.css               CSS variables (section 8)
  legend.ts
  index.ts
packages/web/             @machines/web — Vite + React app
  public/_headers         COOP/COEP + CSP (section 11)
  public/datasets/        copied from fixtures/data at build
  src/main.tsx  src/App.tsx (shell layout, providers)
  src/store.ts            zustand app store (section 7)
  src/course.ts           default RunConfig, dataset list, starter example
  src/runtime/worker.ts   Pyodide Web Worker (section 7)
  src/runtime/client.ts   RuntimeClient on the main thread (section 7)
  src/editor/Editor.tsx  editor/spans.ts
  src/diagram/DiagramPane.tsx
  src/timeline/Timeline.tsx  timeline/EventList.tsx
  src/inspect/Preview.tsx  inspect/InstanceDiff.tsx
  src/output/OutputPane.tsx  output/Traceback.tsx
  src/share/link.ts
  src/files/upload.ts  src/storage/autosave.ts
  src/sw.ts               service worker
scripts/                  measure.ts (section 9), gen-fixtures (python -m machines.tools.gen_fixtures)
python/machines/tools/gen_fixtures.py
```

Skeleton beads create placeholder files at these paths so that later beads fill in a file instead of editing a shared one.

**Libraries (fixed).** pnpm workspaces, TypeScript strict, vitest, eslint (typescript-eslint) + prettier, Vite, React, zustand, CSS modules with CSS variables (no Tailwind), CodeMirror 6 (`@codemirror/*`, `@codemirror/lang-python`), `elkjs` (worker build), `pyodide` (npm package, self-hosted copy), `playwright-core` for e2e and measurement scripts (a dev dependency, driving the system Chrome). Python: standard library only at runtime, plus pytest, ruff, numpy, pandas, scikit-learn and matplotlib as dev dependencies at the versions Pyodide ships. Do not add other runtime dependencies without a reason written in the PR body.

**Pinned versions.** The scaffold bead records here the Pyodide version (latest stable that ships pandas and scikit-learn), its CPython minor, and its numpy, pandas, scikit-learn and matplotlib versions. The uv dev dependencies use exactly those versions, so CPython tests and Pyodide agree.

- Pyodide: 314.0.8 (npm `pyodide@314.0.8`, exact; abi `2026_0`, emscripten 5.0.3). Pyodide's version scheme changed: 314 means CPython 3.14.
- CPython: 3.14 (Pyodide ships 3.14.2; `.python-version` and `requires-python` are the minor, `>=3.14,<3.15`) · numpy 2.4.6 · pandas 3.0.2 · scikit-learn 1.8.0 · scipy 1.18.0 · matplotlib 3.10.8 (all from `pyodide-lock.json`; `pyproject.toml` pins them with `==`)
- JS tooling: TypeScript 6 (typescript-eslint does not yet support 7), Vite 8, Vitest 5, React 19, ESLint 10, Prettier 3.
- The `pyodide` npm package ships no wheels. `packages/web/scripts/fetch-pyodide.ts` downloads the GitHub release tarball `pyodide-314.0.8.tar.bz2` (about 340 MB) once, extracts only the wheels for numpy, pandas, scipy, scikit-learn, matplotlib and pytest and their dependencies, and caches the result in `packages/web/node_modules/.cache/pyodide/<version>/dist`. `pnpm dev` and `pnpm build` run it first (dev serves the cache at `/pyodide/`; build copies it to `packages/web/dist/pyodide/`). Vitest and CPython pytest never need it. `pnpm test:pyodide` reads the cache only and never downloads: when the cache is missing it exits with an instruction to run the fetch script.
- Verified on Pyodide 314.0.8 on Node (svl-a8j.6): `n_jobs=2` falls back to sequential execution. `joblib.Parallel(n_jobs=2)` runs every task on the calling thread (`joblib.cpu_count()` is 1), `cross_val_score(..., n_jobs=2)` returns normal results, and `edge_gridsearch.py` (`GridSearchCV`, `n_jobs=2`) runs to completion with the right output. No error is raised, so the UI note in SPEC is informational. The doubled recursion limit is safe: recorded pure-Python recursion to depth 1900 runs and runaway recursion ends in `RecursionError`.
- `pnpm test:pyodide` runs `python/tests` inside Pyodide (the repo is mounted with NODEFS). Tests marked `@pytest.mark.no_pyodide(reason=...)` are skipped there; the reasons are the grep-able list: whole-program subprocesses (Pyodide has no processes), float last digits of `golden_linreg` (wasm LAPACK), and matplotlib deprecation warnings on every drawn text (see below). Other Pyodide differences: freeing a chain of about 3000 nested plain objects overflows the wasm stack with no recorder involved, so `test_machine_attrs_one_level_and_long_chain` builds 800 there, and `sys.getsizeof` counts 4-byte pointers on wasm32.
- Known recorder issue under Pyodide: Pyodide's matplotlib build raises `MatplotlibDeprecationWarning` (float `x`/`y` in `draw_text_image`) for each drawn text, so the recorder reports dozens of warning entries on every `plt.show()` with text. Filter them in `mpl.py` when rendering a figure.
When bumping Pyodide, update the `pyodide` version in `packages/web/package.json`, the pins in `pyproject.toml` and this list.

## 2. Event log (`types.ts`; produced by `machines.record`)

Version 2 of the schema in SPEC.md "Event log schema", made exact. Line numbers are 1-based and columns 0-based (as in `ast`), measured in UTF-8 code points of the source (`ast` gives byte offsets: `transform.py` converts them). All preview cells and scalar texts are pre-formatted strings.

```ts
type Token = string; // reference values: "v<obj>.<version>", e.g. "v12.0"; scalars: "s<n>", e.g. "s7"
type RunStatus = 'ok' | 'error' | 'timeout' | 'stopped' | 'limit';

interface EventLog {
  version: 2;
  status: RunStatus;
  error: RunError | null;
  sites: Site[];
  scopes: Scope[]; // M1–3: exactly one, the module (id 0)
  values: Record<Token, ValueSummary>;
  events: Event[]; // sorted by i; i is unique but not contiguous (section 4, caps)
  output: OutputEntry[];
  diagnostics: string[]; // recorder-internal problems (section 4, "Degrade"); never student errors
}

type Origin =
  | { origin: 'const'; text: string }
  | { origin: 'name'; name: string }
  | { origin: 'call'; site: number }
  | { origin: 'expr'; text: string; reads: string[]; calls?: number[] } // reads: bare names read, in source order, deduplicated; calls (svl-8r4): sites of the wrapped calls the expression certainly ran once (outermost only; none under a lambda, comprehension, conditional branch, later operand of and/or or chained comparison); omitted when empty
  | { origin: 'unknown' }; // at or after a starred argument

interface ImportBinding {
  name: string; // the bound name: `pd` for `import pandas as pd`, `numpy` for `import numpy.linalg`, `LinearRegression` for `from sklearn.linear_model import LinearRegression`
  module: string; // `import m` / `import m as x` / `from m import a`: m (`import a.b` binds `a`: module `a`)
  attr: string | null; // `from m import a [as b]`: a; null for `import m`
  dotted?: string; // svl-ac6: `import a.b.c` without `as`: `a.b.c` (a module for certain); absent otherwise
  sole: boolean; // the name is bound exactly once in the whole module (no other import, assignment, loop or with target, `def`, `class`, parameter, `except … as`, `del`, `:=`, comprehension target, in any scope) and the module has no `from m import *`
}

interface Site {
  id: number; // index into sites
  kind: 'call' | 'bind' | 'store' | 'ret' | 'import';
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  text: string; // exact source text of the node
  // kind 'call'
  func_text?: string; // source text of the callee expression ("model.fit", "pd.read_csv")
  func_line?: number; // the line CPython reports for the call (end line of the callee expression), only when it differs from `line`
  args?: Origin[];
  keywords?: Record<string, Origin>; // "**" for a double-starred argument: { origin: 'unknown' }
  unpack?: number; // the call is the RHS of a tuple-unpacking assignment with this many Name targets
  // kind 'bind'
  targets?: string[]; // Name targets in order; for a tuple target, the flattened names
  value?: Origin; // RHS origin for Assign/AugAssign/AnnAssign; absent for for/with targets and for destructuring targets (section 3)
  where?: 'local' | 'global' | 'nonlocal'; // M1–3: always 'local' (module)
  volatile?: true; // svl-35d: a target is a volatile name (section 3, "Volatile names"); set by `instrument`, absent otherwise
  // kind 'import' (svl-b4w, svl-i6s): one per `import` / `from … import` statement that runs in module scope (section 3, "Imports"); the statement is not rewritten, a hook after it records an `import` event
  imports?: ImportBinding[]; // the names the statement binds, in order
  // kind 'store'
  root?: string; // the root Name of the target (df in df.loc[m, "c"])
  value?: Origin; // RHS origin; only when the target is the whole left-hand side of Assign/AnnAssign and no target is a tuple, list or starred (section 3)
  index?: Origin[]; // svl-8r4: origins of the non-constant index operands of the target (`mask` in df.loc[mask, "c"] = 0), one per tuple element; omitted when empty, when a name is rebound by the statement, or when the statement has a `:=`
}

interface Scope {
  id: number;
  name: string; // "<module>"
  parent_event: number | null;
  lexical_parent: number | null;
  bindings: [event: number, name: string, token: Token][]; // event = index of the latest event started before the bind, -1 if none
}

interface ValueSummary {
  type: string; // DF, Series, array, sparse, int, float, complex, str, bytes, bool, None,
  // list[n], dict[n], tuple[n], set[n], or the class name (numpy scalars: the class name, e.g. float64, int64)
  shape?: number[];
  dtype?: string; // Series/array: dtype; DF: omitted (see dtypes)
  dtypes?: string[]; // DF: one per column in columns
  columns?: string[]; // DF: first 50 column names
  preview?: Preview; // omitted once the 1 MB preview budget is spent
  repr?: string; // scalars and other objects: reprlib.repr, max 40 chars
  attrs?: Record<string, Token>; // machines only (section 5)
  methods?: { name: string; doc: string }[]; // machines only, first summary of each class in a run (section 5)
  machine?: boolean; // true for machines (estimators, student class instances, configured classes)
}

type Preview =
  | { kind: 'table'; columns: string[]; index: string[]; rows: string[][] } // DF: 5 rows x 8 cols; Series: one column
  | { kind: 'matrix'; rows: string[][] }; // array / sparse: first 5 x 5 (1-D: one row)

type EventKind = 'function' | 'method' | 'constructor' | 'student_function' | 'expr' | 'store' | 'import';

interface Input {
  param: string; // signature name, "arrays[0]" for varargs, "arg0".. when binding fails, "self" for the owner of a data method
  origin: Origin['origin'];
  value?: Token; // absent when the input is drawn on the port instead of wired
  text?: string; // port text: const literal text, or a label value's text (section 5)
}

interface Event {
  i: number;
  ret: number; // index of the last event that started before this one returned (== i when none started inside it)
  site: number;
  scope: number;
  kind: EventKind;
  name: string; // callee __qualname__ ("train_test_split", "LinearRegression.fit"); expr/store/import: site text
  module: string | null; // callee __module__ ("sklearn.model_selection"); null for expr/store/import
  owner: Token | null; // method events: the bound instance
  inputs: Input[];
  outputs: Token[]; // tuple split per SPEC "Tuple returns"; None returns omitted; omitted when returns_self
  returns_self: boolean;
  mutates: [before: Token, after: Token][];
  count: number; // executions of this merge key so far, including this one
  slot?: true; // this is the replaceable "latest" record for its merge key (section 4)
  merge_key: string; // M1–3: "s<site>" (module scope only); M4 extends it per SPEC "Merge keys"
  error: EventError | null;
  interrupted?: true; // the call was running when the run was stopped or timed out
}

interface EventError {
  type: string;
  message: string;
  handled: boolean;
  propagated?: true;
}

interface RunError {
  type: string;
  message: string;
  line: number | null; // student line where it surfaced
  traceback: TracebackFrame[]; // student frames, library frames folded
}
type TracebackFrame =
  | { kind: 'student'; line: number; text: string; name: string; repeat?: number } // repeat: further identical consecutive frames (recursion), as CPython's "[Previous line repeated N more times]"
  | { kind: 'library'; count: number; modules: string[] }; // n consecutive library frames folded into one

type OutputEntry =
  | { i: number; stream: 'stdout' | 'stderr' | 'warning'; text: string }
  | { i: number; stream: 'figure'; png: string /* base64 */; width: number; height: number };
// i: the latest event started when the output was written, -1 before any event.
```

Rules:

- Every token in `events`, `scopes`, `attrs` and `mutates` has an entry in `values`.
- `events[*].i` increases with start time. Steps (section 8) follow `i`.
- The log for a given program and config is byte-identical across runs on CPython and Pyodide (with `random_state` fixed), except `output` texts that print timings and figures' PNG bytes. `id()` never appears.

## 3. Transformer (`transform.py`)

```python
@dataclass
class Instrumented:
    tree: ast.Module            # rewritten, fix_missing_locations applied
    sites: list[dict]           # Site dicts exactly as in section 2

def instrument(source: str) -> Instrumented   # raises SyntaxError unchanged
HOOK_NAMES = ("__rec__", "__bind__", "__store__", "__scope__", "__ret__", "__imp__")
UNWRAPPED_CALLS = frozenset({"super", "locals", "globals", "vars", "dir", "eval", "exec", "breakpoint"})
```

Rules for M1–3 (SPEC "Transformer rules", narrowed):

- Instrument the module body, class bodies at any depth reached without entering a function, and comprehensions and generator expressions there.
- **Do not instrument function or lambda bodies at all in M1–3.** No hooks inside `def`, `async def` or `lambda`, and no `__scope__`. Student functions and methods are recorded only where they are called from instrumented code, as opaque `student_function` / `method` events. M4 adds `__scope__`, `__ret__` and interior instrumentation.
- `Call` → `__rec__(site, func, *args, **kwargs)`, children first, keeping argument order and starred forms. A call whose `func` is a bare `Name` in `UNWRAPPED_CALLS` is not wrapped, but its arguments are still visited.
- Decorator expressions are visited like any other code (so `@lru_cache(maxsize=None)` records a call); the decorated `def` body is not.
- Assignment statements (`Assign`, `AugAssign`, `AnnAssign` with a value), `for` targets and `with … as` targets at module level → a `__bind__(site, {name: value, …})` statement after the assignment, or as the first statement of the body for `for`/`with`. Nested tuple and starred targets flatten to their Names. Subscript and attribute targets whose root is a `Name` → `__store__(site, <root name>)` after the statement. Statements directly in a class body get neither.
- `NamedExpr`, `import`, `del`, `except … as`, `match` captures, `global` and class/def names are not bound (resolution falls back as in section 5).
- **Imports** (svl-b4w, changed by svl-i6s). Each `import` / `from … import` statement that runs in module scope adds one `import` site: at the top level, and under `if`, `try`, `else`, a loop or a `with` (a conditional import that does not run gives no event, one that runs twice gives two). Not in a `def` or `class` body (function bodies are not instrumented at all, and a class body has no hooks), not relative, not `__future__`; a star import binds nothing and has no site. The statement is left exactly as written; the transformer puts a hook statement `__imp__(site)` right after it, and a marker `__imp__(site, True)` right before it (svl-wqe; the pre hook is the same `__imp__` builtin with a second argument, so `HOOK_NAMES` is unchanged). If the import raises, the post hook does not run, so a failed import gives no event, and the error surfaces as in plain Python. Side effects, `__import__`, repeated and conditional imports all run as in plain Python (tests). The hook records one event `kind: 'import'`, `name` = the statement text, `module: null`, no inputs, no outputs, `owner: null`, `merge_key: s<site>`, `count` and `slot` as for any site, `scope: 0`. It looks at no values and issues no tokens, so it cannot change the program. **Import events count toward `max_events`, but only the first `per_site` runs of a site are recorded**: later runs are silently skipped (no event, no `count`, no slot, no `limit_hit`), as hidden calls are, so an import in a long loop can neither flood the log nor use up the budget of later calls. The `import` sites are appended after all other sites, so every other site id is unchanged. The import event also carries `submodules?: string[]` (svl-ac6; omitted when empty): the names of a `from m import a [as b]` whose bound object is, right after the statement, a plain `types.ModuleType` with `__name__ == 'm.a'` (a submodule; `from os import path` is not, it is `posixpath`). The check reads the module dict and `__name__` of a real module only. The transformer computes `sole` for each bound name by walking the whole original tree (rule in `ImportBinding`). It is no longer a wire rule: the graph uses it to write `(module)` in the call box only when nothing can have rebound the name. Not caught: rebinding through `globals()[...]`, `setattr(module, …)` or `exec`.
- Origins: `Constant` and unary minus on a numeric constant → `const`. Tuples, lists, sets and dicts whose elements are all `const` → `const` with the source text. `Name` → `name`. A `Call` that is itself wrapped → `call` with its site id. Everything else → `expr`, with `reads` the `Name` loads inside it, excluding names under nested lambdas and comprehension targets.
- Bind and store sites take the span and text of the whole statement (`for`: the target; `with`: `expr as target`). `for` and `with` targets give no `__store__`. Annotations and function bodies are not visited; defaults are. Site ids are assigned in post-order (inner calls first).
- For `AugAssign` the bind `value` is an `expr` origin (text: the whole statement, reads: the target names then the RHS reads), not the RHS origin: `x += f(y)` must not wire f's output to x.
- `unpack` is set on a call site when it is the whole RHS of an assignment whose single target is a tuple or list of n plain `Name`s (no starred, no nesting).
- **No `value` on destructuring.** A bind or store site carries `value` only when no target of the statement is a tuple, list or starred target, or in the one `unpack` case (single tuple/list target of plain Names whose RHS is a wrapped call). Omitted for `a, *b = f(x)`, `a, b = c = f(1)`, `x[0], y = f(1)`, `a, b = c` and `(a, b), c = f(1), 2`: the names hold parts of the value, so an origin would be a false wire. A missing wire is acceptable.
- **Shadowed names.** A bare Name inside a comprehension that refers to one of that comprehension's own targets, or inside a class body that the class body itself binds, does not get a `name` origin: it is `{origin: 'expr', text: <name>, reads: []}`. Such names are also dropped from `reads` of other `expr` origins. (`n = 5; [f(n) for n in xs]` must not wire the outer `n` to `f`.)
- **Frame-sensitive callees.** The recorder makes each call from a `<student>` eval frame that shares the caller's globals and locals (section 4), so `sys._getframe(1)`, `locals()`/`eval`/`exec` aliases (`e = eval; e("x")`), pandas' `df.query("a > @t")` / `pd.eval` and `warnings.warn(stacklevel=...)` see the student's namespace, at the call's reported line, as in plain Python. Known limit: stack _listings_ made by student code (`traceback.format_exc()`, `traceback.extract_stack()`, `inspect.stack()`) show the recorder's frames (`_rec_hook`, `_rec`, `_call`) and the extra `<student>` frame; svl-a8j.4's `student_traceback` cleans only the tracebacks the runtime formats itself.

**Volatile names** (svl-35d). `instrument` marks a `bind` site `volatile: true` when any of its targets is a name the recorder cannot follow: a name that is `del`'d, declared `global` or `nonlocal`, bound by `:=`, an import, a `def` or `class`, `except ... as`, or a match capture, anywhere in the module (any scope: conservative); or every bind site when the module can rebind its globals reflectively: it names `globals`, `vars`, `locals`, `exec`, `eval`, `setattr`, `delattr`, `sys`, `__main__`, `importlib` or `inspect` (as a name, or as an imported module), uses an attribute `__dict__`, or has `from m import *` (`sys.modules[__name__].k = x`, `setattr(sys.modules["__main__"], "k", x)`, `import __main__; __main__.k = x`). The graph shows none of the targets of a volatile site as an alias (section 8), because the log cannot say that the name still refers to the object it was bound to. Nothing is rewritten differently: the flag is data only.

## 4. Recorder (`recorder.py`)

```python
@dataclass
class RunConfig:                       # JSON-serializable; same shape as TS RunConfig (section 7)
    draw_modules: list[str]            # default ["sklearn", "pandas", "numpy"]
    draw_builtins: bool                # default False (print, len, range, ... and their results)
    draw_container_methods: bool       # default False (methods of str, list, dict, set, tuple)
    machine_classes: list[str]         # extra machine classes, "module.QualName"
    wall_ms: int = 30_000
    max_events: int = 5_000
    per_site: int = 20                 # full executions per merge key before slotting
    preview_bytes: int = 1_000_000
    hash_cells: int = 100_000

class Recorder:
    def __init__(self, sites: list[dict], config: RunConfig | dict, emit: Callable[[dict], None] | None = None, *,
                 on_enter: Callable[[int, int], None] | None = None, on_exit: Callable[[int], None] | None = None,
                 namespace: dict | None = None): ...   # namespace: the student's globals (default: taken from the first hook frame)
    def install(self) -> None          # install_hooks() into builtins, and become the active recorder (hooks pass through when none is active)
    def uninstall(self) -> None        # stop recording; the hooks stay in builtins and pass through
    def add_output(self, entry: dict) -> None   # runtime seam: one finished OutputEntry, sent in the next batch and kept for log()
    def current_line(self) -> int | None        # student line of the innermost open recorded call (warning attribution)
    def final_status(self, status: str) -> str  # 'limit' instead of 'ok' when a cap was hit
    limit_hit: bool
    diagnostics: list[str]
    def flush(self, force: bool = False) -> None   # emit a 'batch' message (section 7) if anything is pending
    def close_open(self, exc: BaseException | None) -> None  # mark still-open events (error or interrupted)
    def log(self, status: str, error: dict | None) -> dict   # full EventLog (CPython record() path)
    current_event: int                 # latest started event index, -1 if none (used for output tagging)
```

Hook signatures, all positional-only in their leading parameters: `__rec__(site, fn, /, *args, **kwargs)`, `__bind__(site, mapping, /)`, `__store__(site, base, /)`. `__scope__` and `__ret__` are installed as pass-throughs in M1–3.

**Call filtering.** Recorded iff the callee's top-level module (from `inspect.getmodule`, or the `__module__` of a bound method's owner's type) is in `draw_modules`, or the callee is student-defined (function code filename `<student>`, or a class whose `__module__` is `__main__`), or builtins/container methods are toggled on. Everything else is called directly with no recording (fast path). Cache decisions per callable type/identity.

**Kinds.** `constructor`: `fn` is a class. `method`: `fn` is a bound method whose `__self__` is not a module and not a class. A bound method whose `__self__` is a class (a classmethod such as `DataFrame.from_dict`) is a `function` named `DataFrame.from_dict`. The `name` of a `method` event is `<owner class __qualname__>.<method __name__>` (`LinearRegression.predict`, not the defining class `LinearModel.predict`); owner types in `builtins` follow the container-methods toggle (`str`, `list`, `dict`, `set`, `tuple`, ...) or the builtins toggle. `student_function`: a student-defined plain function. Otherwise `function`.

**Inputs.** Map the arguments to parameter names with a cached `inspect.signature(fn)` (walking the parameters, so no per-call `bind()`). When the signature cannot be read, label positionals `arg0`, `arg1`… and keywords by name, and still make the call. For a data method, the owner comes first as `self`. Each input takes its origin from the site. Inputs are resolved per section 5. Only arguments the student passed are listed.

**Outputs.** Per SPEC "Tuple returns", using `site.unpack`. `returns_self` when `result is owner`.

**Mutation.** After every recorded call, check the owner, every input, and every tracked estimator reachable from them through `get_params(deep=True)`. Record each changed one in `mutates`. A version change found when an object is read as an input with no event to blame gives a new version with no producer (drawn as a source node, section 8).

**Expression events.** When an input has origin `expr` and its value has no token yet or is a scalar, record an event `kind: 'expr'` _before_ the consuming event: inputs are the tokens currently held by `reads` (section 5), outputs the value's new token. Do the same for a `call` origin whose inner site produced no recorded event for that object (it was hidden): it becomes an `expr` event with the inner site's text, `site` the inner site, `merge_key` `s<inner>`, and it does not count against `max_events`. The same rule applies to the value of a `__bind__` (the site is the bind site, `merge_key` `s<site>`). Other expr events are recorded for an argument at position `k` / keyword `name` of a call at site `S` with `site: S` and `merge_key: "s<S>.a<k>"` / `"s<S>.k<name>"`; for the owner of a method on data (`df["price"].mean()`), `"s<S>.self"`, where the owner expression is the callee text minus the method name and its `reads` come from parsing that text. An expr event's `name` is its expression text. `inputs` of an expr event: one `{param: <name>, origin: 'name', value}` per name read, then one `{param: <func_text>, origin: 'call', value}` per site in the origin's `calls` whose output was recorded as a single token (svl-8r4: `Pipeline([('s', StandardScaler())])`, `df['p'] > df['p'].median()`; hidden or failed calls give nothing). For an assignment that rebinds a name the expression reads (`w = w * 2`, `a += 1`), the read resolves to the name's _previous_ binding. An augmented assignment that changes a tracked object in place gives an expr event with `mutates` and no outputs. **Attribute reads with an existing token.** The rule above gives no event when the value already has a token (`m = models["rf"]`: the name is another label). One exception, in `__bind__`: when the RHS is an attribute chain on a plain name (`coefs = model.coef_`), the root name is not itself rebound, and the value's current token is neither the output of any recorded event (the recorder keeps the set of produced tokens) nor already an input of one (the set of consumed tokens: an earlier consumer would otherwise appear to be fed by a later producer), such as a machine's attribute that got its token from the machine's summary, record an `expr` event whose inputs are the names read and whose output is that _existing_ token. No new token is minted, so identity is not split; once the token has a producer, later reads are plain aliases. If no read name has a token the event is skipped. Only the `__bind__` value is covered; arguments and method owners (`f(model.coef_)`) still use the existing token directly (svl-8r4).

**Import events** (svl-i6s). Each executed import statement is an event `kind: 'import'` (section 3, "Imports"): a timeline step that places the imported object on the board. See "Import nodes" in section 6 for what the graph does with it.

**Store events.** `__store__` records `kind: 'store'`: inputs are the root's previous version (`param: 'target'`) and the RHS. `__store__` receives only the root, not the RHS object, so the RHS input depends on its origin (svl-8r4: an `expr` origin also gives one `value[<func_text>]` input, `origin: 'call'`, per entry of its `calls` that has a recorded single output): `const` gives `{param: 'value', text}`, `name` the named value, `call` the recorded output of that call (omitted when the call was hidden), and `expr` one input per name the expression reads, `param: 'value[<name>]'`, `origin: 'expr'` (the value itself has no token). Each `index` origin adds inputs the same way with `param: 'index[<name or func_text>]'` (`origin` `name`, `expr` or `call`; the root name is skipped, it is the target; constants and string labels add nothing). The output is a **forced** new version of the root, even if the fingerprint did not change.

**Errors.** An exception raised by the callee is recorded on the innermost recorded event with `handled: false` (and the `mutates` the failed call still made), and re-raised unchanged. Enclosing open events get `propagated: true`. If the student's code later continues in the same scope (the exception was caught), the recorder sets `handled: true` on the next hook call made outside the block that is still handling that exception (a call in an `except` or `finally` block that runs while it propagates does not count), or at `close_open` for an error that was not the exception that ended the run. If the event was already streamed it is sent again with the same `i` (section 7), so the assembled log matches `record()`. `close_open(None)` is a normal end, `close_open(KeyboardInterrupt)` marks calls still open `interrupted`.

**Re-entry.** While the recorder summarizes, fingerprints or binds signatures it sets a flag, and every hook passes through.

**Degrade.** Every recorder step runs inside `try/except Exception`. On an internal error, append a message to `diagnostics`, switch that hook to pass-through for the rest of the run, and continue the student's code. A recorder bug must never become a student-visible exception or change the program's behaviour.

**Caps.** The first `per_site` executions of a merge key are recorded in full. After that, each execution is still recorded in full, but as `slot: true`, with a fresh `i`, replacing the previous slot of that key (the assembler drops the old one). Bindings from `bind` sites follow the same rule per site: past `per_site`, the recorder sends the binding with `slot_key = "b<site>.<name>"` (the fifth element of the batch `bindings` tuple, section 7). `max_events` counts full and slot records. Once it is reached, recording stops, the code keeps running, and the status at the end is `limit` (`Recorder.final_status`). Hidden calls never count. Binding rows are not events but are capped too: more than `4 * max_events` of them also stops recording with `limit`, so a long loop cannot grow the log without bound.

**Streaming.** `emit` receives the `batch` message of section 7 without `runId` (the worker adds it): `{type: 'batch', events, open, values, bindings, output, diagnostics}`. At every hook entry, and again once a call is pushed on the open stack, if 100 ms have passed since the last flush, flush. Flush on `close_open`. When `emit` is set, also call `on_enter(i, site)` / `on_exit(i)` callbacks if they are provided (the worker uses them to write the current call into a SharedArrayBuffer, section 7).

## 5. Values (`values.py`)

```python
class ValueTable:
    def classify(self, obj) -> Literal['scalar', 'label', 'reference']
    def token(self, obj) -> str        # reference: current "v<n>.<ver>" (assigning n on first sight); never for scalars
    def fresh_scalar(self, obj) -> str # new "s<n>" every call
    def check(self, obj) -> tuple[str, str] | None   # fingerprint compare; bumps the version and returns (before, after) on change
    def bump(self, obj) -> tuple[str, str]           # forced bump (store)
    def summarize(self, token: str, obj) -> None     # writes values[token] once; respects the preview budget
    def take_new_summaries(self) -> dict[str, dict]  # summaries since the last call (for batches)
    def is_machine(self, obj) -> bool
```

**Classification** (decided here, extending SPEC "Value model"):

- `scalar`: `int`, `float`, `complex`, `bool`, `str`, `bytes`, `None`, every `numpy.generic` (`np.int64`, `np.bool_`, `np.float64`…), pandas scalars (`pd.NA`, `pd.NaT`, `Timestamp`, `Timedelta`, `Period`), `Ellipsis`, and tuples and frozensets whose items are all scalars (recursively). These never match by identity.
- `label`: functions, builtins, methods, classes, modules. Drawn as text on the port (`func = np.log1p`), never wired: `Input.text` is the qualname, and `value` is absent.
- `reference`: everything else.

**Name resolution for scalars.** `__bind__` stores, for each name, `(token, obj)`. A `name` origin whose value is a scalar resolves to the bound token only when `bound_obj is value` (identity guard). Otherwise it gets a fresh token with no producer (a source node labelled with the name). This guard prevents false wires when a name was rebound by something the recorder doesn't see (`:=`, `import`, `global` writes from uninstrumented functions).

**Reads of `expr` origins.** Each name in `reads` resolves to its latest module binding: references go to the _current_ version of the bound object, scalars to the bound token. A name with no binding contributes nothing.

**Fingerprints.** Use the SPEC "Versions" fingerprint: shape, columns, dtypes; an estimator's attribute names and the identity of their values; a container's length and item identities. Add a content hash for tables and arrays at or under `hash_cells` (`pd.util.hash_pandas_object`, or `hashlib` over `ndarray.tobytes()`). Fall back to structural only when hashing raises (unhashable cells).

**Object table.** Keep `id → n` with a `weakref.finalize` for objects that support weak references. Keep others (lists, dicts, tuples, sets) alive in an LRU bounded by 256 entries and 16 MiB of estimated size (shallow size plus about 100 bytes per item for the fingerprint) (newest always kept); an evicted object also loses its `id → n` entry, so a later sighting gets a fresh object number.

**Machines.** `isinstance(obj, sklearn.base.BaseEstimator)` (import lazily), or a class whose `__module__` is `__main__`, or a class in `machine_classes`. `attrs` for estimators: `get_params(deep=False)` plus public attributes ending in `_` (from `vars`). For student classes: public entries of `vars(obj)`. Scalar attrs get fresh tokens per summary.

**Methods.** A machine summary may carry `methods: [{name, doc}]`: the class's public routines (no leading underscore; functions, static and class methods, builtin methods; properties and other descriptors excluded), `doc` the first non-empty docstring line clipped to 80 characters (`""` if none), sorted by name, at most 40. It is read from the `__dict__` of each class along the MRO (nearest definition wins), so no student code, property or `__getattr__` runs; it is computed under `reentry`. To keep versions small it is written once per class per run (the first machine summary of that class after `reset`, any depth), not on every version. Consumers find a class's methods by looking for any `values` entry with the same `type` that has `methods`. Classes without public routines get no field.

**Attrs depth and cap.** Only the summarized machine's own attributes are expanded: attribute values get a token and a summary but, even if they are machines, no `attrs` of their own. At most 64 attributes per machine are kept, in sorted name order. The summary of a token is written (`{type}` at least) before any student `__repr__` runs; a `BaseException` from a repr (stop) propagates.

**Known limits.** Fingerprints hold no strong references (weakref per weakref-able item, id and type otherwise). Objects that cannot be weakly referenced (lists, dicts, tuples, sets) that were given a token are kept alive only while they are among the 256 most recently used (and within 16 MiB of estimated size), so a deleted container's `__del__` can run late by at most that window; an evicted object that is still alive is a missing wire, never a false one (it gets a fresh token on its next sighting). Named and returned containers that cannot be weakly referenced stay alive while they are among the recently used ones, and a container held by a name until that name is rebound, so their `__del__` can run late; recursion headroom is about 4 frames shorter per nested recorded call (each wrapped call adds the hook frames). Mutation of an object nested in an attribute (`est.coef_[0] = 1`) is invisible to the parent; the recorder checks tracked attributes itself.

**Wall-clock timings.** Values that come from the wall clock get the fixed repr `<varies: wall-clock timing>` (`values.TIMING_REPR`), so logs are deterministic and the live view shows stable text: the `refit_time_` attribute of a machine, and the values of the keys `mean_fit_time`, `std_fit_time`, `mean_score_time` and `std_score_time` in any `dict` summary (`GridSearchCV.cv_results_`). Tokens, versions and the program's own objects are unaffected; only the summary `repr` changes.

**Summaries.** Pre-format with `str()` of each cell, truncated to 40 characters. `NaN` shows as `NaN`. Count the preview budget in UTF-8 bytes of the JSON-encoded preview.

## 6. Runtime (`runtime.py`, `tracebacks.py`, `mpl.py`)

```python
def run(source: str, config: dict, emit: Callable[[dict], None], *, on_enter=None, on_exit=None) -> None
    # emits exactly: {'type':'started', 'sites': [...]}, then batches, then {'type':'done', ...} (section 7)
    # SyntaxError: emits started with sites [] then done(status='error', error with line) — nothing runs
def record(source: str, config: dict | None = None) -> dict
    # CPython/test path: run() with an in-memory assembler; returns the EventLog (section 2)
def reset_between_runs() -> None       # close matplotlib figures, pd.reset_option('all'), reset sklearn.set_config, run `runtime.after_reset_hooks`, clear recorder tables
# pd.reset_option('all') also wipes pandas options the worker set at startup: the worker appends a function that
# re-applies them to `machines.runtime.after_reset_hooks`. numpy, rcParams, os.environ and random state are not reset (SPEC "Between runs").
```

- Compile with filename `<student>` and register the _original_ source in `linecache`.
- Run in the `__dict__` of a fresh module named `__main__`, which is also `sys.modules["__main__"]` during the run (so student classes, dataclasses and `inspect` find their module), with `__builtins__` and `__file__ = "<student>"` set. Everything the run changes (streams, `input`, recursion limit, `__main__`, warning filters and hook, `MPLBACKEND`) is restored before `done`. Each restore is registered before its change and run independently, so an interrupt or error anywhere in setup or teardown restores everything and `done` is still emitted (a late `KeyboardInterrupt` gives `stopped`). `SystemExit` is not an error: `exit()` ends the program with status `ok`, and a non-int argument is written to stderr as plain Python does. `KeyboardInterrupt` gives status `stopped` and `error: null`.
- Redirect `sys.stdout` and `sys.stderr` to writers that append `OutputEntry` tagged with `recorder.current_event`. Merge consecutive writes with the same tag and stream; the pending entry is committed when the tag or stream changes, when a recorded call starts, and at the end of the run (so the log does not depend on timing). Warning and figure entries are never merged.
- **Output during an import (svl-wqe).** Text printed while an import statement runs (`import this`, a module that prints or warns, nested imports) belongs to that import's step. The import event does not exist until the post hook, so the pre hook commits the pending text (through `Recorder.commit_output`, set by the runtime) and remembers `len(output)` and `current_event`; the post hook commits again and retags the entries added since (stdout, stderr and warning) from the old tag to the new event index. Nothing is held back or streamed late: text in a pending entry is only committed (and so streamed) when the tag changes, a recorded call starts, or a batch needs it, and none of that happens while library code runs an import, so the entries are still unsent when retagged. Output elsewhere streams as before. A failed import, a star import, and a skipped import (past `per_site`, or `max_events`) give no event, so their output keeps the previous tag (`-1` before any event). Known limit: if a batch were flushed from another thread during the import, the entries already sent keep the old tag.
- Warnings: override `warnings.showwarning` to emit `stream: 'warning'` entries formatted as `"<line>: <Category>: <message>"`. The line is the student line of the innermost open recorded call (or the warning's own line if it is `<student>`). Do not change warning filters.
- `builtins.input` raises `RuntimeError("input() is not supported here")` during a run. Plain Python with stdin closed raises `EOFError`, so `except EOFError` does not catch it here.
- Recursion: raise `sys.setrecursionlimit` to twice its value during a run (each wrapped call adds one frame). Verified on Pyodide 314.0.8 (svl-bwv.2): pure-Python recursion to depth 1900 works and runaway recursion raises `RecursionError` at the doubled limit, so 2x stays. Recursion that passes through C frames (`map`, `sorted(key=)`, `np.vectorize`) overflows the wasm stack and kills the interpreter ("Pyodide has suffered a fatal error") even at limit 500, so it is a Pyodide property and not caused by the doubling; the worker turns it into a worker error, the client reports `status: error` and starts a new worker.
- Wall clock: the worker enforces `wall_ms` (section 7). `runtime.py` itself doesn't time out.
- `tracebacks.py`: `student_traceback(exc) -> list[TracebackFrame]`. Drop frames from `machines/*`. Keep `<student>` frames with their linecache text. Fold runs of other frames into `{kind:'library', count, modules}` (`modules`: top-level module names, in order, deduplicated). Each recorded call adds a second `<student>` frame at the same line; identical student frames with a dropped recorder frame between them are merged, and runs of identical consecutive student frames (recursion) become one frame with `repeat` = the number of further occurrences. `RunError.line` is the deepest student frame. A `SyntaxError` has one student frame with the offending line's text.
- `mpl.py`: if `matplotlib` is imported by the run, force the `Agg` backend before the import completes, and patch `plt.show` to emit each open figure as a `figure` output entry (PNG, base64, 100 dpi) and close it.

## 7. Worker protocol and app state

`packages/log/src/messages.ts`:

```ts
type ToWorker =
  | { type: 'init'; interruptBuffer?: SharedArrayBuffer; currentCall?: SharedArrayBuffer }
  | { type: 'run'; runId: number; source: string; config: RunConfig; debug?: 'plain' | 'timing' } // `debug`: measurement only, never set by the page; see below
  | { type: 'file'; name: string; bytes: ArrayBuffer } // written to /home/pyodide/<name>
  | { type: 'docs'; reqId: number; target: DocTarget }; // section 12

type FromWorker =
  | {
      type: 'progress';
      phase: 'pyodide' | 'packages' | 'recorder' | 'datasets' | 'matplotlib';
      done: number;
      total: number;
    }
  | { type: 'ready'; versions: Record<string, string> } // pyodide, python, numpy, pandas, sklearn
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
  | { type: 'docs'; reqId: number; doc: Doc }; // section 12

interface OpenEvent {
  i: number;
  site: number;
  kind: EventKind;
  name: string;
  module: string | null;
}
interface RunConfig {
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
```

**Debug run option (measurement only).** `run.debug` is set only by `scripts/measure.ts`, never by the page. `'plain'` execs the source with no recorder (stdout discarded) and answers with `started` (no sites) and `done` `ok`. `'timing'` runs the recorder normally and times content hashing. Both write one line `[machines-debug] {"mode","ms","hash_ms"?}` to the worker's `console.log` (`ms` is the in-Python time; `hash_ms` only for `'timing'`). Nothing from this path enters the event log or any other message.

- An event is sent once it has finished (or in its slot form), and may be re-sent with the same `i` when its error is later found to be handled (`handled` flips to `true`); the assembler replaces by `i`. A re-sent slot event is dropped if a newer slot event for its merge key has arrived. `open` is the full stack of started, unfinished recorded calls at flush time, outermost first.
- `currentCall` (only when `crossOriginIsolated`): an `Int32Array(2)` = `[i + 1, site]` of the innermost open recorded call, `0` when none, written by `on_enter`/`on_exit`.

**Assembler** (`assemble.ts`): `createAssembler(runId?: number) → { push(msg: FromWorker): void; finish(status?: RunStatus, currentCall?: { i: number; site: number } | null): EventLog; snapshot(): EventLog }`. `finish`'s `status` overrides the one from `done`; `currentCall` is the decoded buffer (`i = buffer[0] - 1`), passed by the client when it kills the worker.

- Messages with a `runId` other than the current one are ignored. `started` with a `runId` <= the current one is ignored; a higher one resets the assembler. When `createAssembler(runId)` is given a `runId`, only that run is accepted, including the first `started`.
- Each batch's `open` replaces the stub map (it is the full stack at flush time), minus events already finished. A slot event whose `i` is lower than the existing slot for its merge key is dropped. A binding with a `slot_key` replaces any earlier binding in the same scope with that key, unless the earlier one has a higher event; `Scope.bindings` stay 3-tuples, sorted by event. An interrupted event's `count` is the largest `count` seen for its merge key plus one. `done` with `ok`, `error` or `limit` drops any remaining open stubs. `snapshot()` has status `ok` and `error: null` until `done`, then the done status and error, and leaves out open stubs. Scopes other than 0 seen in `bindings` get a placeholder scope (`<scope n>`) until M4 sends real ones. Interrupted events from stubs take `kind`, `name` and `module` from the stub; the one from `currentCall` is `kind: 'function'`, `name` the site's `func_text`, `module: null`; both have `scope: 0` and `merge_key: 's<site>'`.
- The `currentCall` path recovers only the innermost call (kind `function`, name = `func_text`, no owner). Without `crossOriginIsolated` there is no buffer, so a hang yields no interrupted event (an M1 limitation). If the worker crashes, the client calls `finish('error')` and supplies the `RunError` itself.
- `validateLog(x: unknown): EventLog` (`validate.ts`) throws an `Error` naming the path of the first violation, including the rule that every token has a `values` entry.
- A slot event replaces any earlier event with the same `merge_key` and `slot: true`.
- `open` stubs are kept until a later batch carries the finished event.
- `finish('timeout' | 'stopped')` is called by the client when the worker is killed. It turns each remaining open stub, plus the `currentCall` call if no stub or finished event has its `i` (it may be an outer call with finished inner events, so its `i` can be lower than theirs), into an `Event` with `interrupted: true`, empty outputs and `ret = i`.
- Cross-check: assembling `fixtures/streams/<p>.jsonl` gives `fixtures/logs/<p>.json` exactly.

**RuntimeClient** (`runtime/client.ts`):

```ts
class RuntimeClient {
  constructor(opts: {
    onProgress(p): void;
    onReady(v): void;
    onState?(s): void;
    onError?(msg: string): void;
    workerUrl?: URL;
    createWorker?(url: URL): WorkerLike;
  }); // the page passes createWorker with a literal `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` (Vite only bundles that form); tests pass a fake
  state: 'loading' | 'ready' | 'running' | 'restarting';
  run(source: string, config: RunConfig, onUpdate: (log: EventLog) => void): Promise<EventLog>; // onUpdate at most once per animation frame
  stop(): void; // interrupt; terminate + restart if no 'done' within 2 s or not isolated
  writeFile(name: string, bytes: ArrayBuffer): Promise<{ rows?: number }>;
  docs(target: DocTarget): Promise<Doc>; // section 12
  restart(): Promise<void>; // "Restart Python"
}
```

The wall clock (`config.wall_ms`) is enforced by the client and goes through the same path as `stop()`, but finishes with `timeout`. It starts when `started` arrives (the worker may first be loading imports such as matplotlib); until then a 15 s grace plus `wall_ms` bounds the wait. A `done(stopped)` that follows a stop request is relabelled `stopped` or `timeout` by the client; any other `done` status is kept. A worker `error` event mid-run finishes the run with status `error` and a `WorkerError` `RunError`, then respawns; during load it calls `onError` and does not loop (`restart()` retries).

**Worker** (`runtime/worker.ts`) on start: load the self-hosted Pyodide from `/pyodide/` with progress messages. Load numpy, pandas, scipy and scikit-learn. Write `python/machines/*.py` (bundled with `import.meta.glob('…/python/machines/**/*.py', { query: '?raw', eager: true })`) to `/home/pyodide/machines/`. Write the datasets from `course.ts`. Install the hooks. Send `ready`. Before each run, call `pyodide.loadPackagesFromImports(source)` (this is how matplotlib loads lazily; while it loads for code that imports matplotlib the worker sends `progress` phase `matplotlib` 0/1, then 1/1, and the status line reads "Loading matplotlib…"), then `machines.run`. Translate `emit` dicts to messages with `toJs({ dict_converter: Object.fromEntries })`, then replace `undefined` (Python `None`) with `null` and BigInt with Number. Datasets are fetched from `/datasets/<name>` (`packages/web/public/datasets/`, a copy of `fixtures/data/listings.csv`). The worker keeps a stack of open calls so `on_exit(i)` restores the outer call in `currentCall`. The interrupt buffer is zeroed at the start and end of each run. `file` messages return a CSV row count of non-empty lines minus the header.

**App store** (`store.ts`, zustand), the single source of state shared by the UI beads:

```ts
interface AppState {
  runtime: { state: RuntimeClient['state']; progress: string; versions?: Record<string, string> };
  source: string;
  setSource(s: string): void;
  origin: 'starter' | 'autosave' | 'link' | 'edited'; // see section 10.14: link code is never auto-run and never autosaved until edited or run
  log: EventLog | null;
  model: GraphModel | null;
  running: boolean;
  elapsedMs: number;
  step: number;
  setStep(n: number, single?: boolean): void; // clamped to 0..model.steps.length (section 8) when a model exists. `single` marks a one-step move (step buttons, arrow keys); `stepSingle` keeps it for the two-pane view's animation (svl-61q.3), every other change sets it false
  stepSingle: boolean;
  view: 'two' | 'full'; // the diagram pane's view (svl-61q.4): two-pane shelf and stage (default) or the full diagram; localStorage `machines.view`
  setView(v: 'two' | 'full'): void;
  runSeq: number; // incremented at each Run (not the worker's runId); the diagram resets per-run layout state on it
  runSource: string | null; // the source text of the last run; log.sites positions refer to it
  selectNode(id: string | null): void; // a box click: selection = { node, pinned: true } and step = that node's latest execution at or before the current step (else its first one)
  selection: { node?: string; edge?: string; pinned?: boolean };
  expanded: Set<string>; // M4; empty in M1–3
  run(): Promise<void>;
  stop(): void;
  restart(): Promise<void>; // restart: "Restart Python" (svl-bwv.2)
}
```

`run()` clears `log`, `model` and `selection` and sets `step` 0 at once, so nothing of the previous run is linked against the new `runSource`. The slider then follows the newest step while streaming (a new run starts at its end; a student who stepped back stays put) and the run ends with it at the last step.

## 8. Graph model, timeline and renderer

`graph.ts`: `buildGraph(log: EventLog, opts?: { expanded?: Set<string>; fold?: boolean; unfold?: ReadonlySet<string>; maxNodes?: number }): GraphModel`. Pure and deterministic. `fold` (default true) folds unnamed temporaries (below); `unfold` lists folded ids to draw as boxes; `maxNodes` defaults to `MAX_NODES` = 600.

```ts
interface GraphModel {
  nodes: GNode[];
  edges: GEdge[];
  steps: number[] /* event i's, sorted */;
  tooMany?: number;
  truncated?: { shown: number; total: number; line: number }; // with tooMany: boxes shown, total, source line of the last one shown
  folded?: number; // number of chips (edges with `chip`)
}

type GNode = CallNode | InstanceNode | ExprNode | StoreNode | SourceNode | ImportNode;
interface NodeBase {
  id: string;
  parent: string | null;
  order: number; /* source order: site line, col */
}
interface CallNode extends NodeBase {
  kind: 'call';
  mergeKey: string;
  name: string;
  module: string | null;
  executions: Execution[]; // every recorded execution, sorted by i
  inPorts: Port[];
  outPorts: Port[];
  student: boolean; // student_function: collapsible in M4
  importedFrom?: string; // svl-i6s: the module the callee name was imported from (`sklearn.linear_model`, `pandas`); the box writes `name (module)`. Not a wire
}
interface Execution {
  i: number;
  ret: number;
  inputs: Record<string /*port id*/, Token>;
  outputs: Record<string, Token>;
  count: number;
  owner: Token | null;
  error: EventError | null;
  interrupted: boolean;
}
interface InstanceNode extends NodeBase {
  kind: 'instance';
  className: string; // the value's type: LinearRegression, DF, Series, array, list[3]
  varName: string | null; // "model: LinearRegression", "X_train: DF"; each new object bound to the same name gets one more prime (`df`, `df′`, `df″`)
  createdAt: number; // i of the creating event (constructor, a function or method returning it, or an expr)
  createdBy: string | null; // id of the call or expr node that created it (the constructor box, read_csv, a method box inside another box, an expr node); null only for a lazy instance
  params: { name: string; text: string }[]; // constructor const/label args (also ports of the constructor box)
  versions: { i: number; token: Token; kind: 'new' | 'mutate' | 'store' }[]; // the instance's versions with the event that made each; kind: `new` = the first version of an object (a box merged from a loop gets one `new` per pass: v4.0, then v15.0 is another object, not v4.1 changed), `mutate` = a method changed it in place, `store` = an item/attribute assignment did (svl-tcy)
  aliases?: { name: string; object: string; from: number; until: number | null }[]; // svl-35d: the other names bound to the box's objects, one interval per (name, object): `object` is the object key (`v12`) the name is bound to over `from <= current < until` (`from`: the `at` of the scope-0 binding; `until` null: still bound at the end of the run). Per step, not cumulative: rebinding a name to an object of another box closes its interval, and rebinding to another object of the same box (`prev = cur` in a loop) closes it and opens one for the new object. Names of volatile bind sites (section 3) are never listed, and neither is the box's own name (`varName` without primes). Omitted when none
}
interface ExprNode extends NodeBase {
  kind: 'expr';
  text: string;
  executions: Execution[];
}
interface StoreNode extends NodeBase {
  kind: 'store';
  text: string;
  executions: Execution[];
}
interface SourceNode extends NodeBase {
  kind: 'source';
  label: string;
  token: Token;
}
interface ImportNode extends NodeBase {
  kind: 'import'; // svl-b4w, svl-i6s
  name: string; // the bound name (`pd`, `LinearRegression`)
  source: string | null; // the module in parentheses after the name: `pandas`, `sklearn.linear_model`, `sklearn.linear_model.Ridge` for `from … import Ridge as R`; null when it equals `name` (`import numpy`)
  site: number; // the `import` site
  executions: Execution[]; // one per run of the statement; inputs and outputs are empty
}
interface Port {
  id: string;
  param: string;
  typeLabel: string;
  nameLabel: string | null;
  constText?: string;
  changedInPlace?: boolean;
}
interface GEdge {
  id: string;
  from: {
    node: string;
    port: string | null; /* null: node without ports (instance, expr, store, source) */
  };
  to: { node: string; port: string | null }; // null: same
  dashed: boolean; // into or out of an expr node
  uses: { i: number; token: Token }[]; // per consumer execution: which value travelled
  chip?: { node: string; token: Token; type: string; shape: number[] | null }; // svl-lo6: a folded temporary, see "Folded temporaries"
  nameLabel: string | null; // the bound name of the latest token in the drawn scope; each new value bound to a name gets one more prime in time order (`X`, `X′`, `X″`, capped at `‴`)
}
```

Construction follows SPEC "Graph construction" with these decisions:

- Method boxes are one per (owner instance, method name) inside that instance (decided, svl-2gm): two `enc.transform` calls, at the same or different sites, share one `transform` box with `count` 1, 2 and a x2 badge; `for m in models: m.fit(X, y)` gives one `fit` box in each model's instance, and `models["rf"].fit(...)` is drawn on the right instance. Node id is `n:m<h(method name)>@<instance id>`. `count` is per box (the sum over its sites of the site's count minus other boxes' executions at that site). Each execution's wires come from that execution only: a port can have several edges (one per distinct producer), each with its own `uses`; use `StepState.activeEdges` to show only the running execution's wires. `Execution.owner` is the owner token (null for non-methods). A box's `order` is the smallest site order of its calls, and its out-port `nameLabel` is that of the latest execution.
- A constructor of a machine is an ordinary call node (name e.g. `LinearRegression`, `parent: null`, args on in-ports as for any call) with an `out:0` port, and an edge from that port to the instance border (`createdBy`). The instance's `params` still lists the constructor's const/label args (the attribute list shows them). Constructor args that are references are wired into the constructor box, not the instance. A constructor in a loop gives one box and one instance. The creating edge's single `use` has `i` = the creator's `ret` (the instance has no execution of its own).
- Method slots: the method boxes of an instance exist in the model from the instance's `createdAt` (`stateAt` shows them from then, in `uncalled`) until the method's first execution. Only methods the run calls on that instance are boxes; the class's other public methods are the renderer's "more methods" list (svl-0qe, below).
- `make_pipeline(...)` is a function box whose output creates an instance node (`createdBy`). Step instances wire into it. There are no nested step boxes in M1–3 (decided).
- A `method` event whose owner is an object (any reference value: data or machine; svl-skw) is a call node with `parent` set to the owner's instance node, owner input (`self`) not drawn as a port. Only a method whose owner is a scalar keeps a `self` in-port.
- An object passed as an argument (a DataFrame, a model, a list) is an edge from its instance border (`port: null`); the wire's `nameLabel` is null.
- `returns_self` gives no out-port. `mutates` on any object only adds a version `{ i, token: after, kind: 'mutate' }` to its instance; a `store` event whose output object already has a box adds `{ i, token: out, kind: 'store' }` (svl-tcy); the first version of each object is `kind: 'new'` (svl-skw: data no longer gets an `out:mut:` port; `Port.changedInPlace` and `out:mut:` ids remain in the type but are produced only for a non-object `before`, which the recorder does not emit).
- Loop-carried boxes (svl-35d): a box holds one object per pass. The first pass's creator is `createdBy`. Each later object that an event certainly output (it is in that event's `outputs`, and no other box holds it) gets its own creation wire from the node and port of that event when they differ from the first creator's: `cur = prev.sort_values(...)` with `prev = cur` has one wire from the `sort_values` box in `base` (pass 1) and another from the `sort_values` box inside `cur` (passes 2 and up; a wire from a method box to the box that holds it, uses one per pass). A wire is never drawn for an object that already had a box, and nothing is guessed: an object whose creating call is not recorded gets no wire.
- Expr nodes whose output reaches no call/store/instance node are dropped, transitively. An expr whose output is an object creates that object's instance (`createdBy` = the expr node id, creating edge from `port: null`, dashed), so it is kept; an expr that returns an object which already has a box adds no box and no edge.
- More than `MAX_NODES` (600) nodes after merging and folding: return only the first 600 by `order`, set `tooMany` to the total and `truncated` to `{shown, total, line}`; the diagram pane and the event list say "Showing the first N boxes (up to line L)". 600 is where the dense worst case (every box 3 ports and 3 wires, 24 instances with children) still lays out in under 10 s; the 98-line pandas fixture `large_pandas` has 460 boxes unfolded (364 folded), about 0.7 s.
- Port and node ids are stable across re-runs of the same source, so the layout stays put. Ids are `n:<h>` (call), `i:<h>` (instance), `x:<h>` (expr), `t:<h>` (store), `src:<consumer id>:<param>` (source), with `<h>` = hash of the site's kind and text plus the occurrence number among sites with equal text. They use no site ids or tokens, so editing an unrelated line (even adding one) keeps them. Port ids: `in:<param>`, `out:<k>` (k = index in `outputs`), `out:mut:<param>` (changed in place).

**Folded temporaries** (svl-lo6). With `fold` (default), an object (reference value, key = token up to the dot) folds into a **chip** on its wire when ALL hold: no scope binds it to a name; no event mutates it; it is not made by a `constructor` event; exactly one scope-0 event outputs it, and no other object shares that output slot (site, index); it has exactly one use in the whole log, as an input port or as the owner of a method call, by a scope-0 event that is not an `expr` event and runs after the producer. The box is not drawn; one edge `f:<box id>` runs from the producer's node and port straight to the consumer's port, with `uses: [{i: consumer event, token}]` (exactly that token) and `chip: {node: <the box id it would have>, token, type, shape}`. When the temporary owned a method (`df["a"].isna()`), the method box is top level (`parent: null`) with an `in:self` port, fed by the chip wire; its executions carry `inputs["in:self"]`. Named objects, loops (one box, many objects), models and anything used twice keep their boxes. `unfold: Set(chip.node)` draws chosen ones as boxes; `fold: false` draws all. The no-false-wires check runs for both forms and, for each chip, re-derives from the log that the object is unnamed, unmutated, output once and used once, by the wire's consumer. The renderer draws a chip as a dashed pill `+ <type> (<shape>)` on the wire (`.md-chip`, focusable, `aria-label` "temporary ..., press Enter"); a click or Enter reports `onClickEdge(chip edge id)`, and the web app expands it (`store.unfold`). The web diagram pane also has "All objects" (fold off) and "Follow" (pan and zoom to the current step's boxes at 80% or more; a manual pan or zoom pauses it until the next step).

**Import nodes** (svl-b4w, rewritten by svl-i6s). An `import` event makes one `ImportNode` per name its site binds (`import numpy as np, pandas as pd` is one step and two nodes, `np` first), revealed at that step, not at the first call. Unused imports are shown: every executed import places an object (decided with the owner). Id `m:<h of the import site>.<h of the name>`; `order` is the site's order plus 0.01 per name, so imports sit in source order among the other boxes. The node has no edges at all (the old callee edges and `MAX_CALLEE_WIRES` are gone). A statement that runs again adds an execution to the same nodes (merge key = site). An import that did not run (`if False:`, a failed import) has no node. Import nodes count toward `MAX_NODES` and are cut by source order like any other. The timeline treats an import node like a call node: `first` is its first execution, `activeExecution` and `currentNode` follow it; a multi-name statement makes its first name the current node. The `(module)` in a call box (`CallNode.importedFrom`, section 8 `callModules`) is separate and still needs the old conditions, because it makes a claim about the call: the callee is a bare dotted name (`pd.read_csv`, `LinearRegression`; not `pd.read_csv(x).head` or `a[0].f`) whose root name has a `sole` binding (section 3), the call site lies textually after the import statement, and an event of that import ran before the call (a call before it saw another binding, for instance a builtin the import later shadows). Nothing is guessed. When the binding is a module for certain (svl-ac6: `import a.b.c` has `dotted`; a `from m import a` whose import event lists it in `submodules`), the label is the full module: for `import numpy.random`, `numpy.random.default_rng()` gives `numpy.random`, and `numpy.zeros()` or `numpy.linalg.norm()` give `numpy` (the longest prefix the callee shares with the import path; the rest may be attributes); `from sklearn import linear_model; linear_model.LinearRegression()` gives `sklearn.linear_model`. Without that certainty the shorter label stays (`sklearn`). For `from m import Ridge as R` the source is `m.Ridge` and the box shows `m` (a trailing `.<call name>` is cut).

Decisions made while building `graph.ts` (SPEC was silent):

- Edges are keyed by endpoints (one edge per from/to pair); `uses` has one entry per consumer execution. Ports exist only on call nodes. Edges into and out of expr, store, source and instance nodes use `port: null`; `to.port` is nullable for that reason (contract change). An edge is `dashed` when either end is an expr node.
- An **object** is any reference value: a token starting with `v` (`isObject` in `graph.ts`; `values[t].machine` no longer decides). Its tokens map to an instance by object number (`v12.*`), so any version resolves to the same instance and one object is never in two boxes. Instances merge by creating merge key (and output index). An object with no producing event gets a lazy instance (`createdAt` = first event that mentions it). Scalars (`s` tokens) are never instances: they keep ports/labels/source nodes. An output that already has a box (call returned its argument) adds no instance and no edge.
- A function that returns an object (`read_csv`, each of `train_test_split`'s outputs, `predict`) has an out-port for it, and an edge from that port to the instance border (`createdBy`), so layout can place the instance below the function box. A method box inside a box `A` that creates box `B` (`df.dropna()`) draws that edge out of `A`. A failed constructor is a plain call node with the error.
- Constructor args: const and label args are `params` text; scalar args use `Input.text`, else the value's `repr`; reference args show their type in `params` and are wired to the constructor box's in-ports.
- Port text: a wired in-port has `typeLabel` = the value type for a scalar and `''` for an object (its box shows type and shape), and `param` is the gray name (`nameLabel` is null on in-ports). Const and label inputs have `typeLabel: ''` and `constText` = the full string `param = text`. Out-port `param` is the output index as text, `nameLabel` is the bound name, `typeLabel` is the type for a scalar and `''` for an object. `mutates` on any object only adds an instance version `{ i: event.i, token: after }` (including nested machines such as a scaler inside a pipeline).
- Name labels: names come from scope 0 bindings, matched by object (`v12`) for reference values and by token for scalars. The label is the first name bound to the value, plus one prime per distinct value bound to that name before it (time order; at most three, so a loop's per-pass scalars stop at `‴`). Edges from source nodes and instances have `nameLabel: null` (the node says it); so does any edge into an object's box, and an expr's wire to the box it creates. An instance's `varName` is the first name bound to any of its objects, named as a wire label is (a loop's objects share a box, so it takes the first one's name; a call's out-port carries its box's name). The label of an edge is that of its latest use.
- **Producer order.** An edge from a producer to a consumer is drawn only when the producing event's `i` is lower than the consumer event's `i`. A use that ran before the token's producer is treated as having no producer for that use: a source node for a scalar, the (lazy) instance for an object. This is a general guard against a late-recorded producer being wired to earlier uses.
- A loop's source tokens (a new token each iteration, no producer) share one source node per consumer node and param; `SourceNode.token` is the latest.
- `steps` = every execution `i` of drawn nodes plus every instance version `i`, sorted and unique. Dropped expr events and events outside scope 0 are not steps.
- Truncation keeps the first `MAX_NODES` nodes by `order` (sources sort just before their first consumer); a kept node whose parent was cut gets `parent: null`.
- A merged node takes its name, module and `student` flag from its own first non-interrupted event.
- Self-edges occur: `x = g(x)` in a loop gives an edge from a box's out-port to its own in-port (uses per iteration).
- Ids of lazy instances (no producing event) and of instances for outputs after the first use object numbers (`!v12`, `#k`), so they are less stable across edits than other ids.

`timeline.ts`: `stateAt(model: GraphModel, log: EventLog, step: number): StepState`.

```ts
interface StepState {
  current: number | null; // event i at this step (steps[step-1]); null at step 0
  visibleNodes: Set<string>; // node with any execution i <= current (instances: createdAt <= current); a method box of an instance is visible from the instance's createdAt, even before its first execution
  uncalled: Set<string>; // visible call nodes with no execution yet (method slots not called so far); they have no activeExecution
  activeEdges: Set<string>; // visible edges used by the consumer's active execution (a shared method box switches wires per execution); edges into instances: active when visible
  visibleEdges: Set<string>; // edge with a use whose consumer has started (use.i <= current) and whose producer has returned (producer ret <= current)
  activeExecution: Map<string, Execution>; // per node: latest execution with i <= current
  activeToken: Map<string, Token>; // per edge
  activeVersion: Map<string, Token>; // per visible instance node: its latest version token with version.i <= current (draw attrs from log.values[token].attrs; a data box's rows come from the same summary: shape, dtype or columns)
  objectBadge: Map<string, { k: number; n: number }>; // boxes holding more than one object (versions of kind `new`, n > 1): k = 1-based position of the active object, n = total; drawn as "2 of 3 objects" while stepping, "×3 objects" at the end (svl-tcy)
  aliases: Map<string, string[]>; // svl-35d: per visible instance that has any: the alias names active at this step: `from <= current < until` and `object` is the object of the box's active version (a loop's box holds one object per pass, so a name bound to another pass's object is not shown; at the end of the timeline: the last object and the names still bound to it). The renderer writes the title `df (also df2, prev): DF` (at most three names, then `…`) and the aria label `, also named …` from the same names, so they never differ; layout reserves the width of the longest title over the run, so a step never moves the box
  currentNode: string | null; // node of the current event: the call/expr/store box that executed, or the instance created or mutated by it; null at step 0
  attrsBefore?: Record<string, Token>;
  attrsAfter?: Record<string, Token>; // when current is a method on an instance
  output: OutputEntry[]; // entries with i <= current
  badge: Map<string, { k: number; n: number }>; // merged boxes only (n > 1): k = count of the active execution, n = count of the last one
}
function stepOfEvent(model: GraphModel, i: number): number | null; // execution i -> step index for stateAt (click a box); null if i is not a step
function attrsAround(
  model: GraphModel,
  log: EventLog,
  executionI: number,
): { before?: Record<string, Token>; after?: Record<string, Token> } | null; // owner attrs around a chosen method execution on an object (inspect panel; data objects have no attrs); null if not one
function eventLabel(log: EventLog, i: number): string; // "line 10: train_test_split(X, y, test_size=0.2)" for the event list
function describeStep(model: GraphModel, log: EventLog, step: number, opts?: { short?: boolean }): SummaryPart[]; // svl-dnj, describe.ts
type SummaryPart = { kind: 'text'; text: string } | { kind: 'code'; text: string }; // names and source are `code`
function summaryText(parts: readonly SummaryPart[]): string;
```

Step summary (`describeStep`, svl-dnj): a plain-English sentence or three for one step, from templates (no model, no network), pure and deterministic. It lives in `@machines/log` beside `stateAt` because it reads `StepState`, the graph and the log, and the web app and a later Jupyter frontend both need it. Step 0 is "Before the program runs."; an empty run or an out-of-range step gives `[]`. `short` drops the leading "Called ..." sentence when more follow (event-list rows already show the code). The same rule as no false wires: a name is given only when a scope-0, non-volatile binding of that very object was made right after the event returned (`at` in `[i, ret]`); "created a new" only when no earlier event touched the object and no name was bound to it before; changed attributes come from `attrRows` in `attrs.ts` (shared with the inspect panel: the same `sameValue` and truncated-repr rule) and are left out for errors and for a new object's first version; a method's owner is named only when the callee text is a plain dotted name (`model.fit`). A loop box adds "(pass k of n)" (or "call k of n" when the box merges different sites). `fixtures/summaries/<name>.txt` holds every step of every golden log (a snapshot test).

Step `steps.length` (the end) shows everything, including wires ready after the last drawn step. `step` 0 shows nothing (unless no step is drawn, when step 0 is also the end and shows everything) except `output` entries with `i = -1`. Out-of-range steps are clamped; NaN is step 0. An out-wire of a merged box lags the box: on iteration 3 of a loop the badge says 3 of n, but a wire to a later consumer keeps carrying iteration 2's token until that consumer's own iteration 3 starts (no false wires). A source node is visible when any of its edges is. `activeToken` is per visible edge: the token of its latest use with `i <= current` and producer `ret <= current`. `activeExecution` has call, expr and store nodes only. `attrsBefore/After` come from the `mutates` entry on the owner (or the owner's own attrs for both when the method does not mutate it). `eventLabel` appends ` (error: T)`, ` (handled T)` or ` (stopped here)` for events with an error or `interrupted`, collapses whitespace and cuts the source text at 80 characters. `stateAt` caches an index per (model, log) object pair, so reuse the same objects while scrubbing.

**Stage and shelf model** (svl-61q.1, `stage.ts`; the two-pane view of epic svl-61q). Pure functions next to `stateAt`; no layout, DOM or animation.

```ts
function stageAt(model: GraphModel, log: EventLog, step: number): StageModel | null; // null at step 0, or when the current event's box is not in the model
function shelfOrder(model: GraphModel): ShelfEntry[];
function shelfAt(model: GraphModel, step: number): ShelfSlot[]; // the entries on the shelf at that step, in shelfOrder order

interface StageModel {
  node: string; // the call/expr/store/import node of the current event (an instance id for an instance-only step)
  kind: GNode['kind'];
  execution: Execution | null; // the current execution of `node`; null only for an instance
  i: number; // event i of the step
  line: number | null; // source line of the event
  error: EventError | null;
  failed: boolean; // error !== null: a `changed` participant of a failed call may have changed only partly; word it "changed before it failed"
  dropped: number; // object participants left out because they have no box or chip (cut by truncation)
  participants: StageParticipant[]; // objects, in order: owner, inputs (port order), outputs and created (out-port order)
  values: StageValue[]; // inline scalars and literals
}
type StageRole = 'owner' | 'input' | 'output' | 'created';
interface StageParticipant {
  kind: 'instance' | 'import' | 'chip'; // instance: a shelf object; import: an import block; chip: a folded temporary, stage-only
  role: StageRole;
  node: string; // instance or import node id; a chip: the id its box would have (`GEdge.chip.node`)
  object: string | null; // `v12`; null for an import
  token: Token | null; // the token that travelled (for a chip: `chip.token`); null for an import
  port: string | null; // the stage node's in-port (input) or out-port (output, created) it binds to; null for owner, imports, and expr/store nodes (no ports)
  param: string | null; // the in-port's param (expr/store: the operand name), or the output index text; null for owner and imports
  edge: string | null; // the GEdge that carries it, so the stage can draw the wire; null for owner and imports
  changed: boolean; // the step changed it in place (a `mutate` or `store` version made by this event)
  after?: Token; // with `changed`: the version this event made
  newBox?: boolean; // role `created` only: true = the box's first object (the box joins the shelf after this step); false = the box exists already (a later loop pass made another object of it; a re-run import block)
  objectOf?: { k: number; n: number }; // a merged loop box holding n > 1 objects: which one this step means
  chip?: { type: string; shape: number[] | null };
}
interface StageValue {
  role: 'input' | 'output';
  port: string;
  param: string;
  token: Token | null; // null for a literal argument
  text: string | null; // the literal text (`0.2`, `"price"`), else the scalar's repr
  type: string | null;
  edge: string | null;
}
interface ShelfSlot extends ShelfEntry {
  filled: number; // objects of the box that exist so far (`new` versions with i < the step's event); at the end all of them; 1 for an import
}
interface ShelfEntry {
  node: string; // instance or import node id
  kind: 'instance' | 'import';
  at: number; // event i at which the entry appears: `createdAt`, or the import's first run
  objects: number; // instances: how many objects the box holds (a merged loop box is ONE entry); 1 for an import
}
```

Rules:

- **Which object.** `token` and `object` come from the execution's own tokens (`owner`, `inputs`, `outputs`), so a merged loop box names the object of this pass exactly; `objectOf` says which of the box's `n`. `stateAt(...).activeVersion` stays the box's attribute source. An instance with no box match is left out: a participant is never guessed (no false wires, no false labels).
- **Roles.** `owner` = the execution's object owner (a method's receiver; it has no port and no edge). `input` = an object on an in-port. `output` = an object on an out-port that already had a box. `created` = an output object whose box has a `new` version at this event (a constructor, `read_csv`, each `train_test_split` result, an expr that yields an object). An import step has one `created` participant of kind `import` per name it binds. An object that is both an owner/input and changed (`fit`) has `changed: true`.
- **Chips** (folded temporaries) are participants of kind `chip`, role `input` or `output`: they have no box, are never on the shelf, and exist on the stage only for the step that produces or consumes them (a chip is produced in one step and consumed in a later one; it is not carried between). `edge` is the chip wire.
- **Scalars and constants are not participants.** They are `values`, drawn inline in the stage: a literal gives `token: null` and its text, a scalar gives its token and repr, scalar outputs (`score`) are `role: 'output'`. They are never shelf objects.
- One participant per object on expr and store nodes. A store's written object is one participant, role `output`, `changed: true`, `token` = the version before the write and `after` = the version after; its `target` and `value[...]` operands and its `out:*` are not repeated. Other operands (the mask in `df.loc[mask, c] = 0`) stay `input` participants when they are different objects. Calls list an object once per port (`df.merge(df)` gives two inputs with different ports and one shared edge). A chip owner is listed once, as the `in:self` input.
- `failed`: a call that raised keeps `changed` (the recorder logged the mutation, which may be partial); the renderer words it as "changed before it failed".
- `created` and `newBox`: `created` always means an object appears now. `newBox` says whether its box is new: false for later passes of a loop box and for an import statement that runs again (its block is already on the shelf).
- `shelfAt(model, step)`: step 0 is empty; at step s the entries with `at` before the step's event, each with `filled`; the end (`steps.length`) shows every entry full. So `filled` counts objects of a merged loop box that exist so far (the one being made by the current step is on the stage, not counted).
- `shelfOrder` is sorted by `at`, then `order`, then id: creation order, with imports as entries at their step. A merged loop box is one entry. A box is on the shelf from the step after its `at` line; while that line is the current step its object is on the stage (so the renderer slides it in afterwards). Chips, scalars and sources are never entries. A truncated model (`tooMany`) lists only the boxes it kept, and `stageAt` returns null for steps whose box was cut; participants that were cut are left out.

**Two-pane renderer** (svl-61q.2, `@machines/render` `twopane.ts`; framework-free, the full-diagram `mount` is unchanged):

```ts
function mountTwoPane(host: HTMLElement, model: GraphModel, log: EventLog, opts?: { onSelectNode?, onOpenDocs?, measure?, elk? }): Promise<TwoPaneController>;
interface TwoPaneController {
  setStep(step: number, opts?: { animate?: boolean }): void; readonly step: number; // default snaps
  cards(): CardInfo[]; card(key: string): HTMLElement | null; // key as below
  readonly plan: StagePlan | null; readonly shelfEl: HTMLElement; readonly stageEl: HTMLElement; destroy(): void;
}
interface CardInfo { key: string; node: string; object: string | null; where: 'shelf' | 'stage' | 'hidden'; shelf: Rect | null; stage: Rect | null } // rects relative to the host
function planStage(stage, size, box, mergedOf, log?): StagePlan; // pure stage layout: items, wires (points), values
```

- One ELK run sizes every box and gives the call box its port positions; the wires of the stage are drawn from `planStage`, not by ELK. Layout is top to bottom: inputs (a row), the call box with the owner to its left and inline values to its right, outputs and created objects (a row). The owner has a dotted line labelled "owner" (no port, no arrow). A step without a call/expr/store box (an import, an instance made by an expression) shows its objects in one row, no wires.
- Cards are stable elements `div.md-card[data-card=key]`, each holding the same SVG box as the full diagram (svl-faf: an instance card is the full diagram's compound box: the instance, its method boxes inside it and the "more methods (N)" button, drawn by the same `buildSvg`/`applyState` from a `layout` run with `compact: true`; the method boxes have no ports and there are no wires on the shelf; a method box shows from the instance's creation, with the "not called yet" cue until its first call, exactly as `stateAt` says for the full view, and is `md-current` while its call is the step; the card's focus target is the instance box, and its method boxes and the button are reached from it with ArrowDown/ArrowUp, Escape returns, I selects the focused box; otherwise it is a `mount` with one node, so docs "?", roving rows and keyboard behave the same). `key` = the node id; one object of a merged loop box on the stage is its own element `node#object` (the shelf keeps the box with its "N objects" caption); a chip is `chip:<edge>`. A single-object card moves from its slot `[data-slot=node]` into `.md-stage-canvas` while it is on the stage, and its slot shows a dashed `.md-slot-ph` reading "<name> on the stage". Slots exist for every entry, `hidden` until `shelfAt` lists it; their order is `shelfOrder`.
- Keyboard: one Tab stop per pane (shelf, stage; roving `tabindex`). Left/Right/Home/End move between cards, Enter dives into a card's attribute rows (needs `onOpenDocs`, as in the full diagram), I selects the card (`onSelectNode`; the card's `aria-keyshortcuts` contains `I`), Escape comes back to the card. Each card's box has a unique name: its title, then its role on the stage (`input to X`, `owner of fit`, `created by read_csv`, `current line`) or `on the shelf, k of n`. The wires svg is `aria-hidden`; those names are its text equivalent. `.md-stage` scrolls horizontally when a line is wider than the pane. `cards()` `where` follows visibility (`hidden` when the element or its slot is `hidden`).
- Animation (svl-61q.3): `setStep(step, { animate: true })` plays a FLIP move of 325ms (`MOVE_MS`), ease-out, `transform` and `opacity` only (plus, for the flight, `position: fixed` and `z-index: FLY_Z` on the moving card, which draws it above the stage, shelf, wires and other cards and keeps the stage's overflow from clipping it; a same-size `.md-fly-ph` keeps its shelf slot; both are undone exactly when the animation finishes or is cancelled): every card that was visible before and after goes from its old position to its new one (shelf slot to stage on a step forward, stage to shelf slot when the line ends, and the reverse when stepping back); a card that was not visible fades in from 8px below; the wires fade in; cards that disappear are not animated. The default (no option, or `animate: false`) snaps, and `prefers-reduced-motion: reduce` always snaps. The caller decides: a single step (arrow keys, buttons) passes `animate: true`; slider drags, jumps, event-list clicks and re-runs do not. Input is never blocked: the DOM already holds the final state, so the next `setStep` cancels any running animation (finishing it instantly) before measuring. A focused card keeps focus after it is re-parented. The pure plan is `planMoves(before, after)` (rects by key, null = not visible) returning `{key, kind: 'move'|'enter', dx, dy}`.
- `mount.setState(state, log, view?)` takes an optional `view` (`owns`, `versionOf`) so a card can show the version that travelled and mark the changed attributes of the stage's owner. `ApplyContext` has the same two optional fields. Without them nothing changes.

**Renderer** (`@machines/render`):

```ts
function layout(
  model: GraphModel,
  opts?: {
    expanded?: Set<string>;
    measure?: (text: string, font: string) => number;
    attrRows?: Record<
      string,
      string[]
    > /* instance id -> attribute row texts to reserve; default one row per ctor param */;
    edgeLabels?: Record<
      string,
      string
    > /* type text to reserve per wire label (edgeLabelsFor(model, log)); default a placeholder */;
    moreMethods?: Record<string, number> /* instance id -> length of its "more methods" list (moreMethodsFor(model, log)); such an instance reserves one control row at the bottom */;
    elk?: ELK; /* createElk({ workerUrl }): elkjs worker build; default: elk.bundled.js, lazily imported, in-thread (Node, tests) */
  },
): Promise<Laid>; // expanded ignored until M4
interface Laid {
  width: number;
  height: number;
  nodes: Record<
    string,
    {
      x: number;
      y: number;
      w: number;
      h: number;
      ports: Record<string, { x: number; y: number; w: number /* label width, centred on x */ }>;
      headerH?: number;
      attrsH?: number; /* instances: name pill and attribute list heights, at the top of the box */
      moreN?: number;
      moreH?: number; /* instances with a "more methods" list: its length, and the height of the control row at the bottom of the box */
    }
  >;
  edges: Record<string, { points: [number, number][] }>;
  labels: Record<
    string,
    { x: number; y: number; w: number; h: number }
  >; /* wire label rectangle per edge id, placed clear of boxes, instance header/attribute rows, wires and other labels */
  dropped: number; /* edges left out for naming a missing node or port */
} // all coordinates absolute (root origin)
function mount(
  el: HTMLElement,
  opts: {
    onSelectNode(id: string): void;
    onHoverEdge(id: string | null, at: DOMPoint /* viewport coords */): void;
    onClickEdge(id: string): void;
    onOpenDocs?(target: { module: string | null; name: string }, nodeId: string): void; // an entry of a "more methods" list was chosen (svl-3ms opens the docs panel from it: `target` is a `DocTarget`, `name` = `Class.method`). When absent the list is plain text
  },
): DiagramController;
interface DiagramController {
  setGraph(model: GraphModel, laid: Laid): void; // builds the SVG once. Re-applies the last state only if every node/edge id in it exists in the new model (a streamed re-layout of the same run keeps its step); otherwise the state is dropped. Callers should call setState right after setGraph. Calls onHoverEdge(null) if a hover was active. After destroy() it is a no-op
  setState(state: StepState, log?: EventLog): void; // reveal, highlight current, badges, active tokens; no re-layout. `log` supplies value types (wire labels) and attributes
  focusNode(id: string): void; // scroll into view (keyboard focus is not moved)
  toggleMethods(id: string, open?: boolean): void; // open/close the "more methods" list of an instance (the user does it by click, Enter or Space on its control; Escape inside the list closes it and refocuses the control). Open lists survive a re-layout
  hoverNode(id: string | null): void; // hover style (editor cursor sync)
  setSelectedNode(id: string | null): void; // selected style
  nodeBounds(id: string): { x: number; y: number; w: number; h: number } | null; // diagram coordinates
  readonly svg: SVGSVGElement | null; // width/height = layout size in px; the caller pans and zooms it
  destroy(): void;
}
function edgeLabelsFor(model: GraphModel, log: EventLog): Record<string, string>; // pass as layout's edgeLabels: longest type text per wire over the run
function createLegend(doc?: Document, open?: boolean): HTMLElement; // collapsible legend, needs theme.css (svl-1x4: `createLegendList` builds a list of the two `basic` entries, class instance and function or method call, and a `details.md-legend-more` "More" expander with the rest, which lists the import block (svl-i6s); `LegendItem.level` is `'basic' | 'more'`)
function attrRowsFor(model: GraphModel, log: EventLog): Record<string, string[]>; // pass as layout's attrRows so instance boxes never resize. Machines: params plus attributes; data boxes (svl-skw): `shape (r, c)` and `dtype x` or `columns a, b, c, …` (first columns up to 26 chars), the longest text over the versions
function dataRowModels(s: ValueSummary | undefined): AttrRow[]; // rows of a data box, from the summary only; they carry `data: true` (value in normal text, label muted)
function moreMethodsFor(model: GraphModel, log: EventLog): Record<string, number>; // pass as layout's moreMethods and re-layout when it changes (the web app includes it in `layoutSignature`)
function hiddenMethods(model: GraphModel, log: EventLog, inst: InstanceNode): { name: string; doc: string }[]; // the class's `values.methods` (found via any value of the same type) minus the method boxes the instance has; [] unless the instance is a machine (`machine: true`): a data class's list is a capped alphabetical slice, not "other methods"
function methodDocTarget(model: GraphModel, inst: InstanceNode, method: string): { module: string | null; name: string }; // module of the constructor box (else of a method box), name `Class.method`
function nodeDocTarget(model: GraphModel, node: GNode): { module: string | null; name: string } | null; // call box: module and name as logged; instance box: its class (module of its constructor box); an expr box `name.attr` of an instance: its attribute (`attr: true`, svl-3du); null for other expr, store and source boxes. With onOpenDocs set, each such box gets a `?` button (`g.md-docs-btn`, `data-docs-btn=<node id>`, mouse only, aria-hidden) and `aria-keyshortcuts="?"`; `?` on the focused box opens its docs (svl-3ms)
function portViews(model, node: CallNode, exec: Execution | undefined, log): { in: Record<string, PortView>; out: Record<string, PortView> }; // what a call box's ports show for one execution
function wireTypeLabel(token: Token, values): string; // wire type text: scalars only ('' for an object token)
```

**Slots, constructor and shared boxes (svl-0qe, changed by svl-1x4).** A call box in `StepState.uncalled` has class `md-uncalled` and `, not called yet` in its aria-label. It is drawn solid, like a called box (no dashed outline, no different fill); its ports are hidden and a small text `not called yet` (`.md-uncalled-cue`, in every call box, shown only under `.md-uncalled`) sits under its name. A constructor box (a call node that creates an instance of the class of its own name) is an ordinary function box: no `md-ctor` class, aria-label `function <Name>`; the wire from its out-port to the instance stays. **Imports** (svl-i6s): an import node is drawn as a small box in the call box's style (class `md-import`, `data-kind=import`, no ports, one name line `name (module)` with the same lighter `.md-module` tspan; aria-label `import <name> from <module>`, or `import <name>` when the source is null), hidden until its import step. It has no wires. `callModules(model)` (layout.ts) maps each call box to `CallNode.importedFrom`. Such a box writes `name (module)` on its name line (`.md-name` with a lighter `.md-module` tspan; aria-label `function <name> from <module>`), and the layout measures the full text. An instance of a class with hidden methods shows a control `▸ more methods (N)` in its last row (a `role=button` group, `tabindex=0`, `aria-expanded`, `data-more=<instance id>`, in a layer above the diagram); opening it draws a list under the box, one entry per method with the one-line doc. Each entry has `data-doc-module`, `data-doc-name`, `data-doc-method` and `data-doc-node`, and is a button (`tabindex=0`) only when `onOpenDocs` is given. The list overlays what is below it and does not change the layout. Data boxes (DataFrame, Series, arrays) get no list (decided): their `methods` are the first 40 alphabetically, not a useful set of other methods; their docs open from the method boxes.

A shared method box draws the running execution only (decided): edges not in `StepState.activeEdges` get class `md-inactive` (faint, label hidden) instead of disappearing, so earlier wires stay as history. The ports of a call box come from `activeExecution`, not the node's latest: a const port shows the `param = text` of that execution's event, a scalar port its value type, an out-port the name bound to the token that execution produced (an object's out-port the name of its box, a scalar's the name label of its out-edge for that token), and a port the execution did not use (no input or output for it) is dimmed (`md-port-unused`). With no execution (an uncalled box) or no log the ports show the graph's own text. A box at the step of its constructor shows the attributes of the object that constructor returned (a constructor in a loop gives one box for all passes), and only a method of an instance marks that instance's attributes as changed. The layout reserves port label widths from the node's latest text, so a wider const text from another execution may be clipped.

An ELK quirk worth knowing: a compound node's `elk.nodeSize.minimum` is read as (height, width) under direction DOWN, so `buildElk` passes `(h,w)`. The other order reserves `w` px of height, which left an empty band under a lone method box in a data box.

ELK options exactly as in SPEC "Layout": `elk.algorithm: layered`, `elk.direction: DOWN`, `elk.portConstraints: FIXED_ORDER` with inputs `NORTH`, outputs `SOUTH` and `elk.port.index` set, `elk.layered.considerModelOrder.strategy: NODES_AND_EDGES` with children sorted by `order`, `elk.hierarchyHandling: INCLUDE_CHILDREN` on the root. Wires entering a method box from outside go through a hierarchical port on the instance's west border below the attribute rows (spaced `laneGap`), so they never cross the header or rows. Wire labels are placed after ELK by `placeLabels` (greedy, deterministic). Node sizes come from measured label text (canvas `measureText` with the theme font) so ELK and SVG agree.

**Size-based degradation.** ELK's cost is dominated by the dummy nodes it inserts for edges spanning several layers (a 300-node chain with fan-in from 7 hubs has ~44k, about 30 s at full quality). `buildElk` estimates that count with `longEdgeLoad` (longest-path layering of the model, summing `span - 1` over forward edges) and merges a tier's options over the root options: tier 0 (load <= 4000, `TIER1_LOAD`): full quality, as above; tier 1 (<= 15000, `TIER2_LOAD`): `considerModelOrder.strategy: NONE` (the model-order sort is superlinear) and `thoroughness: 1`; tier 2 (above): also `crossingMinimization.strategy: NONE` and `hierarchyHandling: SEPARATE_CHILDREN` (NONE is only allowed without INCLUDE_CHILDREN). Tier 2 is used only when the model has no instance with children: under SEPARATE_CHILDREN ELK returns no sections for wires that cross a compound border, so with compounds the tier is capped at 1. Lower tiers order nodes within a layer less well (more crossings, source order only through the layering). Wire labels use a grid index, so `placeLabels` stays near-linear. Dense 300-node / ~590-edge graphs, with and without 10 instances, lay out in about 1-2 s warm; `layout.test.ts` runs them in `pnpm test`.

`longEdgeLoad` is an estimate: an order-based longest path over the model's nodes, not ELK's own layering. `tierFor(load)` is exported, and `LayoutOptions.minTier` (0|1|2) sets the lowest tier to use. A streaming caller (svl-bwv.4) should keep the tier sticky per run: track the highest tier seen so far (`tierFor(longEdgeLoad(nodes, edges))` per update), pass it as `minTier`, and reset it on a new run, so the layout style does not flip back and forth as the graph grows.

**Type signifier (svl-465).** Type text is drawn as a Python annotation, `: Type`, in `--md-type-text` (light and dark values; `--md-type-fill` backs the HTML pill). The `: ` prefix is the cue that does not rely on colour. `typeText(t)` (layout.ts, exported) adds it; `callPortWidths`, `edgeLabelsFor` and the attribute rows (`AttrRow.detail` with `typed: true`) all carry the prefix, so layout measures what is drawn. Classes: `.md-ptype` (port type), `.md-wtype` (wire label type), `.md-atype` (attribute type); `.md-pconst` (const arg) and `.md-aval` (attribute value) stay plain; names stay `.md-pname`/`.md-aname`. A chip keeps its `+ <type> (<shape>)` text (the dashed pill is its cue). HTML panels use `<span class="md-type-tag">Type</span>` (pill with a `: ` prefix, from theme.css). Legend entry `type` (level `more`).

`theme.css` variables: `--md-fn-fill`, `--md-fn-stroke`, `--md-inst-fill`, `--md-inst-pill`, `--md-inst-pill-text`, `--md-wire`, `--md-text`, `--md-text-muted`, `--md-error`, `--md-current-stroke-width`, `--md-font-mono`, `--md-bg`, plus `--md-focus`, `--md-changed-flash`, `--md-badge-fill`, `--md-badge-text`. The file is `packages/render/theme.css`; apps import `@machines/render/theme.css` once. State classes on the SVG: `md-hidden`, `md-current`, `md-error`, `md-handled`, `md-stopped`, `md-hover`, `md-selected`, `md-uncalled`, `md-inactive`, `md-port-unused`. Light and dark values are set under `prefers-color-scheme` and `[data-theme]`, as SPEC "Visual style" describes. Error boxes carry ⚠ and text (a handled error uses the same outline, `md-handled`, and its message says so; a store box uses the call box's style; a dashed wire differs from a solid one by its dashes only); changed attributes carry ●. Nothing is conveyed by colour alone. Animations are off under `prefers-reduced-motion`.

## 9. Fixtures, commands and scripts

Fixture programs (`fixtures/programs/`). Each one is a short runnable script, using `fixtures/data/listings.csv` (synthetic: 500 rows; columns `beds, baths, sqft, neighbourhood, room_type, year_built, price`, a few NaNs) or an inline DataFrame, with `random_state` fixed:

| File                  | Exercises                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `golden_split.py`     | `read_csv` → `X`, `y` → `train_test_split(X, y, test_size=0.2)`                                |
| `golden_onehot.py`    | `OneHotEncoder` construct, `fit`, `transform` on train and test (sparse output)                |
| `golden_linreg.py`    | `LinearRegression` construct, `fit`, `predict`, `score`                                        |
| `edge_fit_chain.py`   | `model.fit(X, y).predict(Z)`                                                                   |
| `edge_df_chain.py`    | `df.dropna().reset_index()`                                                                    |
| `edge_nested.py`      | `f(g(x))` with library calls                                                                   |
| `edge_expr.py`        | `df["price"]`, `X_train - mean`, `model.coef_`                                                 |
| `edge_store.py`       | `df["c"] = v`, `df.loc[m, "c"] = 0`                                                            |
| `edge_loop.py`        | a 30-iteration loop calling `fit` and `score` (per-site cap and slot)                          |
| `edge_literals.py`    | equal literals, small ints, numpy bool results, constant tuples: never wired to each other     |
| `edge_dict_models.py` | `models["rf"].fit(X, y)`                                                                       |
| `edge_gridsearch.py`  | `GridSearchCV` (original stays unfitted), `n_jobs=2`                                           |
| `edge_reserved.py`    | keyword args named `site` and `fn`; `locals()`; `super()` in a class; shadowed `print`         |
| `edge_repr.py`        | a student class with a `__repr__` and a property that call pandas                              |
| `edge_generator.py`   | a generator function and an `async def`                                                        |
| `edge_nosig.py`       | callables whose signature can't be read (numpy ufuncs)                                         |
| `edge_inplace.py`     | `df.dropna(inplace=True)`, `df.sort_values(..., inplace=True)`                                 |
| `edge_student_fn.py`  | a student function and a student class used as opaque boxes; `if __name__ == "__main__":`      |
| `edge_input.py`       | `input()`                                                                                      |
| `edge_error.py`       | an unhandled `ValueError` from sklearn                                                         |
| `edge_handled.py`     | a caught exception, then the run continues                                                     |
| `edge_warning.py`     | a pandas `FutureWarning`/sklearn `ConvergenceWarning`                                          |
| `edge_syntax.py`      | a syntax error                                                                                 |
| `edge_mpl.py`         | `plt.plot`, `plt.show()`                                                                       |
| `notebook.py`         | a 20-line notebook-style script: load, clean, encode, split, fit, evaluate, print              |
| `heavy.py`            | the heaviest plausible course example: `RandomForestRegressor` + `GridSearchCV` on 10,000 rows |

Root commands (exist once the scaffold bead closes):

```bash
pnpm install && uv sync
pnpm test           # vitest in all packages + uv run pytest
pnpm test:py        # uv run pytest
pnpm test:pyodide   # python/tests run inside Pyodide on Node (packages/web/scripts/pyodide-pytest.ts)
pnpm typecheck
pnpm lint           # eslint + prettier --check + ruff check + ruff format --check
pnpm build          # web build (includes Pyodide copy to dist/pyodide)
pnpm dev            # Vite on :5173
pnpm fixtures       # uv run python -m machines.tools.gen_fixtures: regenerate fixtures/logs, streams, graphs
pnpm e2e            # Playwright (playwright-core + system Chrome) against `pnpm preview`
pnpm measure        # scripts/measure.ts, section SPEC "Performance"
```

`pnpm fixtures` runs the Python generator, then `pnpm --filter @machines/log gen:graphs`, which runs `packages/log/src/golden.test.ts` with `UPDATE_GRAPHS=1` to write `fixtures/graphs/<name>.json` = `buildGraph(fixtures/logs/<name>.json)`. The same test file checks that assembling each stream gives its log, that each graph equals the checked-in one, that no wire is unbacked by the log (consumer took the token, producer had returned), and the slide structure of the three golden programs.

Generated fixtures are reviewed like code. A PR that changes them must say why in its body.

## 10. Decisions resolving SPEC gaps

1. **Module-level binds in M2.** SPEC puts `__bind__` in M4, but M2's labels, scalar wiring and expression nodes need it. Module-scope `__bind__` and `__store__` are in M2. Scoped binding, `__scope__` and `__ret__` stay in M4.
2. **Function bodies are uninstrumented in M1–3** (section 3). Otherwise calls inside student functions would draw at module level with no enclosing box.
3. **Per-site cap vs fast path.** SPEC says calls past the cap take the fast path, but it also wants the latest execution recorded. Past the cap, executions are recorded in full into a replaceable slot. Only hidden calls take the fast path. `pnpm measure` checks the overhead.
4. **Scalar set widened** to numpy and pandas scalars and all-scalar tuples (`np.True_` is a singleton, and constant tuples are shared within a code object). Callables, classes and modules are port labels, never wires (section 5).
5. **Identity guard** on scalar name resolution (section 5).
6. **Stores always bump** the root's version.
7. **Runtime origin fallback**: a `call` origin whose inner call wasn't recorded becomes an `expr` event.
8. **Two-phase streaming**: finished events plus an `open` stack. When isolated, a SharedArrayBuffer `currentCall` lets the main thread name the running call after `terminate()` (SPEC: "nothing may depend on a final log").
9. **`i` is monotonic but not contiguous** because of slot replacement, and bindings are capped per site like events.
10. **Warnings** go to the output pane, attributed to the student line of the running call, because the hook frame would otherwise be blamed.
11. **Recorder degrade**: internal errors become `diagnostics` and pass-through, never student-visible.
12. **`__name__ == "__main__"`** in the student namespace.
13. **Recursion limit** doubled during runs to absorb the hook frame.
14. **Share links never overwrite autosave**: code from a link is held separately until the reader edits or runs it.
    - **Format** (`packages/web/src/share/link.ts`). Fragment `#c=<payload>`. The payload text is base64url (no padding) of raw deflate (`CompressionStream('deflate-raw')`) of UTF-8 JSON `{ v: 1, code: string, files?: Record<string, string> }`. `v` is the version; a decoder refuses other versions. `files` maps a plain basename (no `/`, `\`, `..` or control characters, at most 128 chars) to CSV text; at most 8 files and 256 K characters in total.
    - **Limits.** The payload text (after `c=`) may be at most 8 KB (8192 characters); longer is refused on encode and decode. Inflated output is capped at 1 MB. Encode and decode return `{ok:false, error}` and never throw.
    - **Loading.** The page reads `#c=` at start and on `hashchange`, then clears the hash with `history.replaceState`. Other hashes are ignored. A new link replaces unsaved work or a run in progress only after the reader confirms. The last hash wins.
    - **`origin`** is one of `starter` (built-in example), `autosave` (restored from storage), `link` (code from a link, untouched and not run) and `edited` (link code the reader has since changed or run). `link` becomes `edited` on the first change to the source or the first Run; `link` and `edited` never go back to `link` except by loading another link. Autosave of the reader's own code (`machines.source.v1`) writes only for origins `starter` and `autosave`. Link code that is still `link` is never saved. Once `edited` it goes to a separate recovery slot (`machines.linkwork.v1`), never restored automatically, so a link cannot overwrite the reader's earlier autosave (`autosaveAction` in `storage/autosave.ts`). An emptied editor is a real save. Files that come with a link never replace a student's upload or a course dataset: a clash is renamed `name (link).csv` with a notice. "Back to my code" restores the autosave (starter if none) with origin `autosave` or `starter`.
15. **Classmethods** (`__self__` is a class) are functions, not methods.
16. **No hard-coded SVG spike.** M1's exit (the slide example renders from real code) is met by the real recorder → graph → renderer path. Measurements are their own bead.
17. **Hosting** is Cloudflare Pages on a dedicated subdomain, with COOP/COEP and the CSP in `_headers` (section 11).
18. **Binding slots**: the batch `bindings` tuple has an optional fifth element `slot_key` (`b<site>.<name>`) for bindings past the per-site cap. The assembler keeps only the newest per key in each scope, and the log's `Scope.bindings` stay 3-tuples (section 7).
19. **Method event names** are `<owner class>.<method>`, so the box says `LinearRegression.predict` even though the method is defined on `LinearModel`.
20. **Calls are made from a `<student>` eval frame** that shares the caller's globals and locals and is positioned at the line CPython reports for the call (`func_line` when it differs from `line`). Warnings raised at the call's own level blame the student's line, the warning registry is the student's, and `df.query("@x")`, `sys._getframe(1)` and `locals()` aliases behave as in plain Python. Warnings raised deeper in a library keep the library's location: the runtime attributes them with `Recorder.current_line()`. Tracebacks contain that eval frame (named like the caller's frame, same line) after each hook frame; `student_traceback` should merge it with the frame above. Student-printed stack listings show recorder frames (section 3).
21. **Expression events from arguments, owners and hidden calls** carry synthetic merge keys (section 4), and a store's expression RHS is wired through the names it reads (the hook does not receive the RHS object).
22. **Binding rows are capped** at `4 * max_events` (section 4).
23. **Unweakrefable containers are kept in a bounded LRU** (section 5), not until the end of the run.
24. **Timeline rail** (svl-58j). `timeline/rail.ts` maps lines to steps (`stepsByLine`, by the call site's start line), decides dots or chip (`railCell`, `MAX_RAIL_DOTS` = 8) and the chip's click target. `EditorController.setRail` feeds the CodeMirror gutter and is ignored once the document differs from `runSource`. `stepForKey` takes `{ rail: true }` (Down/Up are later/earlier, opposite of the slider's `vertical`) and accepts `j`/`k` as next/previous everywhere. The diagram keeps ArrowUp/Down for panning, so it steps with Left/Right and j/k.

## 11. Hosting and security headers

`packages/web/public/_headers`:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

Everything, Pyodide and its wheels included, is served from the page's own origin (`/pyodide/`). There is no CDN at runtime. **Verified (svl-bwv.2, Chrome, built site with this exact CSP injected on every response):** `'wasm-unsafe-eval'` is enough. Pyodide 314.0.8 loads in the module worker, runs numpy/pandas/scikit-learn and the recorder with no CSP violations and no `'unsafe-eval'`. `worker-src 'self'` covers the bundled worker, and `connect-src 'self'` covers `/pyodide/` and `/datasets/`. `vite dev` is not CSP-compatible (inline HMR preamble, websocket), so check CSP against `vite build` + `vite preview`.

**Service worker (svl-bwv.10).** `dist/sw.js` is hand-written (`src/sw.ts`, logic in `src/offline/core.ts`) and built after the Pyodide copy by `scripts/build-sw.ts`, which injects the precache manifest. Two caches: `machines-shell-<hash>` (app shell, assets, datasets; changes every build) and `machines-pyodide-<version>-<hash>` (everything under `/pyodide/`; unchanged builds reuse it, so an upgrade downloads only the shell). Same-origin GETs are served cache-first and the stored responses keep the host's COOP/COEP headers. A new build installs in the background and waits; the page shows "A new version is available" and activates it only on the user's click. No `_headers` change is needed: the SW script is same-origin (`worker-src 'self'`) and its fetches fall under `connect-src 'self'`. Production builds only: dev does not register it.

## 12. Documentation source (svl-095)

`python/machines/docs.py`, types in `packages/log/src/messages.ts`. Official documentation for any function, class or method, built from the docstrings installed in the interpreter (offline, exact to the running versions) plus a versioned link. Nothing is fetched.

**Request.** `RuntimeClient.docs(target: DocTarget): Promise<Doc>`; worker messages `ToWorker {type:'docs', reqId, target}` and `FromWorker {type:'docs', reqId, doc}`. The worker handles it in its message chain: between runs and while idle, never during a run (a request made during a run waits for `done`). The client caches the `Doc` per target and shares in-flight requests; a restart rejects pending requests and failures are not cached. The worker always answers (an unresolvable target gives a `source: 'none'` doc).

`DocTarget = { module: string | null; name: string; source?: string; attr?: boolean }`. Use an event's `module` and `name` as logged (`name` of a method event is `Owner.method`; a constructor event gives the class). `module: null` takes a full dotted name (`sklearn.linear_model.LinearRegression.fit`). Student definitions (module `__main__`) are read with `ast` from `source`, the program text of the run; student code is never executed. The cache key includes `source` only for student targets, and `attr`.

**Attributes** (svl-3du). `attr: true` says the last part of `name` is an attribute of the class before it (`Ridge.alpha`, `LinearRegression.coef_`, `DataFrame.shape`), not a method; `docs(module, name, source, attr)` in Python. Resolution never runs student code, a property or `__getattr__` (classes are walked with `inspect.getattr_static`): (1) the owner class's numpydoc Parameters entry, or for a trailing-underscore name its Attributes entry (Attributes first, then Parameters), searched along the MRO's class docstrings; (2) else a property's or descriptor's own docstring from the class `__dict__`, never invoked; (3) else `source: 'none'` (and `url: null`). The `Doc` has `kind: 'attribute'`, `signature: null`, summary and description from the entry's desc, and, when the entry has a type, one section `{title:'Type', kind:'text', text}`; a property's docstring is parsed as any other. `qualname` is `<public class>.<attr>`. URL (`doc_url(qualname, 'attribute', versions)`): sklearn, scipy, matplotlib and builtins use the class page (no anchor: the attribute tables have none); pandas and numpy use the attribute's own page (`.../pandas.DataFrame.shape.html`, `numpy.ndarray.shape.html`); private names and unknown libraries null. Student classes: the class docstring's Attributes (or Parameters) entry, else `none`; url null. The UI: `nodeDocTarget` returns `{module, name: 'Class.attr', attr: true}` for an expr box whose text is `name.attr` and whose `name` input is an instance's object (`model.coef_`); `attrDocTarget(model, inst, attr)` gives the same for an instance row. In the SVG every visible instance row (not the "… N more" row) carries `data-doc-name/-module/-node`, `data-doc-attr`, `tabindex=-1`, `role=button`, `aria-keyshortcuts="?"`, and a `g.md-docs-btn[data-docs-row-btn]`; a click on the `?` button, Enter, or `?` on the focused row calls `onOpenDocs` (a click elsewhere on the row only selects the box). **Keyboard (svl-62w, roving focus):** the box is the one tab stop; rows are `tabindex=-1` and reached with arrows. On a focused box ArrowDown focuses its remembered row (else the first visible one); ArrowDown/ArrowUp move between visible rows (hidden rows are skipped; ArrowDown stops at the last row); ArrowUp on the first row and Escape on any row return to the box. The last-focused row is remembered per box. Handled arrows call `preventDefault` and `stopPropagation`, so the pane's pan keys do not fire; ←/→ and other step keys are not consumed. Enter on the box still selects it. A box with visible rows has `aria-keyshortcuts="ArrowDown ?"`. The "… N more" row and hidden rows carry no `data-doc-*`, `role` or `tabindex`; if the focused row hides or becomes the more row, focus moves to its box. The instance attributes panel (web) has a `?` button per row and `?` on a focused row, through `DocsOpenerContext`. `MethodDocTarget` gains `attr?: boolean`. The panel shows "Value at this step" (`attributeValue`: a parameter's text, a fitted attribute's type and shape, or what the read box produced).

**Resolution.** Import the event's module (or an ancestor of it), take the first part of `name` and walk the rest with `getattr` (so a method resolves through the owner's MRO, and a docstring defined on a base class is inherited via `inspect.getdoc`). A class with no docstring of its own uses its `__init__` docstring. The public qualname is the shortest ancestor of the defining module that re-exports the same object: `sklearn.linear_model._ridge.Ridge` becomes `sklearn.linear_model.Ridge`, `pandas.io.parsers.readers.read_csv` becomes `pandas.read_csv`, `matplotlib.axes._axes.Axes` becomes `matplotlib.axes.Axes`. Builtins are `builtins.<name>`.

**`Doc`** (one JSON object): `qualname` (public), `kind` (`function`|`class`|`method`), `signature` (`name(args)` without `self`, or null), `summary` (first paragraph, one line), `description` (the rest before the first section, paragraphs separated by a blank line), `sections` (ordered list), `url` (string or null), `source` (`numpydoc` when a recognised section was found, `plain` for a docstring without sections, `none` for no docstring or an unresolvable target). Sections: `{title, kind:'entries', entries:[{name, type, desc}]}` for Parameters, Other Parameters, Attributes, Returns, Yields, Receives, Raises, Warns, Methods (a Returns/Raises entry that is only a type has `name: ''`); `{title:'See Also', kind:'seealso', items:[{name, desc}]}`; `{title:'Examples', kind:'examples', blocks:[{kind:'code'|'text', text}]}` (a code block is a doctest paragraph with its output lines); `{title, kind:'text', text}` for Notes, References, Warnings and unknown headings. Text is plain: reST roles are reduced to their text, double backticks become single, `versionadded`/`versionchanged` become a sentence, hard-wrapped paragraphs are joined, lists and indented blocks keep their lines.

**URLs** (`doc_url(qualname, kind, versions)`, pure; `versions` come from the loaded packages, `None` for a dev/local version, a private path component or an unknown library):

| Library | Pattern |
| --- | --- |
| scikit-learn | `https://scikit-learn.org/<major.minor>/modules/generated/<qualname>.html`; a method uses its class page and the anchor `#<qualname>` |
| pandas | `https://pandas.pydata.org/pandas-docs/version/<x.y.z>/reference/api/<qualname>.html` (methods have their own page) |
| numpy | `https://numpy.org/doc/<major.minor>/reference/generated/<qualname>.html` |
| scipy | `https://docs.scipy.org/doc/scipy-<x.y.z>/reference/generated/<qualname>.html` |
| matplotlib | `https://matplotlib.org/<x.y.z>/api/_as_gen/<qualname>.html` |
| builtins | `https://docs.python.org/<major.minor>/library/functions.html#<name>` (`func-<name>` for list, dict, set, tuple, range, frozenset, memoryview), methods `library/stdtypes.html#<type>.<method>`, exceptions `library/exceptions.html#<name>` |
| student code | null |

The UI shows `url` only as a plain `<a target="_blank" rel="noopener noreferrer">` the student clicks; the page itself makes no request to those sites and CSP `connect-src` stays `'self'`.
