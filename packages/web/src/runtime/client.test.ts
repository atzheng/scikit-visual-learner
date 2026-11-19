import type { FromWorker, RunConfig, Site, ToWorker } from '@machines/log';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_RUN_CONFIG } from '../course';
import {
  RuntimeClient,
  decodeCurrentCall,
  planStop,
  statusAfterDone,
  type WorkerLike,
} from './client';
import { elapsedLabel, progressText, versionsText } from './status';

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  sent: ToWorker[] = [];
  terminated = false;
  postMessage(msg: ToWorker): void {
    this.sent.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(msg: FromWorker): void {
    this.onmessage?.({ data: msg });
  }
  get init(): Extract<ToWorker, { type: 'init' }> {
    return this.sent.find((m) => m.type === 'init') as Extract<ToWorker, { type: 'init' }>;
  }
  get runs(): Extract<ToWorker, { type: 'run' }>[] {
    return this.sent.filter((m) => m.type === 'run') as Extract<ToWorker, { type: 'run' }>[];
  }
}

const site: Site = {
  id: 0,
  kind: 'call',
  line: 1,
  col: 0,
  end_line: 1,
  end_col: 5,
  text: 'f()',
  func_text: 'f',
  args: [],
};

interface Rig {
  client: RuntimeClient;
  workers: FakeWorker[];
  states: string[];
  frames: (() => void)[];
  errors: string[];
  readyCount: () => number;
}

function rig(opts: { isolated?: boolean } = {}): Rig {
  const workers: FakeWorker[] = [];
  const states: string[] = [];
  const frames: (() => void)[] = [];
  const errors: string[] = [];
  let ready = 0;
  const client = new RuntimeClient({
    workerUrl: new URL('http://localhost/worker.js'),
    onProgress: () => {},
    onReady: () => void ready++,
    onState: (s) => states.push(s),
    onError: (m) => errors.push(m),
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    schedule: (cb) => {
      frames.push(cb);
      return () => {
        const k = frames.indexOf(cb);
        if (k >= 0) frames.splice(k, 1);
      };
    },
    isolated: opts.isolated ?? true,
  });
  return { client, workers, states, frames, errors, readyCount: () => ready };
}

const cfg = (wall_ms = 30_000): RunConfig => ({ ...DEFAULT_RUN_CONFIG, wall_ms });
const last = <T>(xs: T[]): T => xs[xs.length - 1] as T;
const ready = (w: FakeWorker): void => w.emit({ type: 'ready', versions: { python: '3.14' } });
const batch = (runId: number, extra: Partial<Extract<FromWorker, { type: 'batch' }>> = {}) =>
  ({
    type: 'batch',
    runId,
    events: [],
    open: [],
    values: {},
    bindings: [],
    output: [],
    diagnostics: [],
    ...extra,
  }) satisfies FromWorker;

