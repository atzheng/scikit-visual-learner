import type { EventLog } from '@machines/log';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let runImpl: (source: string, cfg: unknown, onUpdate: (log: EventLog) => void) => Promise<unknown>;
vi.mock('./runtime/instance', () => ({
  currentRuntime: () => ({
    state: 'ready',
    run: (...a: Parameters<typeof runImpl>) => runImpl(...a),
  }),
  getRuntime: () => null,
}));

const { useStore } = await import('./store');

const oldLog = {
  version: 2,
  status: 'ok',
  error: null,
  sites: [{ id: 0, kind: 'call', line: 1, col: 0, end_line: 1, end_col: 3, text: 'f()' }],
  scopes: [],
  values: {},
  events: [],
  output: [],
  diagnostics: [],
} as unknown as EventLog;

beforeEach(() => {
  useStore.setState({
    source: 'new source',
    log: oldLog,
    model: { nodes: [], edges: [], steps: [0, 1] },
    step: 2,
    selection: { node: 'x', pinned: true },
    running: false,
    runSeq: 0,
    runSource: 'old source',
  });
});

describe('run() and the previous run', () => {
  test('before the first update nothing of the old run remains next to the new runSource', async () => {
    let seen: ReturnType<typeof useStore.getState> | null = null;
    let release!: () => void;
    runImpl = () =>
      new Promise((res) => {
        seen = useStore.getState();
        release = () => res(undefined);
      });
    const p = useStore.getState().run();
    expect(seen).not.toBeNull();
    const s = useStore.getState();
    expect(s.runSource).toBe('new source');
    expect(s.log).toBeNull();
    expect(s.model).toBeNull();
    expect(s.selection).toEqual({});
    expect(s.step).toBe(0);
    expect(s.runSeq).toBe(1);
    release();
    await p;
  });

  test('a crash before any batch leaves no log', async () => {
    runImpl = () => Promise.reject(new Error('worker died'));
    await useStore.getState().run();
    const s = useStore.getState();
    expect(s.running).toBe(false);
    expect(s.log).toBeNull();
    expect(s.runSource).toBe('new source');
  });

  test('the first update puts the slider at the end', async () => {
    runImpl = async (_s, _c, onUpdate) => {
      onUpdate(oldLog);
    };
    await useStore.getState().run();
    const s = useStore.getState();
    expect(s.log).toBe(oldLog);
    expect(s.step).toBe(s.model!.steps.length);
  });
});
