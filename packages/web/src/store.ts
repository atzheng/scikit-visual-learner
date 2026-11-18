import { create } from 'zustand';
import { STARTER_EXAMPLE } from './course';

// TODO(svl-q3a.1, svl-bwv.2): replace with `import type { EventLog, GraphModel } from '@machines/log'`
// and `RuntimeClient['state']` once those exist. Opaque until then.
type EventLog = unknown;
type GraphModel = unknown;
type RuntimeState = 'loading' | 'ready' | 'running' | 'restarting';

/** CONTRACTS.md section 7. */
export interface AppState {
  runtime: { state: RuntimeState; progress: string; versions?: Record<string, string> };
  source: string;
  setSource(s: string): void;
  origin: 'starter' | 'autosave' | 'link';
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
}

export const useStore = create<AppState>()((set) => ({
  runtime: { state: 'loading', progress: 'Runtime not connected yet' },
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
  // Stubs: svl-bwv.2 wires these to the RuntimeClient.
  run: async () => {},
  stop: () => {},
}));