function startRun(r: Rig, wall = 30_000) {
  const w = last(r.workers);
  ready(w);
  const updates: unknown[] = [];
  const p = r.client.run('x = 1', cfg(wall), (l) => updates.push(l));
  const runId = last(w.runs).runId;
  w.emit({ type: 'started', runId, sites: [site] });
  return { w, p, runId, updates };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('state machine', () => {
  test('loading -> ready -> running -> ready', async () => {
    const r = rig();
    expect(r.client.state).toBe('loading');
    const { w, p, runId } = startRun(r);
    expect(r.client.state).toBe('running');
    w.emit({ type: 'done', runId, status: 'ok', error: null });
    const log = await p;
    expect(log.status).toBe('ok');
    expect(r.client.state).toBe('ready');
    expect(r.states).toEqual(['ready', 'running', 'ready']);
  });

  test('init carries SharedArrayBuffers only when isolated', () => {
    const a = rig({ isolated: true });
    expect(a.workers[0]?.init.interruptBuffer).toBeInstanceOf(SharedArrayBuffer);
    expect(a.workers[0]?.init.currentCall).toBeInstanceOf(SharedArrayBuffer);
    const b = rig({ isolated: false });
    expect(b.workers[0]?.init.interruptBuffer).toBeUndefined();
  });

  test('run before ready is rejected', async () => {
    const r = rig();
    await expect(r.client.run('x', cfg(), () => {})).rejects.toThrow(/loading/);
  });

  test('a second run is rejected while one is running', async () => {
    const r = rig();
    const { w, p, runId } = startRun(r);
    await expect(r.client.run('y', cfg(), () => {})).rejects.toThrow(/running/);
    w.emit({ type: 'done', runId, status: 'ok', error: null });
    await p;
  });

  test('run ids increase and messages for an old run are ignored', async () => {
    const r = rig();
    const first = startRun(r);
    first.w.emit({ type: 'done', runId: first.runId, status: 'ok', error: null });
    await first.p;
    const p2 = r.client.run('y', cfg(), () => {});
    const id2 = last(first.w.runs).runId;
    expect(id2).toBeGreaterThan(first.runId);
    // A late message from run 1, then run 2's own.
    first.w.emit({ type: 'done', runId: first.runId, status: 'error', error: null });
    expect(r.client.state).toBe('running');
    first.w.emit({ type: 'started', runId: id2, sites: [site] });
    first.w.emit({ type: 'done', runId: id2, status: 'ok', error: null });
    expect((await p2).status).toBe('ok');
  });
});

describe('streaming', () => {
  test('onUpdate is throttled to one call per frame, then the final log once', async () => {
    const r = rig();
    const { w, p, runId, updates } = startRun(r);
    w.emit(batch(runId, { output: [{ i: 0, stream: 'stdout', text: 'a' }] }));
    w.emit(batch(runId, { output: [{ i: 0, stream: 'stdout', text: 'b' }] }));
    expect(updates).toHaveLength(0);
    expect(r.frames).toHaveLength(1);
    r.frames.shift()?.();
    expect(updates).toHaveLength(1);
    w.emit(batch(runId));
    w.emit({ type: 'done', runId, status: 'ok', error: null });
    await p;
    expect(updates).toHaveLength(2); // the pending frame was cancelled; final log delivered
    expect(r.frames).toHaveLength(0);
  });
});

describe('stop', () => {
  test('isolated: sets the interrupt flag, and a prompt done keeps the worker', async () => {
    const r = rig();
    const { w, p, runId } = startRun(r);
    r.client.stop();
    const sab = w.init.interruptBuffer as SharedArrayBuffer;
    expect(Atomics.load(new Int32Array(sab), 0)).toBe(2);
    expect(w.terminated).toBe(false);
    vi.advanceTimersByTime(1500);
    w.emit({ type: 'done', runId, status: 'stopped', error: null });
    const log = await p;
    expect(log.status).toBe('stopped');
    vi.advanceTimersByTime(5000);
    expect(w.terminated).toBe(false);
    expect(r.workers).toHaveLength(1);
    expect(r.client.state).toBe('ready');
  });

  test('isolated: no done within 2 s terminates, restarts, and finishes as stopped', async () => {
    const r = rig();
    const { w, p } = startRun(r);
    r.client.stop();
    vi.advanceTimersByTime(1999);
    expect(w.terminated).toBe(false);
    vi.advanceTimersByTime(2);
    expect(w.terminated).toBe(true);
    const log = await p;
    expect(log.status).toBe('stopped');
    expect(r.workers).toHaveLength(2);
    expect(r.client.state).toBe('restarting');
    ready(r.workers[1] as FakeWorker);
    expect(r.client.state).toBe('ready');
  });

  test('kill names the running call from the currentCall buffer', async () => {
    const r = rig();
    const { w, p } = startRun(r);
    new Int32Array(w.init.currentCall as SharedArrayBuffer).set([1, 0]); // i = 0, site 0
    r.client.stop();
    vi.advanceTimersByTime(2001);
    const log = await p;
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({ i: 0, interrupted: true, name: 'f' });
  });

  test('not isolated: terminates at once', async () => {
    const r = rig({ isolated: false });
    const { w, p } = startRun(r);
    r.client.stop();
    expect(w.terminated).toBe(true);
    expect((await p).status).toBe('stopped');
    expect(r.workers).toHaveLength(2);
  });

  test('stop with no run does nothing', () => {
    const r = rig();
    ready(r.workers[0] as FakeWorker);
    r.client.stop();
    expect(r.workers[0]?.terminated).toBe(false);
  });

  test('a done that arrives after the stop request but is not "stopped" keeps its status', async () => {
    const r = rig();
    const { w, p, runId } = startRun(r);
    r.client.stop();
    w.emit({ type: 'done', runId, status: 'ok', error: null });
    expect((await p).status).toBe('ok');
  });
});

describe('timeout', () => {
  test('wall clock starts at `started` and interrupts, finishing as timeout', async () => {
    const r = rig();
    const { w, p, runId } = startRun(r, 1000);
    vi.advanceTimersByTime(999);
    expect(Atomics.load(new Int32Array(w.init.interruptBuffer as SharedArrayBuffer), 0)).toBe(0);
    vi.advanceTimersByTime(2);
    expect(Atomics.load(new Int32Array(w.init.interruptBuffer as SharedArrayBuffer), 0)).toBe(2);
    w.emit({ type: 'done', runId, status: 'stopped', error: null });
    expect((await p).status).toBe('timeout');
  });

  test('a worker that ignores the interrupt is terminated 2 s later, as timeout', async () => {
    const r = rig();
    const { w, p } = startRun(r, 1000);
    vi.advanceTimersByTime(1001 + 2001);
    expect(w.terminated).toBe(true);
    expect((await p).status).toBe('timeout');
    expect(r.workers).toHaveLength(2);
  });

  test('a run that finishes in time never times out', async () => {
    const r = rig();
    const { w, p, runId } = startRun(r, 1000);
    w.emit({ type: 'done', runId, status: 'ok', error: null });
    await p;
    vi.advanceTimersByTime(10_000);
    expect(w.terminated).toBe(false);
  });

  test('a run that never reaches `started` is bounded by the start grace', async () => {
    const r = rig();
    const w = r.workers[0] as FakeWorker;
    ready(w);
    const p = r.client.run('x', cfg(1000), () => {});
    vi.advanceTimersByTime(1000 + 15_000 + 2001 + 1);
    expect(w.terminated).toBe(true);
    expect((await p).status).toBe('timeout');
  });
});

describe('restart and crashes', () => {
  test('restart terminates, spawns and resolves on ready', async () => {
    const r = rig();
    ready(r.workers[0] as FakeWorker);
    const p = r.client.restart();
    expect(r.workers[0]?.terminated).toBe(true);
    expect(r.client.state).toBe('restarting');
    ready(r.workers[1] as FakeWorker);
    await p;
    expect(r.client.state).toBe('ready');
    expect(r.readyCount()).toBe(2);
  });

  test('restart during a run finishes the run as stopped', async () => {
    const r = rig();
    const { p } = startRun(r);
    const rp = r.client.restart();
    expect((await p).status).toBe('stopped');
    ready(r.workers[1] as FakeWorker);
    await rp;
  });

  test('messages from the old worker after a restart are ignored', () => {
    const r = rig();
    ready(r.workers[0] as FakeWorker);
    void r.client.restart();
    ready(r.workers[0] as FakeWorker);
    expect(r.client.state).toBe('restarting');
  });

  test('a crash mid-run finishes with status error and respawns', async () => {
    const r = rig();
    const { w, p } = startRun(r);
    w.onerror?.({ message: 'boom' });
    const log = await p;
    expect(log.status).toBe('error');
    expect(log.error?.message).toBe('boom');
    expect(r.workers).toHaveLength(2);
    expect(r.client.state).toBe('restarting');
  });

  test('a crash while loading reports the error and does not loop; restart retries', async () => {
    const r = rig();
    (r.workers[0] as FakeWorker).onerror?.({ message: 'no wasm' });
    expect(r.errors).toEqual(['no wasm']);
    expect(r.workers).toHaveLength(1);
    expect(r.client.state).toBe('loading');
    const p = r.client.restart();
    expect(r.workers).toHaveLength(2);
    ready(r.workers[1] as FakeWorker);
    await p;
    expect(r.client.state).toBe('ready');
  });
});

describe('writeFile', () => {
  test('resolves with the row count from fileWritten', async () => {
    const r = rig();
    const w = r.workers[0] as FakeWorker;
    ready(w);
    const p = r.client.writeFile('a.csv', new ArrayBuffer(4));
    expect(last(w.sent)).toMatchObject({ type: 'file', name: 'a.csv' });
    w.emit({ type: 'fileWritten', name: 'a.csv', rows: 3 });
    await expect(p).resolves.toEqual({ rows: 3 });
  });

  test('rejects when the worker is restarted first', async () => {
    const r = rig();
    ready(r.workers[0] as FakeWorker);
    const p = r.client.writeFile('a.csv', new ArrayBuffer(4));
    void r.client.restart();
    await expect(p).rejects.toThrow(/restarted/);
  });
});

describe('pure helpers', () => {
  test('planStop', () => {
    expect(planStop(true)).toBe('interrupt');
    expect(planStop(false)).toBe('terminate');
  });
  test('statusAfterDone only replaces stopped', () => {
    expect(statusAfterDone('stopped', 'timeout')).toBe('timeout');
    expect(statusAfterDone('stopped', 'stopped')).toBe('stopped');
    expect(statusAfterDone('ok', 'timeout')).toBeUndefined();
    expect(statusAfterDone('stopped', undefined)).toBeUndefined();
  });
  test('decodeCurrentCall', () => {
    expect(decodeCurrentCall(undefined)).toBeNull();
    expect(decodeCurrentCall(new Int32Array([0, 5]))).toBeNull();
    expect(decodeCurrentCall(new Int32Array([4, 2]))).toEqual({ i: 3, site: 2 });
  });
  test('status text', () => {
    expect(progressText({ type: 'progress', phase: 'packages', done: 2, total: 5 })).toContain(
      '(2/5)',
    );
    expect(versionsText({ python: '3.14.0', numpy: '2.0', pandas: '3.0', sklearn: '1.8' })).toBe(
      'Python 3.14.0 · numpy 2.0 · pandas 3.0 · scikit-learn 1.8',
    );
    expect(elapsedLabel(1999)).toBeNull();
    expect(elapsedLabel(3400)).toBe('3 s');
  });
});
