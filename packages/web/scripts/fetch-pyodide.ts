/**
 * Assemble the self-hosted Pyodide distribution in
 * packages/web/node_modules/.cache/pyodide/<version>/dist (never committed).
 *
 * - Core files (pyodide.mjs, pyodide.asm.*, python_stdlib.zip, pyodide-lock.json) come
 *   from the pinned `pyodide` npm package.
 * - The npm package ships no wheels, so the wheels for the packages in WHEEL_ROOTS (and
 *   their dependencies, resolved from pyodide-lock.json) are extracted from the matching
 *   GitHub release tarball, downloaded once and cached.
 *
 * Usage: tsx scripts/fetch-pyodide.ts [--copy-to <dir>]
 * `pytest` is included for `pnpm test:pyodide` (pyodide-pytest.ts), which only reads this cache
 * and never downloads. Vitest and pytest on CPython do not need this script.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const WHEEL_ROOTS = ['numpy', 'pandas', 'scipy', 'scikit-learn', 'matplotlib', 'pytest'];
const CORE_FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

interface LockPackage {
  file_name: string;
  depends: string[];
}
interface Lock {
  packages: Record<string, LockPackage>;
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Names of `roots` plus everything they depend on, in lock-file name form. */
export function closure(lock: Lock, roots: string[]): string[] {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (seen.has(name)) continue;
    const pkg = lock.packages[name];
    if (!pkg) throw new Error(`package ${name} is not in pyodide-lock.json`);
    seen.add(name);
    stack.push(...pkg.depends);
  }
  return [...seen].sort();
}

export function cacheDir(version: string): string {
  return path.join(webRoot, 'node_modules', '.cache', 'pyodide', version);
}

/** Marker contents: the version and the wheel roots, so a changed root list re-extracts. */
function markerText(version: string): string {
  return `${version} ${WHEEL_ROOTS.join(',')}\n`;
}

/**
 * The assembled dist directory if it is complete, else null. Never touches the network.
 */
export async function localPyodide(): Promise<string | null> {
  const require = createRequire(import.meta.url);
  const npmDir = path.dirname(require.resolve('pyodide/package.json'));
  const version = (
    JSON.parse(await readFile(path.join(npmDir, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const dist = path.join(cacheDir(version), 'dist');
  try {
    const m = await readFile(path.join(dist, '.complete'), 'utf8');
    return m === markerText(version) ? dist : null;
  } catch {
    return null;
  }
}

export async function preparePyodide(): Promise<string> {
  const require = createRequire(import.meta.url);
  const npmDir = path.dirname(require.resolve('pyodide/package.json'));
  const version = (
    JSON.parse(await readFile(path.join(npmDir, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const base = cacheDir(version);
  const dist = path.join(base, 'dist');
  const marker = path.join(dist, '.complete');
  const done = await localPyodide();
  if (done) return done;

  const lock = JSON.parse(await readFile(path.join(npmDir, 'pyodide-lock.json'), 'utf8')) as Lock;
  const wheels = closure(lock, WHEEL_ROOTS).map((n) => (lock.packages[n] as LockPackage).file_name);

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  for (const f of CORE_FILES) await cp(path.join(npmDir, f), path.join(dist, f));

  const tarball = path.join(base, `pyodide-${version}.tar.bz2`);
  if (!existsSync(tarball)) {
    const url = `https://github.com/pyodide/pyodide/releases/download/${version}/pyodide-${version}.tar.bz2`;
    console.log(`fetch-pyodide: downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`);
    const tmp = `${tarball}.part`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    await rename(tmp, tarball);
  }

  const listFile = path.join(base, 'members.txt');
  await writeFile(listFile, wheels.map((w) => `pyodide/${w}`).join('\n') + '\n');
  const x = spawnSync(
    'tar',
    ['-xjf', tarball, '-C', dist, '--strip-components=1', '-T', listFile],
    {
      stdio: 'inherit',
    },
  );
  if (x.status !== 0) throw new Error('tar extraction failed');
  for (const w of wheels) {
    if (!existsSync(path.join(dist, w))) throw new Error(`wheel missing after extraction: ${w}`);
  }
  await writeFile(marker, markerText(version));
  return dist;
}

async function main(): Promise<void> {
  const dist = await preparePyodide();
  const i = process.argv.indexOf('--copy-to');
  const target = i >= 0 ? process.argv[i + 1] : undefined;
  if (target) {
    await rm(target, { recursive: true, force: true });
    await cp(dist, target, { recursive: true, filter: (s) => path.basename(s) !== '.complete' });
    console.log(`fetch-pyodide: copied to ${target}`);
  } else {
    console.log(`fetch-pyodide: ready at ${dist}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
