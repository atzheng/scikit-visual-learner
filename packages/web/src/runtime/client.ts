/** Main-thread side of the Python worker (CONTRACTS.md section 7). Pure TS: the worker is injectable for tests. */
import {
  createAssembler,
  type Assembler,
  type CurrentCall,
  type Doc,
  type DocTarget,
  type EventLog,
  type FromWorker,
  type RunConfig,
  type RunStatus,
  type ToWorker,
} from '@machines/log';

export type RuntimeState = 'loading' | 'ready' | 'running' | 'restarting';
export type ProgressMessage = Extract<FromWorker, { type: 'progress' }>;

/** The slice of `Worker` the client uses. */
export interface WorkerLike {
  postMessage(msg: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: FromWorker }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
}

export interface RuntimeClientOptions {
  /** Only used by the default `createWorker`; the page passes its own (Vite needs the literal `new Worker(new URL(...))`). */
  workerUrl?: URL;
  onProgress(p: ProgressMessage): void;
  onReady(versions: Record<string, string>): void;
  onState?(state: RuntimeState): void;
  /** `load`: the worker failed while loading (the client stays in `loading`; `restart()` tries again). `crash`: it died later and is being replaced. */
  onError?(message: string, kind: 'load' | 'crash'): void;
  /** Test seams. */
  createWorker?(url: URL): WorkerLike;
  isolated?: boolean;
  /** Schedules the throttled `onUpdate` calls (default: requestAnimationFrame). Returns a canceller. */
  schedule?(cb: () => void): () => void;
  stopGraceMs?: number;
  /** Extra time allowed for the worker to reach `started` (imports load before it) ahead of the wall clock. */
  startGraceMs?: number;
}

export const STOP_GRACE_MS = 2000;
export const START_GRACE_MS = 15_000;

export type StopPlan = 'interrupt' | 'terminate';
/** What `stop()` and the wall clock do first: interrupt when the page is isolated, else kill the worker. */
export function planStop(isolated: boolean): StopPlan {
  return isolated ? 'interrupt' : 'terminate';
}

/** Status override for the final log when `done` arrives while a stop is pending: only a `stopped` done is replaced. */
export function statusAfterDone(
  done: RunStatus,
  reason: 'stopped' | 'timeout' | undefined,
): RunStatus | undefined {
  return reason !== undefined && done === 'stopped' ? reason : undefined;
}

export function decodeCurrentCall(buf: Int32Array | undefined): CurrentCall | null {
  if (!buf) return null;
  const n = Atomics.load(buf, 0);
  return n === 0 ? null : { i: n - 1, site: Atomics.load(buf, 1) };
}

interface ActiveRun {
  runId: number;
  asm: Assembler;
  config: RunConfig;
  onUpdate(log: EventLog): void;
  resolve(log: EventLog): void;
  /** The worker has sent `started`: only then is it safe to raise KeyboardInterrupt (before, Pyodide may be installing packages). */
  started?: boolean;
  reason?: 'stopped' | 'timeout';
  wallTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  cancelFrame?: () => void;
}

interface Waiter {
  resolve(v: { rows?: number }): void;
  reject(e: Error): void;
}

/** Cache key for a docs target. The program text only matters for student definitions. */
export function docKey(t: DocTarget): string {
  const student = t.module === '__main__' || t.module === '<student>';
  return `${t.module ?? ''}\0${t.name}${student ? `\0${t.source ?? ''}` : ''}`;
}

const defaultSchedule = (cb: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const h = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(h);
  }
  const h = setTimeout(cb, 16);
  return () => clearTimeout(h);
};

function defaultCreateWorker(url: URL): WorkerLike {
  return new Worker(url, { type: 'module' }) as unknown as WorkerLike;
}

export class RuntimeClient {
  state: RuntimeState = 'loading';
  private readonly opts: RuntimeClientOptions;
  private readonly isolated: boolean;
  private worker!: WorkerLike;
  private interrupt?: Int32Array;
  private currentCall?: Int32Array;
  private nextRunId = 1;
  private active: ActiveRun | null = null;
  private readyWaiters: Waiter[] = [];
  private fileWaiters = new Map<string, Waiter[]>();
  private nextDocId = 1;
  private docWaiters = new Map<number, { resolve(d: Doc): void; reject(e: Error): void }>();
  /** Docs by target; in-flight requests are shared. Failures are dropped so the next ask retries. */
  private docCache = new Map<string, Promise<Doc>>();

