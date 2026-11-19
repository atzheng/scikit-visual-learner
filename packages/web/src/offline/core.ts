/**
 * Pure logic for the offline service worker: precache manifest, cache names, upgrade rules.
 * No DOM, worker or node globals, so it is unit-tested and shared by the build script and sw.ts.
 */

export const CACHE_PREFIX = 'machines-';

export interface BuildFile {
  /** Path relative to the site root, with forward slashes, e.g. "assets/index-abc.js". */
  path: string;
  /** Content hash (or size for large binaries); only feeds the cache names. */
  digest: string;
}

export interface Manifest {
  /** Names the two caches. Shell changes with every build; pyodide only when its files change. */
  shellCache: string;
  pyodideCache: string;
  /** Site-relative URLs ("/", "/assets/x.js"). */
  shell: string[];
  pyodide: string[];
}

/** Files that must never be cached: the SW itself and host config. */
const SKIP = new Set(['sw.js', '_headers', '_redirects']);

export function isPrecached(path: string): boolean {
  return !SKIP.has(path) && !path.endsWith('.map');
}

export function toUrl(path: string): string {
  return path === 'index.html' ? '/' : `/${path}`;
}

/** Build the manifest from the build output listing. Order of `files` does not matter. */
export function buildManifest(
  files: BuildFile[],
  pyodideVersion: string,
  hash: (s: string) => string,
): Manifest {
  const kept = files.filter((f) => isPrecached(f.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  const isPy = (f: BuildFile) => f.path.startsWith('pyodide/');
  const py = kept.filter(isPy);
  const shell = kept.filter((f) => !isPy(f));
  const id = (fs: BuildFile[]) =>
    hash(fs.map((f) => `${f.path}:${f.digest}`).join('\n')).slice(0, 12);
  return {
    shellCache: `${CACHE_PREFIX}shell-${id(shell)}`,
    pyodideCache: `${CACHE_PREFIX}pyodide-${pyodideVersion}-${id(py)}`,
    shell: shell.map((f) => toUrl(f.path)),
    pyodide: py.map((f) => toUrl(f.path)),
  };
}

/** Caches to delete on activate: ours (by prefix) that the current manifest does not name. */
export function staleCaches(
  existing: string[],
  m: Pick<Manifest, 'shellCache' | 'pyodideCache'>,
): string[] {
  return existing.filter(
    (n) => n.startsWith(CACHE_PREFIX) && n !== m.shellCache && n !== m.pyodideCache,
  );
}

/** Which of `wanted` are not yet in the cache (so an upgrade that keeps Pyodide downloads nothing). */
export function missingUrls(wanted: string[], cachedPaths: string[]): string[] {
  const have = new Set(cachedPaths);
  return wanted.filter((u) => !have.has(u));
}

/** Only same-origin GETs are served from cache; everything else goes to the network untouched. */
export function shouldHandle(method: string, requestUrl: string, origin: string): boolean {
  return method === 'GET' && new URL(requestUrl).origin === origin;
}

/** The cache key for a request: navigations (any path or query) map to the app shell "/". */
export function cacheKey(requestUrl: string, isNavigation: boolean): string {
  return isNavigation ? '/' : new URL(requestUrl).pathname;
}
