import { buildGraph, type EventLog, type GraphModel } from '@machines/log';
import { create } from 'zustand';
import { DEFAULT_RUN_CONFIG, STARTER_EXAMPLE } from './course';
import type { RuntimeState } from './runtime/client';
import { currentRuntime, getRuntime } from './runtime/instance';
import { progressText, versionsText } from './runtime/status';

/** CONTRACTS.md section 7. */
export interface AppState {
  runtime: { state: RuntimeState; progress: string; versions?: Record<string, string> };
  source: string;
  setSource(s: string): void;
  origin: 'starter' | 'autosave' | 'link' | 'edited';
  log: EventLog | null;
  model: GraphModel | null;
  running: boolean;
  elapsedMs: number;
  step: number;
  setStep(n: number): void;
  selection: { node?: string; edge?: string; pinned?: boolean };
  expanded: Set<string>;
  run(): Promise<void>;
  stop(): void;
  restart(): Promise<void>;
}

const ELAPSED_TICK_MS = 250;

export const useStore = create<AppState>()((set, get) => ({
  runtime: { state: 'loading', progress: 'Starting…' },
  source: STARTER_EXAMPLE,
  setSource: (source) => set({ source }),
  origin: 'starter',
  log: null,
  model: null,
  running: false,
  elapsedMs: 0,
  step: 0,
  setStep: (step) => set({ step: Math.max(0, step) }),
  selection: {},
  expanded: new Set(),
  run: async () => {
    const rt = currentRuntime();
    if (!rt || get().running || rt.state !== 'ready') return;
    const t0 = performance.now();
    set({ running: true, elapsedMs: 0 });
    const tick = setInterval(() => set({ elapsedMs: performance.now() - t0 }), ELAPSED_TICK_MS);
    // The model is rebuilt on every streamed update (at most once per animation frame).
    const show = (log: EventLog): void =>
      set({ log, model: buildGraph(log, { expanded: get().expanded }) });
    try {
      show(await rt.run(get().source, DEFAULT_RUN_CONFIG, show));
    } catch {
      // The runtime wasn't ready; nothing ran.
    } finally {
      clearInterval(tick);
      set({ running: false, elapsedMs: performance.now() - t0 });
    }
  },
  stop: () => currentRuntime()?.stop(),
  restart: async () => {
    try {
      await currentRuntime()?.restart();
    } catch {
      // The failure is shown in the status line by onError.
    }
  },
}));

/** Starts the worker (once) and mirrors its state into the store. Call from the app root. */
export function startRuntime(): void {
  const set = useStore.setState;
  const rt = getRuntime({
    onProgress: (p) => set((s) => ({ runtime: { ...s.runtime, progress: progressText(p) } })),
    onReady: (versions) =>
      set((s) => ({ runtime: { ...s.runtime, versions, progress: versionsText(versions) } })),
    onState: (state) =>
      set((s) => {
        const v = s.runtime.versions;
        const progress =
          state === 'running'
            ? 'Running…'
            : state === 'restarting'
              ? 'Restarting Python…'
              : state === 'ready' && v
                ? versionsText(v)
                : s.runtime.progress;
        return { runtime: { ...s.runtime, state, progress } };
      }),
    onError: (message) =>
      set((s) => ({
        runtime: { ...s.runtime, state: 'loading', progress: `Python failed to load: ${message}` },
      })),
  });
  set((s) => ({ runtime: { ...s.runtime, state: rt.state } }));
}
