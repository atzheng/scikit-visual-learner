import { describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_KEY,
  autosaveAction,
  chooseInitial,
  createAutosaver,
  getLocalStorage,
  readAutosave,
  writeAutosave,
  type KV,
} from './autosave';

function memory(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwing: KV = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('chooseInitial: link > autosave > starter', () => {
  const starter = 'STARTER';
  it('uses the starter on a fresh profile', () => {
    expect(chooseInitial({ hash: '', autosave: null, starter })).toEqual({
      source: starter,
      origin: 'starter',
    });
  });
  it('restores the autosave', () => {
    expect(chooseInitial({ hash: '', autosave: 'mine', starter })).toEqual({
      source: 'mine',
      origin: 'autosave',
    });
  });
  it('leaves a share link to the link loader, ignoring the autosave', () => {
    expect(chooseInitial({ hash: '#c=abc', autosave: 'mine', starter })).toEqual({
      source: starter,
      origin: 'starter',
    });
  });
  it('ignores hashes that are not share links', () => {
    expect(chooseInitial({ hash: '#section', autosave: 'mine', starter }).source).toBe('mine');
  });
});

describe('storage that fails', () => {
  it('reads and writes without throwing', () => {
    expect(readAutosave(throwing)).toBeNull();
    expect(writeAutosave(throwing, 'x')).toBe(false);
    expect(readAutosave(null)).toBeNull();
    expect(writeAutosave(null, 'x')).toBe(false);
  });
  it('treats a blank autosave as none', () => {
    const kv = memory();
    kv.setItem(AUTOSAVE_KEY, '  \n');
    expect(readAutosave(kv)).toBeNull();
  });
  it('getLocalStorage is null when access throws', () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(getLocalStorage()).toBeNull();
    } finally {
      if (orig) Object.defineProperty(globalThis, 'localStorage', orig);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('autosaveAction', () => {
  it('never saves link code', () => {
    expect(autosaveAction({ origin: 'link', source: 'x', starter: 's' })).toBe('skip');
  });
  it('saves edits, clears when back at the starter', () => {
    expect(autosaveAction({ origin: 'edited', source: 'x', starter: 's' })).toBe('save');
    expect(autosaveAction({ origin: 'starter', source: 'x', starter: 's' })).toBe('save');
    expect(autosaveAction({ origin: 'autosave', source: 's', starter: 's' })).toBe('clear');
  });
});

describe('createAutosaver', () => {
  it('debounces: only the last state is written', () => {
    vi.useFakeTimers();
    try {
      const kv = memory();
      const st = { origin: 'edited' as const, source: 'a' };
      const saver = createAutosaver({ kv, state: () => st, starter: 's', delayMs: 100 });
      saver.schedule();
      st.source = 'ab';
      vi.advanceTimersByTime(50);
      saver.schedule();
      st.source = 'abc';
      vi.advanceTimersByTime(99);
      expect(kv.data.size).toBe(0);
      vi.advanceTimersByTime(1);
      expect(kv.getItem(AUTOSAVE_KEY)).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });
  it('checks the origin when the timer fires, and flush saves a pending change', () => {
    vi.useFakeTimers();
    try {
      const kv = memory();
      kv.setItem(AUTOSAVE_KEY, 'mine');
      const st: { origin: 'link' | 'edited'; source: string } = {
        origin: 'link',
        source: 'link code',
      };
      const saver = createAutosaver({ kv, state: () => st, starter: 's', delayMs: 100 });
      saver.schedule();
      vi.advanceTimersByTime(100);
      expect(kv.getItem(AUTOSAVE_KEY)).toBe('mine'); // link code did not overwrite it
      st.origin = 'edited';
      st.source = 'changed';
      saver.schedule();
      saver.flush();
      expect(kv.getItem(AUTOSAVE_KEY)).toBe('changed');
      vi.advanceTimersByTime(500); // nothing pending any more
      saver.flush();
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not throw when storage is blocked', () => {
    const saver = createAutosaver({
      kv: throwing,
      state: () => ({ origin: 'edited', source: 'x' }),
      starter: 's',
    });
    saver.schedule();
    expect(() => saver.flush()).not.toThrow();
  });
});
