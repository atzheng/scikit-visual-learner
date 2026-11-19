/**
 * Service worker (hand-written, no vite-plugin-pwa: the manifest is two lists from the build output,
 * and the page must keep COOP/COEP, which a generic plugin would not know about).
 *
 * - install: fetch the shell and /pyodide/* into versioned caches (only files not already cached).
 *   Does NOT skipWaiting: the page shows "update available" and asks before reloading.
 * - activate: delete caches this build does not name, then claim open pages.
 * - fetch: same-origin GETs are served cache-first. Cached responses are the originals the host sent,
 *   so their COOP/COEP headers are kept and crossOriginIsolated stays true offline.
 *
 * Hazard for code splitting: activate deletes the old shell cache while an old page may still be open;
 * its lazy chunk requests would then go to the network and could 404 against the new deploy. Today
 * the app is one bundle. If chunks are added, keep the previous shell cache until old clients are gone.
 *
 * Built by scripts/build-sw.ts, which injects __MANIFEST__.
 */
import { cacheKey, missingUrls, shouldHandle, staleCaches, type Manifest } from './offline/core';

declare const __MANIFEST__: Manifest;

interface ExtEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEv extends ExtEvent {
  request: Request;
  respondWith(r: Promise<Response> | Response): void;
}
const sw = self as unknown as {
  location: Location;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(t: string, fn: (e: never) => void): void;
};
const m = __MANIFEST__;

async function fill(cacheName: string, urls: string[]): Promise<void> {
  const cache = await caches.open(cacheName);
  const have = (await cache.keys()).map((r) => new URL(r.url).pathname);
  for (const url of missingUrls(urls, have)) {
    // Default cache mode, so files the page just fetched come from the HTTP cache.
    const res = await fetch(url);
    // Only complete 200 responses: put() throws on 206, and a partial file must not be cached.
    if (res.status !== 200) throw new Error(`precache ${url}: ${res.status}`);
    await cache.put(url, res);
  }
}

sw.addEventListener('install', ((e: ExtEvent) => {
  e.waitUntil(Promise.all([fill(m.shellCache, m.shell), fill(m.pyodideCache, m.pyodide)]));
}) as (e: never) => void);

sw.addEventListener('activate', ((e: ExtEvent) => {
  e.waitUntil(
    (async () => {
      for (const n of staleCaches(await caches.keys(), m)) await caches.delete(n);
      await sw.clients.claim();
    })(),
  );
}) as (e: never) => void);

sw.addEventListener('message', ((e: { data?: { type?: string } }) => {
  if (e.data?.type === 'SKIP_WAITING') void sw.skipWaiting();
}) as (e: never) => void);

sw.addEventListener('fetch', ((e: FetchEv) => {
  const { request } = e;
  if (!shouldHandle(request.method, request.url, sw.location.origin)) return;
  const key = cacheKey(request.url, request.mode === 'navigate');
  e.respondWith(
    (async () => {
      const hit =
        (await (await caches.open(m.shellCache)).match(key)) ??
        (await (await caches.open(m.pyodideCache)).match(key));
      return hit ?? fetch(request);
    })(),
  );
}) as (e: never) => void);
