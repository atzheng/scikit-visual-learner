import { useEffect, useRef } from 'react';
import { DATASETS } from '../course';
import './files.css';
import { addUploads, useFiles } from './filesStore';

/** Toolbar button that opens the file picker for CSVs. */
export function UploadButton() {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => input.current?.click()}>
        Upload CSV
      </button>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        multiple
        hidden
        data-testid="upload-input"
        onChange={(e) => {
          void addUploads([...(e.target.files ?? [])]);
          e.target.value = ''; // the same file can be chosen again
        }}
      />
    </>
  );
}

/** Drop CSV files onto the editor. Other drops (text) are left to the editor. */
export function useDropUpload(): void {
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const inEditor = (e: DragEvent) =>
      e.target instanceof Element && !!e.target.closest('#pane-editor');
    const over = (e: DragEvent) => {
      if (!hasFiles(e) || !inEditor(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !inEditor(e)) return;
      e.preventDefault();
      e.stopPropagation();
      void addUploads([...(e.dataTransfer?.files ?? [])]);
    };
    document.addEventListener('dragover', over, true);
    document.addEventListener('drop', drop, true);
    return () => {
      document.removeEventListener('dragover', over, true);
      document.removeEventListener('drop', drop, true);
    };
  }, []);
}

/** Course datasets and the student's files, with row counts, plus upload warnings. */
export function FileList() {
  const files = useFiles((s) => s.files);
  const notes = useFiles((s) => s.notes);
  const dismiss = useFiles((s) => s.dismissNotes);
  return (
    <>
      <details className="files">
        <summary>Data files ({DATASETS.length + files.length})</summary>
        <ul aria-label="Data files">
          {DATASETS.map((n) => (
            <li key={n}>
              <code>{n}</code> <span className="muted">course dataset</span>
            </li>
          ))}
          {files.map((f) => (
            <li key={f.name}>
              <code>{f.name}</code>{' '}
              <span className="muted">
                {f.rows.toLocaleString('en-US')} rows, {f.origin === 'link' ? 'from link' : 'yours'}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted">
          Files stay in this browser. Read them with pd.read_csv(&quot;name.csv&quot;).
        </p>
      </details>
      {notes.length > 0 && (
        <div className="banner error" role="alert" data-testid="file-notes">
          <span aria-hidden="true">⚠</span>
          <span className="banner-text">
            {notes.map((n, i) => (
              <span key={i} className="file-note">
                {n.text}{' '}
              </span>
            ))}
          </span>
          <button type="button" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
