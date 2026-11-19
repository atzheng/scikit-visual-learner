/**
 * Run python/tests inside the pinned Pyodide on Node (`pnpm test:pyodide`).
 *
 * - Pyodide and its wheels come from the local cache that fetch-pyodide.ts assembles. This script
 *   never downloads: if the cache is missing it exits with a message saying how to fill it.
 * - The repo is mounted at /repo with NODEFS, so pytest reads python/, fixtures/ and pyproject.toml
 *   from the working tree.
 * - Tests marked `no_pyodide` are skipped there (python/tests/conftest.py); the reason is in the
 *   marker. Slow tests are skipped by pyproject addopts, as in `pnpm test:py`.
 *
 * Usage: tsx scripts/pyodide-pytest.ts [pytest args...]
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPyodide } from './fetch-pyodide.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const PACKAGES = ['numpy', 'pandas', 'scipy', 'scikit-learn', 'matplotlib', 'pytest'];

async function main(): Promise<number> {
  const dist = await localPyodide();
  if (!dist) {
    console.error(
      'test:pyodide: the local Pyodide copy is missing or incomplete.\n' +
        'Run `pnpm --filter @machines/web exec tsx scripts/fetch-pyodide.ts` once (it downloads ' +
        'about 340 MB), then retry. Tests never download.',
    );
    return 2;
  }
  const require = createRequire(import.meta.url);
  const { loadPyodide } = (await import(
    path.join(path.dirname(require.resolve('pyodide/package.json')), 'pyodide.mjs')
  )) as typeof import('pyodide');

  const py = await loadPyodide({
    indexURL: dist,
    lockFileURL: path.join(dist, 'pyodide-lock.json'),
  });
  await py.loadPackage(PACKAGES);

  py.FS.mkdirTree('/repo');
  py.FS.mount(py.FS.filesystems.NODEFS, { root: repoRoot }, '/repo');
  py.FS.chdir('/repo');

  py.globals.set('pytest_args', process.argv.slice(2));
  const status = await py.runPythonAsync(`
import sys
sys.path.insert(0, "/repo/python")
sys.dont_write_bytecode = True
import pytest
int(pytest.main(["-p", "no:cacheprovider", *pytest_args.to_py()]))
`);
  return Number(status);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
