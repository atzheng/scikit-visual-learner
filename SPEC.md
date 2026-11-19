# Code Diagrams: Client-Side Execution Visualizer for Python + scikit-learn — Spec

Nov 18, 2026 · @Andy · revision 2

## Overview

Code Diagrams runs a student's real Python + scikit-learn code entirely in the browser and draws each call as a box with typed inputs and outputs, wired to the calls that produced and consume its values. It turns the course's slide metaphor (a function takes inputs and gives outputs; an object of a class also has memory) into a live picture of the student's own program. User-facing text uses the standard words "class", "instance", "object" and "function", never "machine" (owner decision, 2026-11-19).

Existing tools cover the neighbours but not this view. Python Tutor and Thonny show memory state line by line; Pandas Tutor shows table transformations; scikit-learn's HTML repr shows an estimator's structure and parameters. None that we know of draws the dataflow between library calls with types, shapes and fitted state.

**Goals**

- Run unmodified student code (base Python, pandas, scikit-learn) with no server, and with the same behaviour and output as uninstrumented Python.
- Draw every library call the student wrote as one box, with input and output ports labelled by parameter name, type and shape.
- Draw estimators and student class instances as boxes with memory: methods inside, attributes that change when `fit` runs.
- Draw student-defined functions as boxes that look like library ones from outside and expand to show their wiring.
- Never draw a wire that isn't real dataflow. A missing wire is acceptable; a false one is not.
- Let students step through execution in order, synced with the source.

**Non-goals (v1)**

- A general-purpose debugger: no breakpoints, no editing values mid-run.
- Visualizing library internals: calls inside pandas or sklearn are never drawn.
- Large data: the target is teaching-sized tables, up to about 10,000 rows.
- Async code and threads. Generator and async functions run correctly but are drawn as opaque boxes.
- `input()`, network access from student code, and multi-file projects.

## User experience

The left column has the timeline (the slider, step buttons, step count, line caption and event list) at the top, then the code editor (CodeMirror 6), then the output pane. The diagram fills the right column. In the two-pane view the stage and the shelf sit side by side (stage left, shelf right) when the pane is wide (800 px or more), and stack below that.

1. **Load.** Pyodide and the packages start downloading as soon as the page opens. A status line shows progress. The Run button becomes active when the runtime is ready. The editor opens with the course's starter example, or with the student's last code (autosaved to `localStorage`), so the page is never blank.
2. **Write and run.** The student writes or pastes code and presses Run (or Ctrl/Cmd+Enter). While code runs, Run becomes Stop and an elapsed-time counter appears after 2 seconds. Course datasets are preloaded; an upload button adds the student's own CSVs, which never leave the browser.
3. **See the diagram.** The graph of the run appears, with the slider at the first step (the first line), so the student steps through the program line by line from the top. Step 0, "Before the program runs", is one Back away. The slider does not follow the run while it streams. Function calls are orange boxes, estimators and student class instances are blue boxes containing their method calls, and wires carry type and shape labels with the variable name as a gray subscript. A constructor (`LinearRegression()`) is an ordinary function box, with a wire to the instance it creates. A method the program has not called yet looks like a called one and carries the small text "not called yet". Literal arguments (`test_size=0.2`) are written on the port itself rather than drawn as a separate node. An imported name shows its module in parentheses in the box that uses it (`read_csv (pandas)`, `LinearRegression (sklearn.linear_model)`); Each import statement is a step of its own: running it places the imported object (module, class or function) on the board as a small box, `LinearRegression (sklearn.linear_model)` or `pd (pandas)`, with no wires. Unused imports are shown too. Only imports that run at module level, including under `if`, `try` or a loop, are steps; an import inside a function body is not (svl-1x4, svl-i6s). A legend explains the shapes: two entries at first (class instance; function or method call), the rest behind a "More" control.
4. **Step.** Dragging the slider (or pressing ←/→) reveals the graph one event at a time. The current event's box is highlighted, and so is its exact source span in the editor (the call, not just the line). Clicking a box jumps the slider and the editor to that call; placing the cursor on a call in the editor highlights its box.
5. **Inspect.** Hovering a wire shows a preview of the value: column names and first rows of a DataFrame, or an array's shape and dtype. Clicking pins the preview (touch screens have no hover). Clicking an instance shows its attributes before and after the selected method call; attributes that changed are highlighted.
6. **Expand.** A student-defined function draws as a collapsed box. Clicking ▸ expands it in place to show its interior; the wires entering it relabel from the caller's names (`data`) to the parameter names (`df`).
7. **Output.** `print` output appears in the output pane, tagged by event, so stepping back hides output that hadn't been printed yet. `plt.show()` renders the figure there as a PNG.
8. **Errors.** If the code raises, the diagram shows everything up to the failing call, which is drawn in red with the exception message; collapsed functions on the path to it are expanded automatically. The traceback under the editor shows the student's frames only (recorder frames removed, library frames folded), with line numbers.

**Share links** encode the code (deflate + base64url) and small inline data in the URL fragment, as Python Tutor and Pandas Tutor do, so an instructor can link a ready-made example from slides. Code that arrives by link is shown but never run until the reader presses Run. Links over about 8 KB are refused with a message.

**Accessibility.** Nothing is conveyed by colour alone: function and instance boxes differ in shape and header, errors carry an icon and text, and changed attributes carry a marker. The timeline doubles as a text list of events that a screen reader can walk. Every action has a keyboard path. Animations respect `prefers-reduced-motion`.

