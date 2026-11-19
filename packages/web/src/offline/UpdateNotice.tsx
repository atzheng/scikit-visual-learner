import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { registerServiceWorker } from './register';
import './update-notice.css';

/**
 * "Update available" bar. Shown only when a new build is waiting; never reloads by itself.
 * Registration waits until Python is ready so the 50 MB precache does not compete with the first load.
 * "Later" collapses the bar to a small "Update available" button.
 */
export function UpdateNotice() {
  const ready = useStore((s) => s.runtime.state !== 'loading');
  const [apply, setApply] = useState<(() => void) | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!ready) return;
    registerServiceWorker((fn) => {
      setApply(() => fn);
      setCollapsed(false);
    });
  }, [ready]);
  return (
    <>
      {/* Always in the DOM so screen readers announce the text when it is filled. */}
      <div role="status" className="sr-only">
        {apply ? 'A new version is available.' : ''}
      </div>
      {apply && !collapsed && (
        <div className="update-notice">
          <span aria-hidden="true">A new version is available.</span>
          <button type="button" onClick={apply}>
            Reload to update
          </button>
          <button type="button" onClick={() => setCollapsed(true)}>
            Later
          </button>
        </div>
      )}
      {apply && collapsed && (
        <button
          type="button"
          className="update-notice update-chip"
          onClick={() => setCollapsed(false)}
        >
          Update available
        </button>
      )}
    </>
  );
}