  constructor(opts: RuntimeClientOptions) {
    this.opts = opts;
    this.isolated =
      opts.isolated ??
      (typeof crossOriginIsolated !== 'undefined' &&
        crossOriginIsolated &&
        typeof SharedArrayBuffer !== 'undefined');
    this.spawn();
  }

  /**
   * Runs `source`. `onUpdate` gets a snapshot at most once per animation frame while it streams, and the final
   * log once at the end. The promise resolves with the final log for every outcome (stopped, timeout, a crash).
   */
  run(source: string, config: RunConfig, onUpdate: (log: EventLog) => void): Promise<EventLog> {
    if (this.state !== 'ready') return Promise.reject(new Error(`runtime is ${this.state}`));
    const runId = this.nextRunId++;
    return new Promise<EventLog>((resolve) => {
      const a: ActiveRun = { runId, asm: createAssembler(runId), config, onUpdate, resolve };
      this.active = a;
      this.setState('running');
      // Until `started`, the worker may be loading imports (matplotlib, say); that time is not the student's.
      a.wallTimer = setTimeout(
        () => this.requestStop(a, 'timeout'),
        config.wall_ms + (this.opts.startGraceMs ?? START_GRACE_MS),
      );
      this.worker.postMessage({ type: 'run', runId, source, config });
    });
  }

  /** Interrupt the run; terminate and restart the worker if `done` doesn't follow within 2 s, or when not isolated. */
  stop(): void {
    if (this.active) this.requestStop(this.active, 'stopped');
  }

  writeFile(name: string, bytes: ArrayBuffer): Promise<{ rows?: number }> {
    return new Promise((resolve, reject) => {
      const list = this.fileWaiters.get(name) ?? [];
      list.push({ resolve, reject });
      this.fileWaiters.set(name, list);
      this.worker.postMessage({ type: 'file', name, bytes }, [bytes]);
    });
  }

  /**
   * Official documentation for a function, class or method. The worker answers between runs (a request made
   * during a run waits for it) and the answer is cached per target. Rejects if the worker restarts first.
   */
  docs(target: DocTarget): Promise<Doc> {
    const key = docKey(target);
    const hit = this.docCache.get(key);
    if (hit) return hit;
    const reqId = this.nextDocId++;
    const p = new Promise<Doc>((resolve, reject) => {
      this.docWaiters.set(reqId, { resolve, reject });
      this.worker.postMessage({ type: 'docs', reqId, target });
    });
    this.docCache.set(key, p);
    p.catch(() => {
      if (this.docCache.get(key) === p) this.docCache.delete(key);
    });
    return p;
  }

  /** "Restart Python": a new worker; resolves when it is ready. Also the retry after a failed load. */
  restart(): Promise<void> {
    const p = new Promise<void>((resolve, reject) =>
      this.readyWaiters.push({ resolve: () => resolve(), reject }),
    );
    this.killWorker('stopped');
    return p;
  }

  // -- internals ------------------------------------------------------------------------------

  private setState(s: RuntimeState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
  }

