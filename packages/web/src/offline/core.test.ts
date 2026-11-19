import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  cacheKey,
  missingUrls,
  shouldHandle,
  staleCaches,
  type BuildFile,
} from './core';

// Deterministic stand-in for a real hash: distinct inputs give distinct outputs here.
const hash = (s: string): string => Buffer.from(s).toString('hex').slice(-24).padStart(24, '0');

const files: BuildFile[] = [
  { path: 'index.html', digest: 'a' },
  { path: 'assets/index-1.js', digest: 'b' },
  { path: 'assets/index-1.js.map', digest: 'x' },
  { path: 'sw.js', digest: 'c' },
  { path: '_headers', digest: 'd' },
  { path: 'pyodide/pyodide.asm.wasm', digest: 'e' },
  { path: 'pyodide/numpy.whl', digest: 'f' },
];

describe('buildManifest', () => {
  const m = buildManifest(files, '314.0.8', hash);
  it('splits shell and pyodide, excluding sw.js, _headers, maps', () => {
    expect(m.shell).toEqual(['/assets/index-1.js', '/']);
    expect(m.pyodide).toEqual(['/pyodide/numpy.whl', '/pyodide/pyodide.asm.wasm']);
  });
  it('is order independent', () => {
    expect(buildManifest([...files].reverse(), '314.0.8', hash)).toEqual(m);
  });
  it('shell cache changes with shell content, pyodide cache does not', () => {
    const next = buildManifest(
      files.map((f) => (f.path === 'index.html' ? { ...f, digest: 'z' } : f)),
      '314.0.8',
      hash,
    );
    expect(next.shellCache).not.toBe(m.shellCache);
    expect(next.pyodideCache).toBe(m.pyodideCache);
  });
  it('pyodide cache is tied to the version and to its files', () => {
    expect(buildManifest(files, '315.0.0', hash).pyodideCache).not.toBe(m.pyodideCache);
    expect(m.pyodideCache).toMatch(/^machines-pyodide-314\.0\.8-/);
    const changed = buildManifest(
      files.map((f) => (f.path === 'pyodide/numpy.whl' ? { ...f, digest: 'q' } : f)),
      '314.0.8',
      hash,
    );
    expect(changed.pyodideCache).not.toBe(m.pyodideCache);
  });
});

describe('staleCaches', () => {
  const m = buildManifest(files, '314.0.8', hash);
  it('deletes old machines caches only', () => {
    const old = ['machines-shell-old', 'machines-pyodide-313.0.0-x', m.shellCache, m.pyodideCache, 'other-app'];
    expect(staleCaches(old, m)).toEqual(['machines-shell-old', 'machines-pyodide-313.0.0-x']);
  });
});

describe('routing', () => {
  it('missingUrls', () => {
    expect(missingUrls(['/a', '/b'], ['/a'])).toEqual(['/b']);
  });
  it('shouldHandle only same-origin GET', () => {
    expect(shouldHandle('GET', 'https://x.org/a', 'https://x.org')).toBe(true);
    expect(shouldHandle('POST', 'https://x.org/a', 'https://x.org')).toBe(false);
    expect(shouldHandle('GET', 'https://cdn.org/a', 'https://x.org')).toBe(false);
  });
  it('cacheKey maps navigations to the shell and drops queries', () => {
    expect(cacheKey('https://x.org/foo?debug', true)).toBe('/');
    expect(cacheKey('https://x.org/assets/a.js?v=1', false)).toBe('/assets/a.js');
  });
});
