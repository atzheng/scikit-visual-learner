import { STARTER_EXAMPLE } from '../course';
import { setBaseline } from '../share/shareState';
import { useStore } from '../store';
import { useAutosaveNotice } from './notice';
import { chooseInitial, createAutosaver, getLocalStorage, readAutosave } from './autosave';

/**
 * Restores the autosaved code (unless the URL carries a share link) and starts saving edits.
 * Call once at startup, before the first render.
 */
export function initPersistence(): void {
  const kv = getLocalStorage();
  const initial = chooseInitial({
    hash: location.hash,
    autosave: readAutosave(kv),
    starter: STARTER_EXAMPLE,
  });
  useStore.setState({ source: initial.source, origin: initial.origin });
  setBaseline(initial.source);
  const saver = createAutosaver({
    kv,
    state: () => useStore.getState(),
    starter: STARTER_EXAMPLE,
    onFail: () => useAutosaveNotice.setState({ failed: true }),
  });
  useStore.subscribe((s, prev) => {
    if (s.source !== prev.source || s.origin !== prev.origin) saver.schedule();
  });
  window.addEventListener('pagehide', () => saver.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saver.flush();
  });
}