**Supported browsers.** Current desktop Chrome, Firefox and Safari. Tablets are best-effort; memory limits on iPadOS may rule out larger examples.

## Documentation

Any function, class, method or class attribute (an instance box's parameter and fitted-attribute rows, and attribute-read boxes such as `model.coef_`) in the diagram can show its official documentation in a friendly layout: summary, signature, parameters with types, returns, raises, see also and examples. The content comes from the docstrings installed in the browser's Python, so it works offline, matches the library versions the student is running, and sends nothing anywhere. A link to the full official page, pinned to those versions (scikit-learn, pandas, NumPy, SciPy, Matplotlib, Python), opens in a new tab when the student clicks it; the page itself never requests it. The student's own functions show their own docstrings and no link. Contract: CONTRACTS.md section 12.

## Architecture

Everything runs in the student's browser; the only server is static file hosting.

&#91;embedded content: architecture · main thread and worker\]

The worker owns Python: it rewrites the source, runs it on Pyodide with the hooks installed, and streams events back in batches. The main thread never sees Python objects, only those messages, which it assembles into one event log document. The renderer can therefore be tested and reused (in Jupyter) independently of the runtime.

- **Isolation.** Python runs in a dedicated Web Worker, so the page stays responsive.
- **Stopping.** If the page is cross-origin isolated, Stop and the timeout raise `KeyboardInterrupt` through Pyodide's interrupt buffer, which keeps the warm interpreter. If that has no effect within 2 seconds (a long-running C loop), or the page is not isolated, the main thread calls `worker.terminate()` and starts a new worker. A restart re-initializes Pyodide and re-imports the packages, which takes seconds even from cache; measure it in milestone 1.
- **Streaming.** The worker flushes recorded events at least every 100 ms. If the worker has to be killed, the main thread still has everything up to the last flush and writes `status: "timeout"` or `"stopped"` itself. A worker that is dead cannot post a final log, so nothing may depend on one.
- **Files.** Course datasets are written into Pyodide's in-memory filesystem when the worker starts; uploads are written there on demand. `pd.read_csv("listings.csv")` works unchanged.
- **Messages.** Main → worker: `{run: source, config}`, `{file: name, bytes}`. Worker → main: `{progress}` during load, `{ready}`, then per run `{started, sites}`, repeated `{batch: events, values, scopes, output}`, and `{done, status, error}`.
- **Between runs.** Each run gets a fresh namespace in the warm interpreter. The recorder's tables are cleared, matplotlib figures are closed and pandas options are reset. Other global state a student changes (a monkeypatched module, files written) persists, so a "Restart Python" menu item starts a new worker.

## Instrumentation

The recorder rewrites the student's source before running it, rather than tracing at runtime. `sys.settrace` and `sys.monitoring` report every call, including thousands inside pandas and sklearn; rewriting touches only code the student wrote, so each call they typed becomes exactly one event, with its source span known. Rewriting also tells the recorder how each argument was spelled (a literal, a name, a nested call, some other expression), which the value model below depends on.

**Pipeline**

1. Parse the source with `ast.parse`. On a `SyntaxError`, report it and stop; nothing runs.
2. Apply the `Instrument` transformer (below), then `ast.fix_missing_locations`. The transformer also builds the **site table**: one entry per rewritten node.
3. Compile with the filename `<student>` and register the source with `linecache`, so tracebacks keep the student's line numbers and text.
4. Run in a fresh namespace dict with the hooks installed in `builtins`.
5. Stream events, values and scopes to the main thread as they are recorded.

**Site table**

Each entry holds `line`, `col`, `end_line`, `end_col`, the source `text`, and for calls, assignments and returns an **origin** for each value expression:

| Origin | Expression | Meaning |
| --- | --- | --- |
| `const` | a literal (`0.2`, `"price"`, `None`, `True`) | shown on the port; never wired |
| `name` | a bare name (`X_train`) | the value currently bound to that name |
| `call` | a call that is itself recorded | that event's output |
| `expr` | anything else (`df["price"]`, `a + b`, `model.coef_`, a hidden call) | an expression node, with the names it reads |

Hooks receive a site index, not line and column, so the hook signatures stay small and fixed.

**Hooks**

| Hook | Inserted at | Records |
| --- | --- | --- |
| `__rec__(site, fn, /, *args, **kwargs)` | every call site | callee, bound inputs, outputs, scope, owner instance, mutations |
| `__scope__(fn)` | every `def` and `lambda`, as the innermost decorator | entry and exit of one invocation of a student function; parameter bindings |
| `__bind__(site, {name: value})` | after every assignment to a name, loop target and `with … as` | name → value in the current, global or nonlocal scope |
| `__store__(site, base)` | after every assignment to a subscript or attribute (`df["c"] = v`, `df.loc[m, "c"] = 0`, `obj.a = v`) | an in-place change to `base` |
| `__ret__(site, value)` | around the expression of every `return` | which value the function returned |

Hook names end in a double underscore so Python's private-name mangling inside class bodies leaves them alone. They live in `builtins`, so any namespace can reach them and they never appear in `globals()`. The leading parameters of every hook are positional-only, so a student keyword argument named `site` or `fn` cannot collide with them.

**Transformer rules**

- `Call` → `__rec__(site, <func>, <args>, <keywords>)`, after visiting children so nested calls are wrapped first. Starred and double-starred arguments pass through unchanged; origins for arguments at or after a starred one are unknown and fall back to identity.
- Calls that depend on the caller's frame are left unwrapped: a bare-name call to `super`, `locals`, `globals`, `vars`, `dir`, `eval`, `exec` or `breakpoint`. (Zero-argument `super()` raises `RuntimeError` if it is called from the hook's frame instead of the method's.)
- `FunctionDef` → append `__scope__` to `decorator_list` (last means innermost, so it wraps the raw function beneath `@staticmethod`, `@property`, etc.). The wrapper uses `functools.wraps`, so `inspect.signature`, `get_params` and `__name__` see the original.
- `Lambda` → `__scope__(lambda …)`.
- A `def` whose own body contains `yield` or `await`, and every `async def`, is left completely uninstrumented: no hooks inside it, no `__scope__`. It runs as plain Python and draws as an opaque box.
- `Assign`, `AugAssign`, `AnnAssign` with a value → the statement, then `__bind__` for the `Name` targets, and `__store__` for subscript and attribute targets whose root is a name. The site records the origin of the right-hand side, and whether the target is a tuple of n names.
- `For` → `__bind__` of the loop target as the first statement of the body. `With` → `__bind__` of each `as` target as the first statement of the body.
- `Return` with a value → `return __ret__(site, <expr>)`.
- `Global` / `Nonlocal` declarations in a function body set `where="global"` / `"nonlocal"` in the site entries of that function's binds for those names.
- Statements directly in a class body get no `__bind__` (class attributes are not names in the enclosing scope).
- `NamedExpr` (`:=`) and `del` are not bound in v1. `import` is not bound either, but each import statement that runs in module scope is recorded as an `import` site and an `import` event (a hook statement after it; the statement itself runs unchanged) so the diagram can place the imported object at its own step, and show the module in parentheses in each call box whose callee goes through the imported name (`pd` to `pd.read_csv`, `LinearRegression` to `LinearRegression()`). A name that is bound anywhere else in the program (rebound, shadowed, star-imported over) gets no node and no wire.

**Hook behaviour**

- **Transparency.** Every hook returns exactly what the original expression would have, and re-raises exactly what it raised. If `inspect.signature(fn).bind(...)` fails, the hook labels inputs `arg0`, `arg1`… and still makes the call, so the student sees Python's own error. Signatures are cached per callable.
- **No re-entry.** While the recorder is summarizing a value it sets a flag that turns every hook into a pass-through. Otherwise a student `__repr__`, `__len__` or property called during summarization would record events of its own.
- **Fast path.** Calls the configuration says are not drawn (below) are made directly and not recorded. So are calls past the per-site cap.
- **Always installed.** In Jupyter the hooks stay in `builtins` for the life of the kernel and pass through when no recording is active. Functions defined in a `%%machines` cell keep their hooks, and must still work when called from an ordinary cell.

**Call filtering**

The recorder decides what to record from the callee's top-level module, using the draw list in the run `config`:

| Callee | Recorded and drawn by default |
| --- | --- |
| sklearn, pandas, numpy functions, classes and methods | yes |
| student-defined functions and classes | yes, collapsible |
| `print`, `len`, `range`, `isinstance` and other builtins | no (toggle in settings) |
| methods of `str`, `list`, `dict` | no (toggle in settings) |
| everything else (`math`, `random`, `os`, …) | no, unless the course allowlist adds the module |

Changing a toggle re-runs the code. A call that isn't recorded is treated like any other expression: if its result reaches a call box, it appears as an expression node labelled with its source text (`round(score, 3)`). Hidden calls do not count against the event cap.

## Value model

Wires connect the event that produced a value to the events that consumed it. The recorder gives every value a **token**, and uses two different rules to decide when two uses are the same value.

**Reference values** (DataFrames, arrays, estimators, lists, dicts, any other object) are matched by identity. Tokens look like `v12.0`: object 12, version 0. Object numbers are assigned in first-seen order, so the log for a given program is the same on every run and `id()` never appears in it.

- The recorder keeps a table from `id()` to object number. For objects that support weak references (DataFrames, arrays, estimators, most class instances) a finalizer removes the entry when the object dies, so a reused `id()` is harmless and intermediate tables are freed as in normal Python. Objects that don't (lists, dicts, tuples) are kept alive until the run ends.
- **Versions.** A mutated object keeps its identity, so identity alone can't tell `df` before and after `df.dropna(inplace=True)`. The recorder stores a fingerprint per object and bumps the version when it changes. The fingerprint is structural (shape, columns, dtypes; an estimator's attribute names and the identity of their values; a list's length and item identities), plus a content hash for tables and arrays under 100,000 cells. It is checked when an object is read as an input, after each recorded call for the owner and inputs, and in `__bind__` and `__store__`. A recorded call that changes an input lists the change in `mutates`.
- After a recorded call, the same check runs for every tracked estimator reachable from the owner or inputs through `get_params(deep=True)`. That is how a `scaler` inside a pipeline shows its fitted attributes at the `pipe.fit` event.

**Scalars** (`int`, `float`, `bool`, `str`, `bytes`, `None`) are never matched by identity. CPython shares small integers, interned strings, `True`, `False`, `None` and constants within a code object, so matching them by `id()` would wire a function that returns `5` to every unrelated literal `5` in the program. A scalar gets a fresh token each time it is produced (by an event, an expression, or a loop target) and travels only through names: a `name` origin resolves to the token that name holds in the current scope, then its lexical parents, then the module. `__ret__` carries a returned scalar's token out to the calling event.

**Expression nodes.** An `expr` origin creates an event of kind `expr` when its value has no token yet or is a scalar. It is drawn as a small unboxed label showing the source text, with dashed wires from the values of the names it reads. `y = df["price"]` therefore shows `y` coming from `df`, and `X_train - mean` shows both operands, without the recorder hooking subscripts or operators. If the value already has a token (`m = models["rf"]`), no node is created; the name is simply another label for the same value. Expression nodes whose result reaches no call, store or box are not drawn; one whose result is an object always has that object's box after it.

**Tuple returns** are split into separate outputs only when the call is the right-hand side of an unpacking assignment with the same number of targets (`X_train, X_test, y_train, y_test = train_test_split(...)`), or when a student function returns a tuple literal. Otherwise the tuple is one output of type `tuple[n]`.

**Stores.** `__store__` records an event of kind `store`, drawn as a small box, styled like a function call, labelled with the target text (`df["age2"] = …`). Its inputs are the old version of the base object and the right-hand side; its output is the new version.

## Scoping model

Scopes do two separate jobs, and the recorder tracks them separately. The **dynamic** call tree decides which box a call is drawn inside. **Lexical** bindings decide what a value is called in the view being drawn.

**Scope records**

A `Scope` is one invocation of a student function, or the module:

| Field | Meaning |
| --- | --- |
| `id` | unique per invocation, so recursion gives distinct scopes |
| `name` | `<module>`, or the function's `__qualname__` (`prep`, `Cleaner.fit`) |
| `parent_event` | index of the call event that was executing when this scope opened; `null` for the module |
| `lexical_parent` | the scope in which the `def` ran, captured when the decorator is applied |
| `bindings` | ordered list of `(event_index, name, token)` |

The runtime keeps two stacks. `SCOPES` is pushed and popped by the `__scope__` wrapper (in `try/finally`). `CALLS` is pushed and popped by `__rec__` around the actual call.

**Rules**

- Every event records `scope = SCOPES[-1].id`.
- A new scope's `parent_event` is `CALLS[-1]`. That covers both ordinary calls and callbacks: when `df.apply(my_func)` calls `my_func`, the `apply` event is on `CALLS`, so `my_func`'s interior nests under the `apply` box. The same holds for `FunctionTransformer(func)`, `sorted(key=…)`, and so on.
- On entry, `__scope__` binds parameters with `inspect.signature(fn).bind(*args, **kwargs)`, so `data` passed as `df` gets a binding `df` in the new scope.
- `__bind__` with `where="local"` writes to `SCOPES[-1]`; `"global"` writes to the module scope; `"nonlocal"` writes to the nearest `lexical_parent` that already binds that name, falling back to the immediate lexical parent.
- Bindings are time-indexed. A wire's label is the name its value had, in the drawn scope, at the event that produced it. In `X = X.drop(...)`, the old value is `X` and the new one is `X′`: each new value bound to a name gets one more prime, in time order (`X`, `X′`, `X″`, then `X‴` for any later one, as a loop rebinds on every pass). Box titles, port names and wire labels all follow this rule.

**Merge keys**

An event's merge key is `(merge key of its scope's parent event, function qualname of its scope, site)`. Events with the same key are the same box in the static graph. The key deliberately leaves out the scope `id`: 500 invocations of a callback under one `apply` have 500 scopes but one set of keys, so they merge exactly as loop iterations do.

**Not scopes in the picture**

- Comprehensions: calls inside them belong to the enclosing scope. Students don't think of them as functions, and since Python 3.12 (PEP 709) list, dict and set comprehensions are inlined anyway.
- Class bodies: the body's calls belong to the enclosing scope; methods get scopes when called.
- Generator and async functions: not instrumented (see transformer rules), so they have no scope and no interior.

## Event log schema

The main thread assembles the streamed messages into one JSON document. It is the contract for tests and the Jupyter frontend. Preview cells and scalar values are pre-formatted strings, so `NaN`, infinities, numpy scalars and timestamps never reach the JSON encoder.

```json
{
  "version": 2,
  "status": "ok",
  "error": null,
  "sites": [
    {"id": 7, "line": 10, "col": 35, "end_line": 10, "end_col": 75,
     "text": "train_test_split(X, y, test_size=0.2)", "unpack": 4}
  ],
  "scopes": [
    {"id": 0, "name": "<module>", "parent_event": null, "lexical_parent": null,
     "bindings": [[0, "data", "v1.0"], [1, "X", "v2.0"], [2, "y", "v3.0"],
                  [3, "X_train", "v4.0"]]}
  ],
  "values": {
    "v1.0": {"type": "DF", "shape": [500, 8], "columns": ["beds", "price"],
             "preview": {"columns": ["beds", "price"], "rows": [["2", "180"]]}},
    "v3.0": {"type": "Series", "shape": [500], "dtype": "int64"}
  },
  "events": [
    {"i": 3, "ret": 3, "site": 7, "scope": 0, "kind": "function",
     "name": "train_test_split", "module": "sklearn.model_selection",
     "owner": null,
     "inputs": [{"param": "arrays[0]", "origin": "name", "value": "v2.0"},
                {"param": "arrays[1]", "origin": "name", "value": "v3.0"},
                {"param": "test_size", "origin": "const", "text": "0.2"}],
     "outputs": ["v4.0", "v5.0", "v6.0", "v7.0"],
     "returns_self": false,
     "mutates": [],
     "count": 1,
     "error": null}
  ],
  "output": [{"i": 3, "stream": "stdout", "text": "…"}]
}
```

**Fields**

| Field | Notes |
| --- | --- |
| `status` | `ok`, `error` (student exception), `timeout`, `stopped`, `limit` (a cap was hit) |
| `values` | keyed by token; written once per value version |
| `values[*].type` | display type: `DF`, `Series`, `array`, `sparse`, `int`, `float`, `str`, `bool`, `None`, `list[n]`, `dict[n]`, `tuple[n]`, or the class name |
| `values[*].columns` | DataFrames: column names, up to 50 |
| `values[*].preview` | DataFrame: first 5 rows × first 8 columns; array or sparse matrix: first 5 × 5 entries; scalars: `reprlib.repr` truncated to 40 characters |
| `values[*].attrs` | instances with memory only (the summary's `machine` flag): `{name: token}`. For estimators, constructor parameters plus public attributes ending in `_`. For student classes, all public instance attributes. |
| `events[*].kind` | `function`, `method`, `constructor`, `student_function`, `expr`, `store` |
| `events[*].i`, `ret` | `i` is the event's index, assigned when the call starts. `ret` is the index of the last event that started before it returned (equal to `i` for a library call). |
| `inputs[*].param` | the parameter name from `inspect.signature`, indexed for varargs (`arrays[0]`); `arg0`, `arg1`… when binding fails. Only arguments the student passed are listed. |
| `outputs` | see tuple returns above; `None` returns are omitted |
| `returns_self` | `true` when the return value is the owner (`fit` returning `self`); drawn as no new wire |
| `mutates` | `[[before, after], …]` tokens of objects this event changed in place, including the owner of `fit` |
| `count` | how many times this merge key had executed when this event was recorded (for ×n badges) |
| `error` | `{"type": "ValueError", "message": "…", "handled": false}` on the innermost event that raised. Enclosing events get `"propagated": true`. `handled` is set if the student's own `try/except` caught it. |

## Graph model and rendering

The main thread turns the event log into a graph, lays it out with ELK.js, and draws SVG in the slides' visual style.

**Objects and scalars**

Every **reference value** (a token like `v12.0`) is an **object** and is drawn as its own blue instance box, one box per object: DataFrames, Series, arrays, sparse matrices, lists, dicts, estimators and student class instances alike (owner decision, 2026-11-18). An **object with memory** (an instance of `sklearn.base.BaseEstimator` or of a student-defined class; the course configuration can add classes) is the same kind of box with more to show: its parameters and fitted attributes. A **data box** shows what the summary already holds: `shape`, then `dtype` (Series, arrays) or the first few `columns` (DataFrames, cut with "…"). Its title carries the type and the name: `X_train: DF`. Lists, dicts and tuples show only their title (`models: dict[2]`). Click opens the preview (inspect).

**Scalars** (`s` tokens: numbers, strings, `None`, small tuples) are not boxes. They stay as const text on ports and as labelled wires (`float 0.2`, `r2`).

In-place mutation (`df.dropna(inplace=True)`, `df["c"] = …`) is a **new version of the same box**, not a new box and not an output port. Two different objects are never merged into one box, and a call that returns an object that already has a box (`np.asarray(a)` returning `a`) adds no box and no wire: a missing wire is acceptable, a false one is not.

**Graph construction**

| Graph element | Built from |
| --- | --- |
| Import block | an `import` event (one per executed `import` / `from … import` statement): one small box per name the statement binds, `name (module)`, shown at that step and with no wires. Imports inside a function body are not events |
| Function call (orange box) | a `function` or `student_function` event; a `constructor` event (`LinearRegression()` or `pd.DataFrame(...)` is an ordinary orange function box whose args are on input ports and whose output wire creates the instance box; its name carries `(module)` when the program imported it) |
| Instance box (blue) | one per object, created by the output wire of the call or expression that first returns it: a constructor box, `pd.read_csv`, each of `train_test_split`'s four outputs, `np.mean` returning an array, `make_pipeline`. An object that no recorded event produced appears at its first use. A loop's objects from one call site share one box (instances merge by creating site). |
| Method call (orange box inside the blue one) | a `method` event whose owner is that object, whether a model or data. One box per method name and object: `scaler.transform(X_train)` and `scaler.transform(X_test)` share one `transform` box with a ×2 badge, and its wires switch to each call's values as the timeline steps. `df.dropna()` is a `dropna` box inside the `df` box; its output wire creates the next box, `df′`. The boxes for the methods this run calls on an object exist from the moment the object is created, with the text "not called yet" under the name (the box is drawn solid, like any other), and become active at their first call. The owner is the box, so it is not a port (no `self`). |
| Input port (top edge) | one per entry in `inputs`: `param` and, for a scalar, its type. `const` inputs are written on the port as `param = text`. An object input shows only `param`: the box it comes from shows the type and shape. Constructor arguments are ports of the constructor box (and also listed in the instance's parameter list). |
| Output port (bottom edge) | one per entry in `outputs`, labelled with the bound name (and the type, for a scalar). An object output is wired to its new box. In-place mutation has no port: it is a new version of the owner's box. |
| Wire | from the event that produced a value to each event that consumed it. An object is wired from its box's border: `train_test_split(X, y)` takes the `X` and `y` boxes, `model.fit(X_train, y_train)` takes the `X_train` and `y_train` boxes. Wires from a box carry no label (the box has the name); scalar wires keep `type` and name. |
| Expression node (no box) | an `expr` event, with dashed wires from the values it reads. If its result is an object, a dashed wire leads on to that object's box (`y = df["price"]`: `df` box, expression, `y` box). |
| Source node (no box) | a *scalar* that was consumed but has no producing event: a loop variable, or in Jupyter a variable from an earlier cell. Labelled with its name. |

Example, `golden_split`: `read_csv` makes the `df` box, the `dropna` box sits inside it and makes the `df′` box (the new binding gets the prime), two dashed expressions make the `X` and `y` boxes, and `train_test_split` takes both and makes four boxes, `X_train`, `X_test`, `y_train`, `y_test`.

Only events in the scope being viewed are drawn. The top-level view shows module-scope events. A box that is expanded becomes a compound node containing the events of every scope whose `parent_event` is that box's event. This applies to `student_function` boxes and to library calls that invoked student callbacks.

**Loops and repeated calls**

Events with the same merge key share one box with a ×n badge. The static graph wires the box to the values of its latest execution. On the timeline every recorded execution is a step: stepping onto the third iteration highlights the same box, sets the badge to 3 of n, and switches the box's wires and previews to that iteration's values. Instances merge by the site that created them, in the same way. A method box merges every call of that method on its instance, whatever the call site.

**Timeline**

Steps follow event index `i`. An event's box appears at step `i` and its output wires at step `ret`, so a student function's box appears, then its interior plays, then its outputs appear.

The timeline is also a rail in the code gutter (between the line numbers and the code). Each executed line shows one dot per recorded event on it, in time order: filled for ran, ringed for current, hollow for not yet reached. A line run more than 8 times collapses to a "×n" chip, which reads "k of n" while one of its executions is current. Clicking a dot steps there (a chip steps to the line's next execution). With the rail focused, Down/j and Up/k step later and earlier, Home/End jump to the ends. The rail clears when the code is edited after a run. The slider, prev/next buttons and event list sit above the editor.

**Layout**

- ELK.js `layered` algorithm, direction `DOWN`, run in the main thread (it is fast enough for a few hundred nodes; move it to a second worker if not).
- Ports use `FIXED_ORDER`: inputs `NORTH`, outputs `SOUTH`, ordered as in the signature. (`FIXED_SIDE` alone does not preserve order.)
- `elk.layered.considerModelOrder.strategy: NODES_AND_EDGES`, with nodes supplied in source order. The diagram then reads top to bottom like the code, and stays put when a student edits one line and re-runs.
- `hierarchyHandling: INCLUDE_CHILDREN` on the root, so wires to `fit` and `predict` route into the blue box.
- Layout is computed for the full run. Stepping reveals elements without re-running layout, so boxes never jump around while a student scrubs. Expanding or collapsing a box is the only action that re-runs layout, with an animated transition.

**Visual style** (matching the course slides)

- Function and method boxes (constructors included): salmon fill, rounded corners, monospace name, with `(module)` in lighter text after the name of an imported function or class. Stores use the same box.
- Instance boxes: light-blue container, darker-blue name pill at the top (`model: LinearRegression`), attribute list underneath as `name type` with the type in gray.
- Port labels: type in black monospace, name in gray monospace one line below.
- Attributes that changed during the selected method call: bold with a ● marker, and a short highlight animation when stepping onto that event.
- The current event: thicker outline. Events not yet reached: hidden. Errors: red outline with a ⚠ icon, message under the box. An exception the student's code caught: the same outline, and the message says it was handled.
- Few distinct styles on purpose (owner decision, 2026-11-19): two box shapes (orange call, blue instance), solid and dashed wires, one outline style for the current step and one for errors. Nothing is told apart by colour alone.
- Colours come from CSS variables so a course can theme them.

## Edge cases and limits

| Case | Behaviour |
| --- | --- |
| `fit` returns `self` | `returns_self: true`; no output wire. Chained `model.fit(X, y).predict(Z)` draws `predict` on the same instance. |
| Method chains on DataFrames (`df.dropna().reset_index()`) | each call is its own box; intermediate values are unlabelled wires |
| Nested calls `f(g(x))` | `g`'s output wires straight into `f`'s input with no name label |
| Column selection and arithmetic (`df["price"]`, `a - b`) | expression node with dashed wires from the names it reads |
| Column assignment (`df["c"] = v`) | `store` event; `df` gets a new version |
| Loops and comprehensions | merged by merge key (above) |
| Callbacks (`apply`, `FunctionTransformer`, `key=`) | student function's interior nests under the library call that invoked it; invocations merge |
| Recursion | one scope per invocation. Recording and drawing both stop at depth 5 of the same function; deeper calls run unrecorded and collapse to a "… n more" box. |
| Two equal literals, or a function returning a small int | never wired to each other (scalars are not matched by identity) |
| Estimators stored in a list or dict (`models["rf"].fit(X, y)`) | owner resolved by identity; drawn on the right instance |
| Estimators cloned by the library (`GridSearchCV`, `ColumnTransformer`) | the clones are library internals and not drawn; the student's original instance stays unfitted, which is true |
| Keyword argument named `site` or `fn`; zero-argument `super()`; `locals()` | work as in plain Python (positional-only hook parameters; frame-dependent calls unwrapped) |
| Student `__repr__` or property called by the recorder | not recorded (re-entry flag) |
| Generator or async function | runs uninstrumented; opaque box |
| Calls whose signature can't be read | inputs labelled `arg0`, `arg1`… |
| In-place mutation | detected by fingerprint. Content changes to tables or arrays over 100,000 cells that keep the same shape and dtypes go undetected and draw as the same value. |
| Student code shadows `print`, `len`, etc. | no effect; hooks have reserved dunder names |
| `n_jobs`, threads, multiprocessing | Pyodide has no threads or processes; confirm in milestone 1 that sklearn falls back to sequential execution, and note it in the UI if a student sets `n_jobs` |
| `input()` | raises a clear "not supported here" error |
| Exceptions | the raising event is recorded with `error`, open scopes are closed by `finally`, and the run ends with `status: "error"` |

**Hard limits** (configurable per course)

- Wall-clock: 30 seconds per run, with Stop always available. Model fitting is slower in WebAssembly than natively; check the course's heaviest example in milestone 1 and adjust.
- Per merge key: the first 20 executions and the latest one are recorded in full; the rest are only counted. The "latest" event is sent as a replaceable slot. Without this, one early loop would use the whole event budget and nothing after it would be drawn.
- Events: 5,000 recorded in total, as a backstop. Beyond that the recorder stops recording, keeps running the code, and sets `status: "limit"`.
- Drawn boxes: 600 after merging and folding; beyond that the view shows the first 600 and says "Showing the first N boxes (up to line L)" in the diagram pane and the event list. Unnamed temporaries used once (`df["sqft"].isna()`) are folded into small chips on their wire; click or Enter on a chip draws its box, and "All objects" draws every box. The diagram follows the current step (readable scale, 80% or more); Fit still shows everything.
- Previews: 5 rows × 8 columns per DataFrame, 1 MB in total. Past that, new values keep type and shape but lose their preview.
- Uploads: warn above 10,000 rows.

**Security and privacy**

The tool runs student code only inside that student's own browser tab, in a worker with no DOM access. No server executes anything, and uploaded data never leaves the browser. One case needs care: a share link runs someone else's code in the reader's browser, with the page's origin. So:

- Host the page on a dedicated origin that holds nothing else: no logins, cookies or other apps. Do not serve it from a path on the course site or LMS.
- Code from a link never runs until the reader presses Run.
- Where the host can send headers, add a Content-Security-Policy that restricts the worker's network access to the page's own origin and the Pyodide files.

## Performance, deployment and testing

**Performance**

- First load downloads Pyodide plus numpy, pandas, scipy and scikit-learn, which is tens of MB. Self-host a pinned copy rather than depending on a CDN, and cache it with a service worker so later loads are reliable and work offline. Measure cold load, warm load and worker restart on a student laptop and on classroom wifi with a full section loading at once, in milestone 1, and record them here.
- Start the download on page open, and import the packages in the worker in the background, before the first Run.
- Each run re-uses the warm interpreter but a fresh namespace, so runs after the first take only the student code's own time plus instrumentation.
- Instrumentation overhead per recorded call is a cached signature bind, fingerprints of the inputs, and a few summaries. Hidden calls and calls past the per-site cap take the fast path. Content hashing is the one cost that scales with data size; if it exceeds 10% of run time on course examples, lower the cell threshold.

**Measured (milestone 1)**, by `pnpm measure` (`scripts/measure.ts`): Apple M2 Pro, 10 cores, 32 GB, macOS 26 (Darwin 25.5); Chrome 157 headless; 2026-11-19; production build served from localhost by `vite preview` (uncompressed, so transfer sizes are an upper bound). Medians; n=3 unless noted.

| Measurement | Result |
| --- | --- |
| Cold load to ready (cache disabled) | 6.8 s (6.7 to 7.1 s); 39.4 MB transferred |
| Warm load to ready (service worker cache) | 6.0 s (5.9 to 6.1 s); 20 requests, all served by the service worker, none to the network |
| Worker restart: Stop on a long C call (`eigvals` of a 4000x4000 matrix), to ready | 7.5 s (7.4 to 7.7 s), including the 2 s stop grace |
| `heavy.py` (10,000 rows, GridSearchCV over a random forest), plain Python | 7.2 s |
| `heavy.py` instrumented | 7.4 s; overhead 0.24 s (3%) |
| `heavy.py` content hashing | 0.3% of the instrumented run |
| `notebook.py` plain / instrumented (n=10) | 6 ms / 38 ms; overhead 32 ms |
| `notebook.py` content hashing | 29% of the instrumented run (about 11 ms) |
| Cold load at ~10 Mbps (40 ms RTT) | 39.2 s |
| Cold load at Fast 3G (1.6 Mbps, 150 ms RTT) | 204.8 s |
| Classroom wifi, a full section loading at once | not measured: a human test for the pilot |

Notes.

- On localhost the 6 to 7 s is mostly CPU (starting Pyodide, unpacking and importing numpy, pandas, scipy and scikit-learn), not download, so warm is barely faster than cold. The cache matters on a real network, where cold scales with bandwidth: about 40 s at 10 Mbps and over 3 minutes on Fast 3G (both uncompressed; a host that serves brotli will be well under that). A restart costs about the same as a warm load, plus the 2 s grace.
- The throttled loads go through a local proxy with a shared bandwidth cap and a round trip per request. CDP network emulation was not used because it does not reach dedicated workers, where Pyodide downloads happen.
- The cold-load transfer figure is the bytes over the link until the page reports ready, so it includes any service-worker precache fetches that had started by then (the cache-disabled cold load fetches each file once for the page; the precache may add to it).
- Runs time the in-Python part (transform and run for instrumented, `exec` for plain) in the same warm worker, using the worker's debug-only `debug` run option, which the page never sets.
- Instrumentation costs a fixed 30 to 40 ms on a notebook-sized program (mostly the AST transform and the first-use setup) and nothing measurable once the program does real work. The 10% hashing rule is judged on runs long enough to matter (over about 1 s): `heavy.py` is 0.3%, so no change. `notebook.py` shows 29%, but that is about 11 ms of a 38 ms run, which no student will notice. `hash_cells` stays at 100,000: lowering it below the size of the course datasets (about 2,000 to 50,000 cells) would stop detecting in-place changes to them, to save milliseconds.
- `wall_ms` stays at 30 s: the heaviest example takes 7.4 s here, which leaves 4x headroom for a slower student laptop.
- `n_jobs=2` and `n_jobs=-1` are accepted and run, but sequentially: RandomForest with 60 trees took about 1.0 s for each of `n_jobs` 1, 2 and -1. There is no speed-up from `n_jobs` in the browser (no threads or processes in Pyodide).

**Deployment**

The recorder (`machines/recorder.py`) is plain Python with no browser dependency. Two frontends share it:

| Frontend | How it runs | Rendering |
| --- | --- | --- |
| Standalone page | static site on its own origin; Pyodide in a Web Worker | the JS renderer |
| Jupyter | `pip install machines`, then `%%machines` at the top of a cell; also works in JupyterLite | the same JS renderer, shipped as an anywidget |

Neither needs a server beyond static file hosting. In Jupyter the cell runs in the kernel's namespace, so variables from earlier cells appear as source nodes.

**Testing**

- Recorder unit tests in CPython (pytest): one fixture program per row of the edge-case table, asserting on the event log JSON. Tokens are deterministic, so expected logs can be checked in.
- Transparency tests: run every example script from the course materials with and without instrumentation, and assert identical stdout, exceptions and final variable values.
- Golden graphs: the slides' examples (`train_test_split`, `OneHotEncoder` fit/transform, `LinearRegression` construct/fit/predict) with checked-in expected logs and expected graph models (nodes, ports, edges). Keep SVG snapshots to a handful; they break on every ELK or style change.
- The same recorder tests run inside Pyodide in CI (Playwright, headless Chromium) to catch version differences between CPython and Pyodide.
- Pin the Pyodide version per course term so packages don't change under students mid-semester.

## Milestones and open questions

Each milestone ends with something students could use.

1. **Spike.** Recorder for top-level calls only (no scopes), Pyodide in a worker with streamed events and Stop, a hard-coded SVG for the `train_test_split` → `LinearRegression` example. Measure load, restart and the heaviest course example. Exit: the slide example renders from real code.
2. **Core diagram.** Full call wrapping, site table and origins, value tokens and versions, expression nodes, ELK layout, instance boxes with fit/predict and attribute diffs. Exit: all three golden examples from the slides match, and the transparency tests pass.
3. **Timeline.** Event slider, editor span sync, hover previews, output pane, error display. Exit: a student can step through a 20-line notebook-style script. Sit three to five students in front of it before going further; the main risk in this project is whether the diagrams help, not whether they can be built.
4. **Scopes.** `__scope__`, `__bind__`, `__ret__`, collapsible student functions, callbacks, merge keys, per-site caps, recursion cap. Exit: every row of the edge-case table has a passing test.
5. **Jupyter frontend.** `%%machines` magic and anywidget, tested in JupyterLab and JupyterLite. Exit: works in the course's notebook environment.
6. **Classroom pilot.** One lab section uses it on a homework. Decide beforehand what is measured: for example, whether students can say what `fit` changed and why `transform` is called on both train and test, compared with a section that didn't use it; plus load times and a log of confusion points.

**Open questions**

- [x] Method boxes: one per method name and instance (owner decision, 2026-11-18). An instance used twice shows one `transform` box with ×2; the box exists from instantiation, uncalled until its first call.
- [x] Every object is a blue box, one per object; scalars stay as port text and wire labels (owner decision, 2026-11-18).
- [ ] Are dashed expression nodes enough for column selection (`X["price"]`) and attribute reads (`model.coef_`), or should those two draw as small boxes?
- [ ] Should pipelines (`make_pipeline(...)`) draw as one instance box containing its steps, using sklearn's own structure, rather than as a function with instance inputs?
- [ ] How much of a DataFrame preview is useful on hover before it clutters?
- [ ] Is a per-course allowlist of drawn modules enough, or do instructors need per-example hide/show controls in the share link?
- [ ] Are matplotlib figures in the output pane needed for v1, or can they wait?
- [ ] Which Pyodide version to pin for the first term, given the sklearn version used in the course materials.
