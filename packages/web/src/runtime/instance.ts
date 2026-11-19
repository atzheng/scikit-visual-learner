import { RuntimeClient, type RuntimeClientOptions, type WorkerLike } from './client';

let client: RuntimeClient | null = null;

/** The page's single RuntimeClient; created (and the worker started) on first call. */
export function getRuntime(
  handlers: Pick<RuntimeClientOptions, 'onProgress' | 'onReady' | 'onState' | 'onError'>,
): RuntimeClient {
  client ??= new RuntimeClient({
    // The literal `new Worker(new URL(..., import.meta.url), { type: 'module' })` is what Vite bundles.
    createWorker: () =>
      new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
      }) as unknown as WorkerLike,
    ...handlers,
  });
  return client;
}

export function currentRuntime(): RuntimeClient | null {
  return client;
}
