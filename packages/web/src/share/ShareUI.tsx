import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import './share.css';
import { encodeShare, linkUrl } from './link';
import { backToMyCode, loadFromHash, useShare } from './shareState';

/** Opens a link on page load and when only the fragment changes. */
export function useLoadShareLink(): void {
  useEffect(() => {
    void loadFromHash(location.hash);
    const onHash = () => void loadFromHash(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
}

type Notice = { kind: 'ok' | 'error'; text: string } | null;

export function ShareButton() {
  const source = useStore((s) => s.source);
  const [notice, setNotice] = useState<Notice>(null);
  const [manual, setManual] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = (n: Notice) => {
    window.clearTimeout(timer.current);
    setNotice(n);
    if (n?.kind === 'ok') timer.current = window.setTimeout(() => setNotice(null), 5000);
  };

  const share = async () => {
    setManual(null);
    // Inline data files arrive with svl-bwv.9 (upload); until then links carry code only.
    const r = await encodeShare({ code: source });
    if (!r.ok) return show({ kind: 'error', text: r.error });
    const url = linkUrl(location.href, r.fragment);
    try {
      await navigator.clipboard.writeText(url);
      show({ kind: 'ok', text: 'Link copied to the clipboard.' });
    } catch {
      setManual(url);
      show({ kind: 'error', text: 'Could not copy automatically. Copy the link below.' });
    }
  };

  const dismiss = () => {
    setNotice(null);
    setManual(null);
  };

  return (
    <div className="share">
      <button type="button" onClick={() => void share()}>
        Share
      </button>
      <div className="share-notice" role="status" aria-live="polite">
        {notice && (
          <div className={`share-pop ${notice.kind}`}>
            <span>
              <span aria-hidden="true">{notice.kind === 'ok' ? '✓' : '⚠'}</span> {notice.text}
            </span>
            {manual && (
              <input
                readOnly
                aria-label="Share link"
                value={manual}
                onFocus={(e) => e.currentTarget.select()}
              />
            )}
            {notice.kind === 'error' && (
              <button type="button" onClick={dismiss}>
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Banner for code that arrived by link; goes away once the reader edits it. */
export function LinkBanner() {
  const origin = useStore((s) => s.origin);
  const source = useStore((s) => s.source);
  const linkSource = useShare((s) => s.linkSource);
  const loadError = useShare((s) => s.loadError);
  const dismissError = useShare((s) => s.dismissError);
  return (
    <>
      {origin === 'link' && linkSource !== null && source === linkSource && (
        <div className="banner" role="status">
          <span aria-hidden="true">ⓘ</span>
          <span className="banner-text">Code from a link — press Run to run it</span>
          <button type="button" onClick={backToMyCode}>
            Back to my code
          </button>
        </div>
      )}
      {loadError && (
        <div className="banner error" role="alert">
          <span aria-hidden="true">⚠</span>
          <span className="banner-text">{loadError}</span>
          <button type="button" onClick={dismissError}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
