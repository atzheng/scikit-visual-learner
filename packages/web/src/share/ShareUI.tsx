import { useEffect, useRef, useState } from 'react';
import { useFiles } from '../files/filesStore';
import { sharableFiles } from '../files/upload';
import { useStore } from '../store';
import './share.css';
import { encodeShare, linkUrl } from './link';
import { backToMyCode, loadFromHash, useShare } from './shareState';

/** Opens a link on page load and when only the fragment changes. */
export function useLoadShareLink(): void {
  useEffect(() => {
    void loadFromHash(location.hash);
    const onHash = () =>
      void loadFromHash(location.hash, { confirmReplace: (m) => window.confirm(m) });
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
}

type Notice = { kind: 'ok' | 'error'; text: string } | null;

function ManualLink({ url }: { url: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return <input ref={ref} readOnly aria-label="Share link" value={url} />;
}

export function ShareButton() {
  const source = useStore((s) => s.source);
  const [notice, setNotice] = useState<Notice>(null);
  const [manual, setManual] = useState<string | null>(null);
  const [canDrop, setCanDrop] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = (n: Notice) => {
    window.clearTimeout(timer.current);
    setNotice(n);
    if (n?.kind === 'ok') timer.current = window.setTimeout(() => setNotice(null), 5000);
  };

  const share = async (withData = true) => {
    setManual(null);
    setCanDrop(false);
    const files = withData ? sharableFiles(useFiles.getState().files) : {};
    const r = await encodeShare({ code: source, files });
    if (!r.ok) {
      setCanDrop(r.withoutDataFits && withData);
      return show({ kind: 'error', text: r.error });
    }
    const url = linkUrl(location.href, r.fragment);
    try {
      await navigator.clipboard.writeText(url);
      show({
        kind: 'ok',
        text: withData
          ? 'Link copied to the clipboard.'
          : 'Link copied to the clipboard, without the data files.',
      });
    } catch {
      setManual(url);
      show({ kind: 'error', text: 'Could not copy automatically. Copy the link below.' });
    }
  };

  const dismiss = () => {
    setNotice(null);
    setManual(null);
    setCanDrop(false);
  };

  return (
    <div className="share">
      <button type="button" onClick={() => void share(true)}>
        Share
      </button>
      {notice && (
        <div className={`share-pop ${notice.kind}`}>
          <span role="status" aria-live="polite">
            <span aria-hidden="true">{notice.kind === 'ok' ? '✓' : '⚠'}</span> {notice.text}
          </span>
          {manual && <ManualLink url={manual} />}
          {canDrop && (
            <button type="button" onClick={() => void share(false)}>
              Share without data
            </button>
          )}
          {notice.kind === 'error' && (
            <button type="button" onClick={dismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const BANNER_TEXT = 'Code from a link — press Run to run it';

/** Banner for code that arrived by link; goes away at the first edit or Run (origin 'edited'). */
export function LinkBanner() {
  const origin = useStore((s) => s.origin);
  const loadError = useShare((s) => s.loadError);
  const dismissError = useShare((s) => s.dismissError);
  const show = origin === 'link';
  // The live region is mounted empty and filled a moment later, so screen readers announce it.
  const [text, setText] = useState('');
  useEffect(() => {
    if (!show) return setText('');
    const t = window.setTimeout(() => setText(BANNER_TEXT), 50);
    return () => window.clearTimeout(t);
  }, [show]);
  return (
    <>
      <div className={show ? 'banner' : 'banner-hidden'}>
        <span aria-hidden="true">ⓘ</span>
        <span className="banner-text" role="status">
          {text}
        </span>
        {show && (
          <button type="button" onClick={backToMyCode}>
            Back to my code
          </button>
        )}
      </div>
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
