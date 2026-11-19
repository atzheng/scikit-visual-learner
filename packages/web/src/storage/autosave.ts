/**
 * Autosave of the editor source to localStorage (SPEC "User experience" 1). Pure policy plus a
 * debounced saver with injected timers; the wiring to the store is in storage/persist.ts.
 * Storage can be missing or throw (private windows, blocked site data): every access is guarded.
 */

import { fragmentPayload } from '../share/link';

export const AUTOSAVE_KEY = 'machines.source.v1';
export const AUTOSAVE_DELAY_MS = 600;

export type Origin = 'starter' | 'autosave' | 'link' | 'edited';

/** The part of Storage that autosave uses. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage, or null when the browser denies access to it. */
export function getLocalStorage(): KV | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readAutosave(kv: KV | null): string | null {
  if (!kv) return null;
  try {
    const v = kv.getItem(AUTOSAVE_KEY);
    return v !== null && v.trim() !== '' ? v : null;
  } catch {
    return null;
  }
}

export function writeAutosave(kv: KV | null, source: string): boolean {
  if (!kv) return false;
  try {
    kv.setItem(AUTOSAVE_KEY, source);
    return true;
  } catch {
    return false; // quota or blocked: the page works without autosave
  }
}

export function clearAutosave(kv: KV | null): void {
  try {
    kv?.removeItem(AUTOSAVE_KEY);
  } catch {
    // nothing to do
  }
}

/**
 * What to do with the current editor state. Code that arrived by link is never saved (it would
 * replace the reader's own code); the starter text is not saved either, and returning to it
 * clears the old autosave so it does not come back at the next load.
 */
export function autosaveAction(s: {
  origin: Origin;
  source: string;
  starter: string;
}): 'save' | 'clear' | 'skip' {
  if (s.origin === 'link') return 'skip';
  return s.source === s.starter ? 'clear' : 'save';
}

/** Load precedence: link code > autosave > starter example. */
export function chooseInitial(s: { hash: string; autosave: string | null; starter: string }): {
  source: string;
  origin: Origin;
} {
  // A link is opened later by the share loader; until then the page shows the starter.
  if (fragmentPayload(s.hash) !== null) return { source: s.starter, origin: 'starter' };
  if (s.autosave !== null) return { source: s.autosave, origin: 'autosave' };
  return { source: s.starter, origin: 'starter' };
}

export interface Autosaver {
  /** Call on every change; the save happens after the delay without further changes. */
  schedule(): void;
  /** Save now if a save is pending (page hide). */
  flush(): void;
}

export function createAutosaver(opts: {
  kv: KV | null;
  state(): { origin: Origin; source: string };
  starter: string;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): Autosaver {
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  const apply = (): void => {
    timer = null;
    const s = opts.state();
    const a = autosaveAction({ ...s, starter: opts.starter });
    if (a === 'save') writeAutosave(opts.kv, s.source);
    else if (a === 'clear') clearAutosave(opts.kv);
  };
  return {
    schedule() {
      if (timer !== null) clearT(timer);
      timer = setT(apply, opts.delayMs ?? AUTOSAVE_DELAY_MS);
    },
    flush() {
      if (timer === null) return;
      clearT(timer);
      apply();
    },
  };
}
