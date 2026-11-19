import { create } from 'zustand';
import { STARTER_EXAMPLE } from '../course';
import { addLinkFiles } from '../files/filesStore';
import { getLocalStorage, readAutosave } from '../storage/autosave';
import { useStore } from '../store';
import { decodeShare, fragmentPayload } from './link';
import { hasUnsavedWork, nextOrigin } from './origin';

interface ShareState {
  /** Source as it arrived by link; origin stays 'link' only while the editor holds exactly this. */
  linkSource: string | null;
  /** Message when the fragment could not be opened. */
  loadError: string | null;
  dismissError(): void;
}

export const useShare = create<ShareState>()((set) => ({
  linkSource: null,
  loadError: null,
  dismissError: () => set({ loadError: null }),
}));

/** Source the editor held at the last load (page start, link, back to my code). */
let baseline = useStore.getState().source;
let loadSeq = 0;

/** Called when the initial source changes (autosave restore) so it does not count as unsaved work. */
export function setBaseline(source: string): void {
  baseline = source;
}

/** origin: 'link' -> 'edited' on the first edit or Run. */
useStore.subscribe((s) => {
  const next = nextOrigin(s.origin, {
    source: s.source,
    linkSource: useShare.getState().linkSource,
    running: s.running,
  });
  if (next !== s.origin) useStore.setState({ origin: next });
});

function clearHash(): void {
  history.replaceState(null, '', location.pathname + location.search);
}

/**
 * Opens a `#c=` link: valid code goes into the editor with origin 'link' and is never run; a bad
 * link leaves the editor alone and sets `loadError`. The hash is cleared afterwards so a reload
 * does not discard edits. Hashes that are not share links are ignored. With `confirmReplace`,
 * unsaved work or a run in progress is only replaced after the reader agrees. The last hash wins.
 */
export async function loadFromHash(
  hash: string,
  opts: { confirmReplace?: (msg: string) => boolean } = {},
): Promise<void> {
  const text = fragmentPayload(hash);
  if (text === null) return;
  const seq = ++loadSeq;
  const r = await decodeShare(text);
  if (seq !== loadSeq) return;
  clearHash();
  if (!r.ok) {
    useShare.setState({ loadError: r.error });
    return;
  }
  const s = useStore.getState();
  if (
    opts.confirmReplace &&
    hasUnsavedWork({ origin: s.origin, running: s.running, source: s.source, baseline }) &&
    !opts.confirmReplace(
      'Open the code from this link? Your current code in the editor will be replaced.',
    )
  ) {
    return;
  }
  baseline = r.payload.code;
  useShare.setState({ linkSource: r.payload.code, loadError: null });
  useStore.setState({ source: r.payload.code, origin: 'link' });
  if (r.payload.files) await addLinkFiles(r.payload.files);
}

/** Leave link code and go back to the reader's own code: the autosave, else the starter example. */
export function backToMyCode(): void {
  loadSeq++;
  const saved = readAutosave(getLocalStorage());
  const source = saved ?? STARTER_EXAMPLE;
  baseline = source;
  useShare.setState({ linkSource: null });
  useStore.setState({ source, origin: saved === null ? 'starter' : 'autosave' });
  clearHash();
  const ed = document.querySelector<HTMLElement>('#pane-editor .cm-content');
  (ed ?? document.getElementById('pane-editor'))?.focus();
}
