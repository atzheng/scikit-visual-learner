import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { FileList, UploadButton, useDropUpload } from './files/FilesUI';
import { AutosaveNotice } from './storage/notice';
import { DiagramPane } from './diagram/DiagramPane';
import { InstanceDiff } from './inspect/InstanceDiff';
import { useEdgeInspect } from './inspect/Preview';
import { Editor, type EditorController } from './editor/Editor';
import { useStepHighlight } from './editor/useStepHighlight';
import { OutputPane } from './output/OutputPane';
import { LinkBanner, ShareButton, useLoadShareLink } from './share/ShareUI';
import { elapsedLabel } from './runtime/status';
import { useStore } from './store';
import { Timeline } from './timeline/Timeline';

/** A draggable, keyboard-operable separator. `value` is the first pane's share in percent. */
function Splitter(props: {
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  onChange(v: number): void;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const { orientation, label, value, onChange, containerRef } = props;
  const clamp = (v: number) => Math.min(80, Math.max(20, v));
  const onPointerMove = (e: PointerEvent) => {
    const el = containerRef.current;
    if (!el || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = el.getBoundingClientRect();
    const pct =
      orientation === 'vertical'
        ? ((e.clientX - r.left) / r.width) * 100
        : ((e.clientY - r.top) / r.height) * 100;
    onChange(clamp(pct));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const dec = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const inc = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) onChange(clamp(value - 2));
    else if (e.key === inc) onChange(clamp(value + 2));
    else return;
    e.preventDefault();
  };
  return (
    <div
      className={`splitter ${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
    />
  );
}

function Toolbar() {
  const running = useStore((s) => s.running);
  const state = useStore((s) => s.runtime.state);
  const run = useStore((s) => s.run);
  const stop = useStore((s) => s.stop);
  const restart = useStore((s) => s.restart);
  const elapsed = elapsedLabel(useStore((s) => s.elapsedMs));
  const [menuOpen, setMenuOpen] = useState(false);
  const ready = state === 'ready';
  return (
    <header className="toolbar" role="toolbar" aria-label="Actions">
      <h1>Code Diagrams</h1>
      {running ? (
        <button type="button" className="primary" onClick={stop}>
          Stop
        </button>
      ) : (
        <button type="button" className="primary" onClick={() => void run()} disabled={!ready}>
          Run
        </button>
      )}
      {running && elapsed && (
        <span className="elapsed" role="timer" aria-label={`Running for ${elapsed}`}>
          {elapsed}
        </span>
      )}
      <UploadButton />
      <ShareButton />
      <div className="menu">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          onKeyDown={(e) => e.key === 'Escape' && setMenuOpen(false)}
        >
          Menu
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="menu-list"
            onKeyDown={(e) => e.key === 'Escape' && setMenuOpen(false)}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void restart();
              }}
            >
              Restart Python
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

const ISOLATION_HELP =
  'This page is not cross-origin isolated, so Stop and the time limit cannot interrupt Python in place. They restart Python instead, which takes several seconds, and a program that is stopped shows no unfinished call.';

/** Large, obvious indicator over the diagram area while Python loads or restarts. */
function LoadingOverlay() {
  const { state, progress, failed = false } = useStore((s) => s.runtime);
  if (state !== 'loading' && state !== 'restarting') return null;
  const title = failed
    ? 'Python could not load'
    : state === 'restarting'
      ? 'Restarting Python…'
      : 'Loading Python…';
  return (
    <div className="loading-overlay" role="status" aria-busy={!failed} data-testid="loading">
      <div className="loading-card">
        {!failed && <div className="spinner" aria-hidden="true" />}
        <p className="loading-title">{title}</p>
        {progress !== title && <p className="loading-phase">{progress}</p>}
      </div>
    </div>
  );
}

function StatusLine() {
  const { state, progress } = useStore((s) => s.runtime);
  // While the loading overlay is up it is the announcer; the footer would repeat it.
  const overlayUp = state === 'loading' || state === 'restarting';
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  return (
    <footer className="status" role={overlayUp ? undefined : 'status'}>
      <span>
        {state}: {progress}
      </span>
      {isolated ? (
        import.meta.env.DEV && (
          <span className="ok" data-testid="isolation">
            ✓ crossOriginIsolated
          </span>
        )
      ) : (
        <span
          className="bad"
          data-testid="isolation"
          tabIndex={0}
          title={ISOLATION_HELP}
          aria-description={ISOLATION_HELP}
        >
          ⚠ Stop restarts Python (page not isolated)
        </span>
      )}
    </footer>
  );
}

export function App() {
  const [cols, setCols] = useState(35);
  const [leftRows, setLeftRows] = useState(65);
  const mainRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLElement>(null);
  const editorRef = useRef<EditorController | null>(null);
  const [cursorSite, setCursorSite] = useState<number | null>(null);
  const edgeInspect = useEdgeInspect();
  const sites = useStore((s) => s.log?.sites);
  const runSource = useStore((s) => s.runSource);
  useStepHighlight(editorRef);
  // While running, Esc anywhere on the page stops the run.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useStore.getState();
      if (s.running) s.stop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useLoadShareLink();
  useDropUpload();
  const focusEditor = useCallback(() => document.getElementById('pane-editor')?.focus(), []);
  return (
    <div className="app">
      <a className="skip-link" href="#pane-editor" onClick={focusEditor}>
        Skip to code editor
      </a>
      <div className="top">
        <Toolbar />
        <LinkBanner />
        <FileList />
        <AutosaveNotice />
      </div>
      <main
        className="panes"
        ref={mainRef}
        style={{ gridTemplateColumns: `${cols}fr 6px ${100 - cols}fr` }}
      >
        <section
          className="column"
          ref={leftRef}
          style={{ gridTemplateRows: `auto ${leftRows}fr 6px ${100 - leftRows}fr` }}
        >
          <div className="pane pane-timeline primary-input">
            <h2 className="input-label">Step through</h2>
            <Timeline />
          </div>
          <div
            id="pane-editor"
            className="pane primary-input editor-pane"
            tabIndex={-1}
            aria-label="Code editor"
          >
            <h2 className="input-label" aria-hidden="true">
              Your code
            </h2>
            <Editor
              sites={sites}
              runSource={runSource ?? undefined}
              onSiteAtCursor={(site) => setCursorSite(site ? site.id : null)}
              controllerRef={editorRef}
            />
          </div>
          <Splitter
            orientation="horizontal"
            label="Resize editor and output"
            value={leftRows}
            onChange={setLeftRows}
            containerRef={leftRef}
          />
          <div className="pane">
            <OutputPane editor={editorRef} />
          </div>
        </section>
        <Splitter
          orientation="vertical"
          label="Resize code and diagram"
          value={cols}
          onChange={setCols}
          containerRef={mainRef}
        />
        <section className="column" style={{ gridTemplateRows: 'minmax(0, 1fr)' }}>
          <div className="pane pane-diagram">
            <LoadingOverlay />
            <DiagramPane
              cursorSite={cursorSite}
              onHoverEdge={edgeInspect.onHover}
              onClickEdge={edgeInspect.onClick}
            >
              <InstanceDiff />
            </DiagramPane>
            {edgeInspect.popover}
          </div>
        </section>
      </main>
      <StatusLine />
    </div>
  );
}
