import { useState } from 'react';
import { create } from 'zustand';

/** Set once when autosave could not write (quota or blocked storage). */
export const useAutosaveNotice = create<{ failed: boolean }>()(() => ({ failed: false }));

export function AutosaveNotice() {
  const failed = useAutosaveNotice((s) => s.failed);
  const [dismissed, setDismissed] = useState(false);
  if (!failed || dismissed) return null;
  return (
    <div className="banner error" role="alert" data-testid="autosave-notice">
      <span aria-hidden="true">⚠</span>
      <span className="banner-text">
        Your code could not be saved in this browser, so it will not be here after a reload. Copy it
        somewhere safe.
      </span>
      <button type="button" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
