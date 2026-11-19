/** Registers the service worker (production only) and reports a waiting update to the page. */

export type UpdateListener = (apply: () => void) => void;

/**
 * Registers /sw.js. `onUpdate` is called with an `apply` function when a new build is installed and
 * waiting while an older one controls the page. `apply` activates it and reloads; nothing reloads on its own.
 */
export function registerServiceWorker(onUpdate: UpdateListener): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  const offer = (reg: ServiceWorkerRegistration): void => {
    const waiting = reg.waiting;
    // No controller means this is the first install, not an update.
    if (!waiting || !sw.controller) return;
    onUpdate(() => waiting.postMessage({ type: 'SKIP_WAITING' }));
  };
  void sw.register('/sw.js').then(
    (reg) => {
      offer(reg);
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        next?.addEventListener('statechange', () => {
          if (next.state === 'installed') offer(reg);
        });
      });
      // Long sessions: look for a new build now and then.
      setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
    },
    () => undefined,
  );
}
