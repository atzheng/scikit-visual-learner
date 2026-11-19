/// <reference types="vite/client" />
/**
 * The Python worker (CONTRACTS.md section 7): self-hosted Pyodide, the recorder, datasets, and one run at a time.
 * Everything comes from this page's own origin (/pyodide/, /datasets/).
 */
import type { PyodideInterface } from 'pyodide';
import type { Doc, FromWorker, RunConfig, ToWorker } from '@machines/log';
import { DATASETS } from '../course';
import { loadsMatplotlib } from './status';

const scope = self as unknown as {
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
  location: Location;
};
const post = (msg: FromWorker): void => scope.postMessage(msg);

// The recorder's Python files, bundled at build time and written into the interpreter's filesystem.
const RECORDER_FILES = import.meta.glob('../../../../python/machines/**/*.py', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const HOME = '/home/pyodide';
const PRELOAD = ['numpy', 'pandas', 'scipy', 'scikit-learn'];

/** Python side of `run`: keyword-only hooks, and the config as a plain dict. */
const BOOTSTRAP = `
import sys
if "/home/pyodide" not in sys.path:
    sys.path.insert(0, "/home/pyodide")
import machines
import machines.runtime as _machines_runtime
machines.install_hooks()

_machines_offline = set()

class _OfflineFinder:
    """Imports of packages that failed to load raise a clear error instead of 'No module named'."""
    @staticmethod
    def find_spec(name, path=None, target=None):
        if name.split(".")[0] in _machines_offline:
            raise ModuleNotFoundError(
                f"{name!r} is not available offline in this tool (only numpy, pandas, scipy, scikit-learn and matplotlib are included)",
                name=name,
            )
        return None

sys.meta_path.insert(0, _OfflineFinder)

def _machines_worker_run(source, config, emit, on_enter, on_exit):
    _machines_runtime.run(source, config, emit, on_enter=on_enter, on_exit=on_exit)

def _machines_docs(module, name, source, attr):
    import json
    from machines.docs import docs
    return json.dumps(docs(module, name, source, bool(attr)))

def _machines_versions():
    import numpy, pandas, sklearn
    return {
        "python": sys.version.split()[0],
        "numpy": numpy.__version__,
        "pandas": pandas.__version__,
        "sklearn": sklearn.__version__,
    }
`;

/** Measurement only (msg.debug, see `pnpm measure`): plain exec without the recorder, or a recorded run timing content hashing. */
const DEBUG_RUN = `
def _machines_debug_run(source, config, emit, on_enter, on_exit, mode):
    import contextlib, io, json, time
    if mode == "plain":
        buf = io.StringIO()
        t0 = time.perf_counter()
        try:
            with contextlib.redirect_stdout(buf):
                exec(compile(source, "<student>", "exec"), {"__name__": "__main__"})
        finally:
            ms = (time.perf_counter() - t0) * 1000
        return json.dumps({"mode": mode, "ms": ms})
    import machines.values as _v
    spent = [0.0]
    depth = [0]
    def timed(fn):
        def wrapper(*a, **k):
            if depth[0]:
                return fn(*a, **k)
            depth[0] = 1
            t = time.perf_counter()
            try:
                return fn(*a, **k)
            finally:
                spent[0] += time.perf_counter() - t
                depth[0] = 0
        return wrapper
    old_digest, old_ph = _v._digest, _v.ValueTable.__dict__["_pandas_hash"]
    _v._digest = timed(old_digest)
    _v.ValueTable._pandas_hash = staticmethod(timed(old_ph.__func__))
    t0 = time.perf_counter()
    try:
        _machines_runtime.run(source, config, emit, on_enter=on_enter, on_exit=on_exit)
    finally:
        ms = (time.perf_counter() - t0) * 1000
        _v._digest = old_digest
        _v.ValueTable._pandas_hash = old_ph
    return json.dumps({"mode": mode, "ms": ms, "hash_ms": spent[0] * 1000})
`;

let pyodide: PyodideInterface;
let interrupt: Int32Array | undefined;
let currentCall: Int32Array | undefined;

/** Python `None` crosses as `undefined` and big ints as BigInt; the log wants `null` and numbers. */
function clean(x: unknown): unknown {
  if (x === undefined) return null;
  if (typeof x === 'bigint') return Number(x);
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) x[i] = clean(x[i]);
    return x;
  }
  if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    for (const k of Object.keys(o)) o[k] = clean(o[k]);
    return o;
  }
  return x;
}

