import { describe, expect, it } from 'vitest';
import { hasUnsavedWork, nextOrigin } from './origin';

describe('nextOrigin', () => {
  const base = { source: 'a', linkSource: 'a', running: false };
  it('stays link while untouched', () => {
    expect(nextOrigin('link', base)).toBe('link');
  });
  it('becomes edited on the first change', () => {
    expect(nextOrigin('link', { ...base, source: 'ab' })).toBe('edited');
  });
  it('becomes edited on the first run', () => {
    expect(nextOrigin('link', { ...base, running: true })).toBe('edited');
  });
  it('stays edited when the text is typed back to the original', () => {
    expect(nextOrigin('edited', base)).toBe('edited');
  });
  it('leaves other origins alone', () => {
    expect(nextOrigin('starter', { ...base, source: 'zz', running: true })).toBe('starter');
    expect(nextOrigin('autosave', { ...base, source: 'zz' })).toBe('autosave');
  });
});

describe('hasUnsavedWork', () => {
  const s = { origin: 'starter' as const, running: false, source: 'a', baseline: 'a' };
  it('is false for an untouched editor or untouched link code', () => {
    expect(hasUnsavedWork(s)).toBe(false);
    expect(hasUnsavedWork({ ...s, origin: 'link', source: 'x' })).toBe(false);
  });
  it('is true when edited, running, or changed from the load', () => {
    expect(hasUnsavedWork({ ...s, origin: 'edited' })).toBe(true);
    expect(hasUnsavedWork({ ...s, running: true })).toBe(true);
    expect(hasUnsavedWork({ ...s, source: 'b' })).toBe(true);
  });
});
