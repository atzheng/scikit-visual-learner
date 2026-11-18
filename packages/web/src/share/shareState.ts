import { create } from 'zustand';
import { STARTER_EXAMPLE } from '../course';
import { useStore } from '../store';
import { decodeShare, fragmentPayload } from './link';

interface ShareState {
  /** Source as it arrived by link; the banner shows while the editor still holds exactly this. */
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

/**
 * Reads `#c=` from the hash. Valid code goes into the editor with origin 'link' and is never run.
 * A bad link leaves the editor alone and sets `loadError`.
 */
export async function loadFromHash(hash: string): Promise<void> {
  const text = fragmentPayload(hash);
  if (text === null) return;
  const r = await decodeShare(text);
  if (!r.ok) {
    useShare.setState({ loadError: r.error });
    return;
  }
  useShare.setState({ linkSource: r.payload.code, loadError: null });
  useStore.setState({ source: r.payload.code, origin: 'link' });
  // r.payload.files: svl-bwv.9 (upload plumbing) will write these into the runtime FS.
}

/**
 * Leave link code. svl-bwv.9 replaces the target with the autosaved code once autosave exists;
 * until then the starter example is the reader's own code.
 */
export function backToMyCode(): void {
  useShare.setState({ linkSource: null });
  useStore.setState({ source: STARTER_EXAMPLE, origin: 'starter' });
  history.replaceState(null, '', location.pathname + location.search);
}