  private spawn(): void {
    if (this.isolated) {
      this.interrupt = new Int32Array(new SharedArrayBuffer(4));
      this.currentCall = new Int32Array(new SharedArrayBuffer(8));
    } else {
      this.interrupt = this.currentCall = undefined;
    }
    const w = (this.opts.createWorker ?? defaultCreateWorker)(this.opts.workerUrl as URL);
    this.worker = w;
    w.onmessage = (ev) => {
      if (this.worker === w) this.onMessage(ev.data);
    };
    w.onerror = (ev) => {
      if (this.worker === w) this.onCrash(ev.message ?? 'The Python worker failed');
    };
    const init: ToWorker = { type: 'init' };
    if (this.interrupt && this.currentCall) {
      init.interruptBuffer = this.interrupt.buffer as SharedArrayBuffer;
      init.currentCall = this.currentCall.buffer as SharedArrayBuffer;
    }
    w.postMessage(init);
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'progress':
        this.opts.onProgress(msg);
        return;
      case 'ready':
        this.setState('ready');
        this.opts.onReady(msg.versions);
        for (const w of this.readyWaiters.splice(0)) w.resolve({});
        return;
      case 'fileWritten': {
        const w = this.fileWaiters.get(msg.name)?.shift();
        w?.resolve(msg.rows === undefined ? {} : { rows: msg.rows });
        return;
      }
      case 'docs': {
        const w = this.docWaiters.get(msg.reqId);
        this.docWaiters.delete(msg.reqId);
        w?.resolve(msg.doc);
        return;
      }
      default:
        this.onRunMessage(msg);
    }
  }

  private onRunMessage(msg: FromWorker): void {
    const a = this.active;
    if (!a || !('runId' in msg) || msg.runId !== a.runId) return; // stale run
    a.asm.push(msg);
    if (msg.type === 'started') {
      // The wall clock starts when the student's code does.
      a.started = true;
      clearTimeout(a.wallTimer);
      if (a.reason) {
        this.interruptNow(); // a stop requested before `started` is applied now; its 2 s timer is already running
      } else {
        a.wallTimer = setTimeout(() => this.requestStop(a, 'timeout'), a.config.wall_ms);
      }
      this.scheduleUpdate(a);
    } else if (msg.type === 'batch') {
      this.scheduleUpdate(a);
    } else if (msg.type === 'done') {
      this.finishRun(a, a.asm.finish(statusAfterDone(msg.status, a.reason)));
      this.setState('ready');
    }
  }

  private scheduleUpdate(a: ActiveRun): void {
    if (a.cancelFrame) return;
    a.cancelFrame = (this.opts.schedule ?? defaultSchedule)(() => {
      a.cancelFrame = undefined;
      if (this.active === a) a.onUpdate(a.asm.snapshot());
    });
  }

  private finishRun(a: ActiveRun, log: EventLog): void {
    clearTimeout(a.wallTimer);
    clearTimeout(a.killTimer);
    a.cancelFrame?.();
    a.cancelFrame = undefined;
    if (this.active === a) this.active = null;
    a.onUpdate(log);
    a.resolve(log);
  }

  private requestStop(a: ActiveRun, reason: 'stopped' | 'timeout'): void {
    if (this.active !== a || a.reason) return;
    a.reason = reason;
    clearTimeout(a.wallTimer);
    if (planStop(this.isolated) === 'terminate' || !this.interrupt) {
      this.killWorker(reason);
      return;
    }
    // The interrupt is held until `started`: raised earlier it can land inside Pyodide's package
    // installer and leave the worker unusable. The terminate timer runs from the request either way.
    if (a.started) this.interruptNow();
    a.killTimer = setTimeout(
      () => this.active === a && this.killWorker(reason),
      this.opts.stopGraceMs ?? STOP_GRACE_MS,
    );
  }

  private interruptNow(): void {
    if (this.interrupt) Atomics.store(this.interrupt, 0, 2); // SIGINT: KeyboardInterrupt in the student's code
  }

  /** Terminate the worker, finish any run from what has streamed so far, and start a new worker. */
  private killWorker(reason: 'stopped' | 'timeout'): void {
    const a = this.active;
    const cc = decodeCurrentCall(this.currentCall);
    this.worker.terminate();
    if (a) this.finishRun(a, a.asm.finish(a.reason ?? reason, cc));
    this.rejectFiles('Python was restarted');
    this.setState('restarting');
    this.spawn();
  }

  private onCrash(message: string): void {
    const a = this.active;
    message = message.replace(/^Uncaught (?:\w+: )?/, ''); // the browser's ErrorEvent prefix
    this.worker.terminate();
    this.rejectFiles(message);
    if (a) {
      const log = a.asm.finish('error');
      this.finishRun(a, {
        ...log,
        error: { type: 'WorkerError', message, line: null, traceback: [] },
      });
    }
    if (this.state === 'loading' || this.state === 'restarting') {
      // Failed while loading: don't loop. `restart()` tries again.
      this.setState('loading');
      this.opts.onError?.(message, 'load');
      for (const w of this.readyWaiters.splice(0)) w.reject(new Error(message));
      return;
    }
    this.opts.onError?.(message, 'crash'); // idle or mid-run: tell the user, then recover
    this.setState('restarting');
    this.spawn();
  }

  private rejectFiles(message: string): void {
    for (const w of this.docWaiters.values()) w.reject(new Error(message));
    this.docWaiters.clear();
    for (const list of this.fileWaiters.values())
      for (const w of list) w.reject(new Error(message));
    this.fileWaiters.clear();
  }
}
