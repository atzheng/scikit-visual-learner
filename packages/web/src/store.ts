import { buildGraph, type EventLog, type GraphModel } from '@machines/log';
import { create } from 'zustand';
import { DEFAULT_RUN_CONFIG, STARTER_EXAMPLE } from './course';
import type { RuntimeState } from './runtime/client';
import { currentRuntime, getRuntime } from './runtime/instance';
import { clampStep, nextStep, stepForNode } from './timeline/steps';
import { readView, writeView, type DiagramView } from './diagram/view';
import { progressText, versionsText } from './runtime/status';

/** CONTRACTS.md section 7. */
export interface AppState {
  runtime: {
    state: RuntimeState;
    progress: string;
    versions?: Record<string, string>;
    /** True when loading Python failed (the state stays 'loading'). */
    failed?: boolean;
  };
  source: string;
  setSource(s: string): void;
  origin: 'starter' | 'autosave' | 'link' | 'edited';
  log: EventLog | null;
  model: GraphModel | null;
  running: boolean;
  elapsedMs: number;
  step: number;
  /** `single`: a one-step move (the step buttons, ←/→) that the two-pane view may animate; everything else snaps. */
  setStep(n: number, single?: boolean): void;
  stepSingle: boolean;
  /** Which diagram view is shown: the two-pane shelf and stage (default) or the full diagram. Persisted per viewer. */
  view: DiagramView;
  setView(v: DiagramView): void;
  /** Incremented at each Run (not the worker's runId); lets the diagram reset per-run layout state. */
  runSeq: number;
  /** The source text of the last run (the log's site positions refer to it). */
  runSource: string | null;
  selection: { node?: string; edge?: string; pinned?: boolean };
  /** A click on a box: select it and move the step to its latest execution. */
  selectNode(id: string | null): void;
  expanded: Set<string>;
  /** Draw every object as a box: no unnamed temporary is folded into a chip on its wire. */
  showAllObjects: boolean;
  setShowAllObjects(on: boolean): void;
  /** Ids (`GEdge.chip.node`) of folded temporaries the student expanded to boxes. */
  unfolded: ReadonlySet<string>;
  /** Expands one chip to its box, selects the box. */
  unfold(id: string): void;
  run(): Promise<void>;
  stop(): void;
  restart(): Promise<void>;
}

const ELAPSED_TICK_MS = 250;

/** The graph of a log under the student's folding choices. */
function graphFor(log: EventLog): GraphModel {
  const s = useStore.getState();
  return buildGraph(log, { expanded: s.expanded, fold: !s.showAllObjects, unfold: s.unfolded });
}

/** The folding choices changed: build the same log's graph again (the steps do not change). */
function rebuild(): void {
  const { log } = useStore.getState();
  if (!log) return;
  useStore.setState({ model: graphFor(log) });
}

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
  setStep: (step, single = false) =>
    set((s) => {
      const n = clampStep(step, s.model?.steps.length ?? Infinity);
      return { step: n, stepSingle: single && Math.abs(n - s.step) === 1 };
    }),
  stepSingle: false,
  view: readView(),
  setView: (view) => {
    writeView(view);
    set({ view });
  },
  runSeq: 0,
  runSource: null,
  selection: {},
  selectNode: (id) => {
    const { model, step } = get();
    if (id === null || !model) return set({ selection: {} });
    const target = stepForNode(model, id, step);
    set({
      stepSingle: false,
      selection: { node: id, pinned: true },
      ...(target !== null && { step: target }),
    });
  },
  expanded: new Set(),
  showAllObjects: false,
  setShowAllObjects: (on) => {
    set({ showAllObjects: on, unfolded: new Set() });
    rebuild();
  },
  unfolded: new Set(),
  unfold: (id) => {
    set((s) => ({ unfolded: new Set([...s.unfolded, id]), selection: { node: id, pinned: true } }));
    rebuild();
  },
  run: async () => {
    const rt = currentRuntime();
    if (!rt || get().running || rt.state !== 'ready') return;
    const t0 = performance.now();
    set((s) => ({
      running: true,
      elapsedMs: 0,
      runSeq: s.runSeq + 1,
      unfolded: new Set(),
      runSource: s.source,
      // Nothing of the previous run may be linked against the new source text.
      log: null,
      model: null,
      step: 0,
      stepSingle: false,
      selection: {},
    }));
    const tick = setInterval(() => set({ elapsedMs: performance.now() - t0 }), ELAPSED_TICK_MS);
    // The model is rebuilt on every streamed update (at most once per animation frame) and once
    // for the final log, which `run` delivers through `onUpdate` before it resolves.
    // Note for bwv.4: `snapshot()` is O(n) per update; fine at 5000 events, not measured beyond.
    // The slider starts at step 1 and stays at the student's step (nextStep); it never follows the stream.
    const show = (log: EventLog): void => {
      const model = graphFor(log);
      const prev = get();
      const step = nextStep(prev.step, prev.model?.steps.length ?? 0, model.steps.length);
      set({ log, model, step, stepSingle: false });
    };
    try {
      await rt.run(get().source, DEFAULT_RUN_CONFIG, show);
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
  let crashNote: string | null = null; // shown while the replacement worker loads
  const rt = getRuntime({
    onProgress: (p) =>
      set((s) => ({ runtime: { ...s.runtime, failed: false, progress: progressText(p) } })),
    onReady: (versions) =>
      set((s) => ({ runtime: { ...s.runtime, versions, progress: versionsText(versions) } })),
    onState: (state) =>
      set((s) => {
        const v = s.runtime.versions;
        const progress =
          state === 'running'
            ? 'Running…'
            : state === 'restarting'
              ? crashNote
                ? `Python crashed (${crashNote}). Restarting…`
                : 'Restarting Python…'
              : state === 'ready' && v
                ? versionsText(v)
                : s.runtime.progress;
        if (state === 'ready') crashNote = null;
        return { runtime: { ...s.runtime, state, progress, failed: false } };
      }),
    onError: (message, kind) => {
      if (kind === 'crash') {
        crashNote = message.length > 140 ? `${message.slice(0, 139)}…` : message;
        return; // the following 'restarting' state carries the note
      }
      set((s) => ({
        runtime: {
          ...s.runtime,
          state: 'loading',
          failed: true,
          progress: `Python failed to load: ${message}`,
        },
      }));
    },
  });
  set((s) => ({ runtime: { ...s.runtime, state: rt.state } }));
}
