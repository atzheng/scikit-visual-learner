import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { DiagramPane } from './diagram/DiagramPane';
import { Editor } from './editor/Editor';
import { OutputPane } from './output/OutputPane';
import { LinkBanner, ShareButton, useLoadShareLink } from './share/ShareUI';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const ready = state === 'ready';
  return (
    <header className="toolbar" role="toolbar" aria-label="Actions">
      <h1>Machine Diagrams</h1>
      {running ? (
        <button type="button" className="primary" onClick={stop}>
          Stop
        </button>
      ) : (
        <button type="button" className="primary" onClick={() => void run()} disabled={!ready}>
          Run
        </button>
      )}
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
                // TODO(svl-bwv.2): RuntimeClient.restart()
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

function StatusLine() {
  const { state, progress } = useStore((s) => s.runtime);
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  return (
    <footer className="status" role="status">
      <span>
        {state}: {progress}
      </span>
      {import.meta.env.DEV && (
        <span className={isolated ? 'ok' : 'bad'} data-testid="isolation">
          {isolated ? '✓ crossOriginIsolated' : '✗ NOT crossOriginIsolated'}
        </span>
      )}
    </footer>
  );
}

export function App() {
  const [cols, setCols] = useState(50);
  const [leftRows, setLeftRows] = useState(65);
  const [rightRows, setRightRows] = useState(78);
  const mainRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
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
  const focusEditor = useCallback(() => document.getElementById('pane-editor')?.focus(), []);
  return (
    <div className="app">
      <a className="skip-link" href="#pane-editor" onClick={focusEditor}>
        Skip to code editor
      </a>
      <div className="top">
        <Toolbar />
        <LinkBanner />
      </div>
      <main
        className="panes"
        ref={mainRef}
        style={{ gridTemplateColumns: `${cols}fr 6px ${100 - cols}fr` }}
      >
        <section
          className="column"
          ref={leftRef}
          style={{ gridTemplateRows: `${leftRows}fr 6px ${100 - leftRows}fr` }}
        >
          <div id="pane-editor" className="pane" tabIndex={-1} aria-label="Code editor">
            <Editor />
          </div>
          <Splitter
            orientation="horizontal"
            label="Resize editor and output"
            value={leftRows}
            onChange={setLeftRows}
            containerRef={leftRef}
          />
          <div className="pane">
            <OutputPane />
          </div>
        </section>
        <Splitter
          orientation="vertical"
          label="Resize code and diagram"
          value={cols}
          onChange={setCols}
          containerRef={mainRef}
        />
        <section
          className="column"
          ref={rightRef}
          style={{ gridTemplateRows: `${rightRows}fr 6px ${100 - rightRows}fr` }}
        >
          <div className="pane">
            <DiagramPane />
          </div>
          <Splitter
            orientation="horizontal"
            label="Resize diagram and timeline"
            value={rightRows}
            onChange={setRightRows}
            containerRef={rightRef}
          />
          <div className="pane">
            <Timeline />
          </div>
        </section>
      </main>
      <StatusLine />
    </div>
  );
}
