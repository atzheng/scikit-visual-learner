/**
 * Helpers shared by `pnpm measure` and `pnpm e2e`: system Chrome through playwright-core against
 * `vite preview` of the built site (run `pnpm build` first), everything on 127.0.0.1 and an OS-assigned port.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';

export const ROOT = path.resolve(import.meta.dirname, '../..');

export const CHROME =
  process.env.MEASURE_CHROME ??
  process.env.E2E_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** A port the OS says is free right now (other sessions may be running servers). */
export async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** `vite preview` of the built web package on 127.0.0.1:port. Resolves when it listens. */
export function startPreview(port: number): Promise<ChildProcess> {
  const child = spawn(
    'pnpm',
    [
      '--filter',
      '@machines/web',
      'exec',
      'vite',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    // detached: its own process group, so stopPreview can end pnpm and the vite it started
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  // stderr is kept quiet (killing the server at the end makes pnpm complain); it is shown if startup fails
  let err = '';
  child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (d: Buffer) => {
      if (/Local:/.test(d.toString())) resolve(child);
    });
    child.on('exit', (c) =>
      reject(new Error(`vite preview exited (${c}); did you run pnpm build?\n${err}`)),
    );
  });
}

/** Ends the preview server and the pnpm that started it (killing pnpm alone leaves vite running). */
export function stopPreview(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

/**
 * On Ctrl-C or SIGTERM, runs `cleanup` (stop the preview's process group, close the browser) and exits
 * non-zero. The preview is detached, so without this an interrupted run would leave vite running.
 */
export function cleanupOnSignal(cleanup: () => Promise<void> | void): void {
  let done = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (done) return;
      done = true;
      Promise.resolve()
        .then(cleanup)
        .catch(() => undefined)
        .finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
    });
  }
}

export async function newPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

/** Waits until the page's runtime reports ready. Needs the page to be loaded with `?debug`. */
export async function waitReady(page: Page, timeout = 15 * 60_000): Promise<void> {
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __machines?: { getState(): { runtime: { state: string } } } }
      ).__machines?.getState().runtime.state === 'ready',
    undefined,
    { timeout, polling: 20 },
  );
}
