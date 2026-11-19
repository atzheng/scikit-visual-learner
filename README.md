# Code Diagrams

Code Diagrams is a browser tool for teaching scikit-learn and pandas. A student writes ordinary Python in an editor. Pressing Run executes it in the browser (Pyodide, in a Web Worker) and draws each library call they wrote as a box in a diagram: its arguments come in on wires, its result goes out on wires. A timeline lets them step through the calls one at a time, with the matching code highlighted. Hovering a wire previews the value on it. Clicking a model shows which attributes a call changed.

Nothing leaves the browser: the student's code and uploaded data stay on the page, and the page makes no requests except to its own origin.

- What the product does: [SPEC.md](SPEC.md)
- Exact interfaces between the parts (event log, worker messages, file paths): [CONTRACTS.md](CONTRACTS.md)
- Deploying and hosting: [DEPLOY.md](DEPLOY.md) (written by the deploy bead; it may not exist yet on your branch)

## Layout

| Path              | What it is                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `python/machines` | The recorder: rewrites the student's source with AST hooks and records each library call.    |
| `packages/log`    | Event log types, worker messages, assembler, graph builder, timeline state. Pure TypeScript. |
| `packages/render` | ELK layout and SVG renderer. Framework-free.                                                 |
| `packages/web`    | The page: editor, timeline, previews, output, the Pyodide worker, the service worker.        |
| `fixtures/`       | Example programs, datasets and generated golden logs, streams and graphs.                    |
| `scripts/`        | `measure.ts` (load and overhead numbers) and `lib/` (shared browser helpers).                |

## Run it locally

You need Node 20 or newer, pnpm, [uv](https://docs.astral.sh/uv/) and, for the browser checks, Google Chrome.

```bash
pnpm install && uv sync
pnpm dev            # Vite on http://localhost:5173
```

The first `dev` or `build` downloads the pinned Pyodide distribution into `packages/web/node_modules/.cache/pyodide` (`packages/web/scripts/fetch-pyodide.ts`). After that it works offline.

Other commands:

```bash
pnpm test           # vitest (all packages) + pytest
pnpm test:py        # pytest only
pnpm test:slow      # slow tests: fixture programs in subprocesses, layout timing
pnpm test:pyodide   # recorder tests inside Pyodide on Node
pnpm typecheck
pnpm lint           # eslint, prettier, ruff
pnpm build
pnpm preview        # serve the built site (needs pnpm build first)
pnpm fixtures       # regenerate fixtures/logs, streams, graphs
pnpm e2e            # browser check of the whole page (see below)
pnpm measure        # load, restart and overhead numbers (--quick for a short run)
```

## End-to-end check

`pnpm e2e` is the milestone 3 exit check. It needs `pnpm build` first. It starts `vite preview` on a free port on 127.0.0.1, drives system Chrome with `playwright-core`, and checks:

- the page loads and the runtime becomes ready;
- running `notebook.py` draws boxes, and the timeline sits on its last step;
- stepping through every event with the arrow key moves the current box, the current event and the editor highlight;
- hovering a wire shows a preview; clicking pins it and Escape unpins it;
- clicking the LinearRegression box at the fit step shows `coef_` as changed;
- the output pane hides output when stepping back;
- `edge_error.py` shows the error box, the traceback and the marked line;
- Stop works on an infinite loop, and Python still runs afterwards;
- uploading a CSV makes it readable from the program;
- a share link opens in a fresh browser profile with the same code;
- `edge_mpl.py` shows "Loading matplotlib" in the status line and a figure in the output.

Screenshots (desktop viewport, light and dark) go to a temporary directory; its path is printed at the start and the end. `pnpm e2e --only <text>` runs only the checks whose name contains the text. The checks use roles, labels, `data-` attributes and relative step counts ("N of M") rather than exact counts or positions, but a UI change can still break one. **Beads that change the UI should run `pnpm build && pnpm e2e` before opening a PR.** The e2e makes no network requests and is not part of `pnpm test`. Set `E2E_CHROME` to use a different Chrome binary.

## Course content

Everything a course sets up lives in `packages/web/src/course.ts`:

- **Run configuration** (`DEFAULT_RUN_CONFIG`): which modules are drawn, the time limit, event limits.
- **Datasets** (`DATASETS`): file names that the worker writes into Python's working directory at start, so `pd.read_csv("listings.csv")` works. To add one, put the CSV in `packages/web/public/datasets/` (the worker fetches `/datasets/<name>` from the page's own origin) and add its name to `DATASETS`. Keep each file small: it is downloaded by every student and stored in the service worker cache.
- **Starter example** (`STARTER_EXAMPLE`): the program in the editor on first load. It is currently the synthetic `fixtures/programs/notebook.py`. To use your own, replace the import or the constant.

Students can also upload their own CSVs with the Upload CSV button; those exist only in their browser tab.

Example programs for tests live in `fixtures/programs/`. Each has a header comment saying what it exercises and what to expect. After adding or changing one, run `pnpm fixtures` and review the diff.
