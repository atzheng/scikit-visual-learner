/** Walks the build output and writes dist/sw.js with the precache manifest injected. Runs after the Pyodide copy. */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { buildManifest, type BuildFile } from '../src/offline/core';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

async function walk(dir: string, base = ''): Promise<BuildFile[]> {
  const out: BuildFile[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(abs, rel)));
    else if (/\.(whl|wasm|zip)$/.test(ent.name)) {
      // Large binaries: size is enough (the names carry versions); avoids hashing ~50 MB.
      out.push({ path: rel, digest: String((await stat(abs)).size) });
    } else out.push({ path: rel, digest: sha(await readFile(abs)) });
  }
  return out;
}

export async function buildServiceWorker(webRoot: string): Promise<void> {
  const dist = path.join(webRoot, 'dist');
  const pkg = JSON.parse(
    await readFile(path.join(webRoot, 'node_modules/pyodide/package.json'), 'utf8'),
  ) as { version: string };
  const manifest = buildManifest(await walk(dist), pkg.version, sha);
  await build({
    root: webRoot,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    define: { __MANIFEST__: JSON.stringify(manifest) },
    build: {
      outDir: dist,
      emptyOutDir: false,
      lib: {
        entry: path.join(webRoot, 'src/sw.ts'),
        formats: ['iife'],
        name: 'sw',
        fileName: () => 'sw.js',
      },
    },
  });
}