async function init(msg: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  if (msg.interruptBuffer) interrupt = new Int32Array(msg.interruptBuffer);
  if (msg.currentCall) currentCall = new Int32Array(msg.currentCall);

  post({ type: 'progress', phase: 'pyodide', done: 0, total: 1 });
  const base = new URL('/pyodide/', scope.location.href).href;
  const mod = (await import(/* @vite-ignore */ `${base}pyodide.mjs`)) as {
    loadPyodide(o: { indexURL: string }): Promise<PyodideInterface>;
  };
  pyodide = await mod.loadPyodide({ indexURL: base });
  if (interrupt) pyodide.setInterruptBuffer(interrupt);
  post({ type: 'progress', phase: 'pyodide', done: 1, total: 1 });

  // Importing numpy, pandas and sklearn here (not at the first Run) is the point of "load in the background".
  const total = PRELOAD.length + 1;
  post({ type: 'progress', phase: 'packages', done: 0, total });
  for (const [k, name] of PRELOAD.entries()) {
    await pyodide.loadPackage(name);
    post({ type: 'progress', phase: 'packages', done: k + 1, total });
  }

  post({ type: 'progress', phase: 'recorder', done: 0, total: 1 });
  const prefix = /^.*\/python\/machines\//;
  for (const [path, text] of Object.entries(RECORDER_FILES)) {
    const dest = `${HOME}/machines/${path.replace(prefix, '')}`;
    pyodide.FS.mkdirTree(dest.slice(0, dest.lastIndexOf('/')));
    pyodide.FS.writeFile(dest, text);
  }
  pyodide.runPython(BOOTSTRAP);
  const versions = pyodide.globals.get('_machines_versions')() as {
    toJs(o: { dict_converter: typeof Object.fromEntries }): Record<string, string>;
    destroy(): void;
  };
  const v = versions.toJs({ dict_converter: Object.fromEntries });
  versions.destroy();
  post({ type: 'progress', phase: 'packages', done: total, total });
  post({ type: 'progress', phase: 'recorder', done: 1, total: 1 });

  post({ type: 'progress', phase: 'datasets', done: 0, total: DATASETS.length });
  for (const [k, name] of DATASETS.entries()) {
    const res = await fetch(new URL(`/datasets/${name}`, scope.location.href));
    if (!res.ok) throw new Error(`could not load dataset ${name}: ${res.status}`);
    pyodide.FS.writeFile(`${HOME}/${name}`, new Uint8Array(await res.arrayBuffer()));
    post({ type: 'progress', phase: 'datasets', done: k + 1, total: DATASETS.length });
  }

  post({ type: 'ready', versions: { pyodide: pyodide.version, ...v } });
}

/** `currentCall` stack: `on_exit` only names the call that finished, so the outer call is restored from here. */
function makeHooks(): { onEnter(i: number, site: number): void; onExit(i: number): void } {
  const stack: [number, number][] = [];
  const write = (): void => {
    if (!currentCall) return;
    const top = stack[stack.length - 1];
    Atomics.store(currentCall, 1, top ? top[1] : 0);
    Atomics.store(currentCall, 0, top ? top[0] + 1 : 0);
  };
  return {
    onEnter(i, site) {
      stack.push([i, site]);
      write();
    },
    onExit(i) {
      while (stack.length > 0 && (stack[stack.length - 1] as [number, number])[0] !== i)
        stack.pop();
      stack.pop();
      write();
    },
  };
}

/** Pyodide's wasm stack overflowed (deep recursion through C frames): the interpreter cannot be used again. */
function isFatal(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /fatal|Maximum call stack|memory access out of bounds/i.test(m);
}

/**
 * Loads the packages `source` imports (matplotlib arrives this way). Packages the lock file lists but the site
 * doesn't ship fail to fetch; those names get an ImportError that says so, instead of a raw fetch error.
 */
async function loadImports(source: string): Promise<void> {
  const offline = pyodide.globals.get('_machines_offline') as {
    clear(): void;
    update(x: unknown): void;
  };
  offline.clear();
  // A failed fetch may be thrown or only reported through `errorCallback`, so watch both.
  let mplLoading = false;
  const tryLoad = async (code: string): Promise<boolean> => {
    let failed = false;
    try {
      await pyodide.loadPackagesFromImports(code, {
        errorCallback: () => (failed = true),
        // Pyodide reports "Loading a, b" only for packages not yet loaded, so this also covers indirect imports.
        messageCallback: (m: string) => {
          if (!mplLoading && loadsMatplotlib(m)) {
            mplLoading = true;
            post({ type: 'progress', phase: 'matplotlib', done: 0, total: 1 });
          }
        },
      });
    } catch {
      failed = true;
    }
    return !failed;
  };
  try {
    if (await tryLoad(source)) return;
  } finally {
    if (mplLoading) post({ type: 'progress', phase: 'matplotlib', done: 1, total: 1 });
  }
  // Find out which imports are the problem, one at a time.
  const names = pyodide.runPython(
    'import json\nfrom pyodide.code import find_imports\njson.dumps(find_imports(_machines_source))',
    { globals: pyodide.toPy({ _machines_source: source }) },
  ) as string;
  const missing: string[] = [];
  for (const name of JSON.parse(names) as string[]) {
    if (!(await tryLoad(`import ${name}`))) missing.push(name);
  }
  offline.update(pyodide.toPy(missing));
}

