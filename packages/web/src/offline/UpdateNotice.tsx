import { useEffect, useState } from 'react';
import { registerServiceWorker } from './register';
import './update-notice.css';

/** "Update available" bar. Shown only when a new build is waiting; never reloads by itself. */
export function UpdateNotice() {
  const [apply, setApply] = useState<(() => void) | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    registerServiceWorker((fn) => {
      setApply(() => fn);
      setDismissed(false);
    });
  }, []);
  if (!apply || dismissed) return null;
  return (
    <div className="update-notice" role="status">
      <span>A new version is available.</span>
      <button type="button" onClick={apply}>
        Reload to update
      </button>
      <button type="button" onClick={() => setDismissed(true)}>
        Later
      </button>
    </div>
  );
}
