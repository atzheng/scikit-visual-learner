import { stateAt } from '@machines/log';
import { useEffect, useMemo, type RefObject } from 'react';
import type { EditorController } from '../editor/Editor';
import { useStore } from '../store';
import { clampStep } from '../timeline/steps';
import './output.css';
import { handledErrors, outputItems, statusBanner } from './model';
import { Traceback } from './Traceback';

/** Print output, warnings, figures, the run's error and status banners (SPEC "User experience" 7-8). */
export function OutputPane(props: { editor: RefObject<EditorController | null> }) {
  const { editor } = props;
  const log = useStore((s) => s.log);
  const model = useStore((s) => s.model);
  const step = useStore((s) => s.step);
  const running = useStore((s) => s.running);
  const elapsedMs = useStore((s) => s.elapsedMs);
  const source = useStore((s) => s.source);
  const runSource = useStore((s) => s.runSource);

  const entries = useMemo(
    () => (log && model ? stateAt(model, log, clampStep(step, model.steps.length)).output : []),
    [log, model, step],
  );
  const items = useMemo(() => outputItems(entries), [entries]);
  const handled = useMemo(() => (log ? handledErrors(log) : []), [log]);

  const error = !running && log?.status === 'error' ? log.error : null;
  const errorLine = error && source === runSource ? error.line : null;
  // The editor marks the failing line; a new run (log back to null) or an edit clears it.
  useEffect(() => {
    editor.current?.markErrorLine(errorLine);
    return () => editor.current?.markErrorLine(null);
  }, [editor, errorLine]);

  const banner = !running && log ? statusBanner(log, elapsedMs) : null;
  const empty = items.length === 0 && !error && !banner && handled.length === 0;

  return (
    <div className="output" tabIndex={0} role="region" aria-label="Output">
      {banner && (
        <p className="out-banner" role="status" data-testid="run-banner">
          <span aria-hidden="true">⚠ </span>
          {banner}
        </p>
      )}
      {items.length > 0 && (
        <div className="out-items" data-testid="output-items">
          {items.map((it, k) => {
            switch (it.kind) {
              case 'stdout':
                return (
                  <pre key={k} className="out-stdout">
                    {it.text}
                  </pre>
                );
              case 'stderr':
                return (
                  <div key={k} className="out-entry stderr">
                    <span className="tag">
                      <span aria-hidden="true">⚑ </span>stderr
                    </span>
                    <pre>{it.text}</pre>
                  </div>
                );
              case 'warning':
                return (
                  <div key={k} className="out-entry warning" role="group" aria-label="Warning">
                    <span className="tag">
                      <span aria-hidden="true">⚠ </span>
                      {it.category}
                      {it.line !== null && ` (line ${it.line})`}
                    </span>
                    <pre>{it.message}</pre>
                  </div>
                );
              case 'figure':
                return (
                  <figure key={k} className="out-figure">
                    <img
                      src={`data:image/png;base64,${it.png}`}
                      width={it.width}
                      height={it.height}
                      alt={it.i >= 0 ? `Figure ${it.n} (event ${it.i})` : `Figure ${it.n}`}
                    />
                    <figcaption>Figure {it.n}</figcaption>
                  </figure>
                );
            }
          })}
        </div>
      )}
      {error && <Traceback error={error} onFrame={(line) => editor.current?.revealLine(line)} />}
      {handled.length > 0 && (
        <section className="out-handled" aria-label="Handled errors" data-testid="handled-errors">
          <h2>
            <span aria-hidden="true">◇ </span>Handled errors (the program caught these)
          </h2>
          <ul>
            {handled.map((h) => (
              <li key={h.i}>
                <strong>{h.type}</strong> at line {h.line}: {h.message.split('\n')[0]}
              </li>
            ))}
          </ul>
        </section>
      )}
      {empty && <p className="muted">Output appears here.</p>}
    </div>
  );
}