function isInterrupt(e: unknown): boolean {
  return e instanceof Error && e.message.includes('KeyboardInterrupt');
}

async function run(msg: Extract<ToWorker, { type: 'run' }>): Promise<void> {
  const { runId, source, config } = msg;
  let started = false;
  let finished = false;
  const send = (m: Record<string, unknown>): void => {
    if (m.type === 'started') started = true;
    if (m.type === 'done') finished = true;
    post({ ...m, runId } as unknown as FromWorker);
  };
  const emit = (d: {
    toJs(o: { dict_converter: typeof Object.fromEntries }): unknown;
    destroy(): void;
  }) => {
    const m = d.toJs({ dict_converter: Object.fromEntries });
    d.destroy();
    send(clean(m) as Record<string, unknown>);
  };
  try {
    // The client raises the interrupt only after `started`, so a flag still set here is stale.
    if (interrupt) Atomics.store(interrupt, 0, 0);
    if (currentCall) Atomics.store(currentCall, 0, 0);
    await loadImports(source);
    const { onEnter, onExit } = makeHooks();
    const cfg = pyodide.toPy(config satisfies RunConfig);
    const fn = pyodide.globals.get('_machines_worker_run') as (...a: unknown[]) => void;
    try {
      if (msg.debug) {
        pyodide.runPython(DEBUG_RUN);
        const dbg = pyodide.globals.get('_machines_debug_run') as (...a: unknown[]) => string;
        const out = dbg(source, cfg, emit, onEnter, onExit, msg.debug);
        console.log(`[machines-debug] ${out}`);
        if (msg.debug === 'plain') {
          send({ type: 'started', sites: [] });
          send({ type: 'done', status: 'ok', error: null });
        }
      } else fn(source, cfg, emit, onEnter, onExit);
    } finally {
      cfg.destroy();
    }
  } catch (e) {
    if (isFatal(e)) {
      // Surface as a worker `error` event: the client finishes the run as an error and starts a new worker.
      setTimeout(() => {
        throw new Error(
          'Python crashed (the stack overflowed, usually from very deep recursion through library code). Python was restarted.',
        );
      });
      return;
    }
    // `run()` reports its own errors through `done`; this is the worker's own failure or a stop before it began.
    if (!finished) {
      if (!started) send({ type: 'started', sites: [] });
      if (isInterrupt(e)) send({ type: 'done', status: 'stopped', error: null });
      else {
        const message = e instanceof Error ? e.message : String(e);
        send({
          type: 'done',
          status: 'error',
          error: { type: 'WorkerError', message, line: null, traceback: [] },
        });
      }
    }
  } finally {
    if (interrupt) Atomics.store(interrupt, 0, 0); // a late Stop must not interrupt the next run
  }
}

function writeFile(msg: Extract<ToWorker, { type: 'file' }>): void {
  const name = msg.name.split(/[\\/]/).pop() ?? msg.name;
  const bytes = new Uint8Array(msg.bytes);
  pyodide.FS.writeFile(`${HOME}/${name}`, bytes);
  if (!name.toLowerCase().endsWith('.csv')) {
    post({ type: 'fileWritten', name: msg.name });
    return;
  }
  let lines = 0;
  for (const b of bytes) if (b === 10) lines++;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) lines++;
  post({ type: 'fileWritten', name: msg.name, rows: Math.max(0, lines - 1) });
}

/** Documentation lookups run between runs (the message chain is one at a time) and never touch student code. */
function lookupDocs(msg: Extract<ToWorker, { type: 'docs' }>): void {
  const { target } = msg;
  const fn = pyodide.globals.get('_machines_docs') as (...a: unknown[]) => string;
  let doc: Doc;
  try {
    doc = JSON.parse(
      fn(target.module ?? undefined, target.name, target.source ?? undefined, target.attr === true),
    ) as Doc;
  } catch {
    doc = {
      qualname: target.name,
      kind: target.attr ? 'attribute' : 'function',
      signature: null,
      summary: '',
      description: '',
      sections: [],
      url: null,
      source: 'none',
    };
  }
  post({ type: 'docs', reqId: msg.reqId, doc });
}

// Messages are handled one at a time, in order, after `init` has finished.
let chain: Promise<void> = Promise.resolve();
scope.onmessage = (ev) => {
  const msg = ev.data;
  chain = chain
    .then(() => {
      if (msg.type === 'init') return init(msg);
      if (msg.type === 'run') return run(msg);
      if (msg.type === 'docs') {
        lookupDocs(msg);
        return undefined;
      }
      writeFile(msg);
      return undefined;
    })
    .catch((e: unknown) => {
      // Surface as a worker `error` event so the client can report it.
      setTimeout(() => {
        throw e instanceof Error ? e : new Error(String(e));
      });
    });
};
