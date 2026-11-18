/// <reference types="vitest/config" />
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { preparePyodide } from './scripts/fetch-pyodide';

const MIME: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.whl': 'application/zip',
};

/** Serves the self-hosted Pyodide distribution at /pyodide/ in dev and preview, and copies it to dist/pyodide on build. */
function pyodide(): Plugin {
  let dist = '';
  const serve = async (
    url: string | undefined,
    res: import('node:http').ServerResponse,
    next: () => void,
  ) => {
    const m = /^\/pyodide\/([^?#]+)/.exec(url ?? '');
    if (!m) return next();
    dist ||= await preparePyodide();
    const file = path.join(dist, path.normalize(decodeURIComponent(m[1] as string)));
    if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      return next();
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', statSync(file).size);
    createReadStream(file).pipe(res);
  };
  return {
    name: 'machines-pyodide',
    configureServer(server) {
      if (process.env.VITEST) return;
      server.middlewares.use((req, res, next) => void serve(req.url, res, next));
    },
    async closeBundle() {
      if (process.env.VITEST || this.environment?.config.command !== 'build') return;
      const { cp, rm } = await import('node:fs/promises');
      const src = await preparePyodide();
      const out = path.resolve(import.meta.dirname, 'dist', 'pyodide');
      await rm(out, { recursive: true, force: true });
      await cp(src, out, { recursive: true, filter: (s) => path.basename(s) !== '.complete' });
    },
  };
}

/** COOP/COEP make `crossOriginIsolated` true (SharedArrayBuffer for interrupts). CSP is left to public/_headers. */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react(), pyodide()],
  server: { port: 5173, headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  optimizeDeps: { exclude: ['pyodide'] },
  test: { environment: 'node' },
});
