import type { RunError } from '@machines/log';
import { frameLabel, isSyntaxError, libraryLabel, repeatLabel } from './model';

/** The run's error: message, then student frames (clickable) with library frames folded. */
export function Traceback(props: { error: RunError; onFrame(line: number): void }) {
  const { error, onFrame } = props;
  const syntax = isSyntaxError(error);
  const frames = syntax ? error.traceback.slice(-1) : error.traceback;
  return (
    <section className="out-error" role="alert" aria-label="Error" data-testid="run-error">
      <h2>
        <span aria-hidden="true">✖ </span>
        {syntax ? 'Syntax error' : error.type}
        {error.line !== null && ` on line ${error.line}`}
      </h2>
      <pre className="msg">{syntax ? `${error.type}: ${error.message}` : error.message}</pre>
      {syntax && <p className="muted">Nothing ran. Fix the line and run again.</p>}
      {frames.length > 0 && (
        <ol className="frames" aria-label="Traceback, student code only">
          {frames.map((f, k) =>
            f.kind === 'library' ? (
              <li key={k} className="lib">
                {libraryLabel(f)}
              </li>
            ) : (
              <li key={k}>
                <button
                  type="button"
                  className="frame"
                  onClick={() => onFrame(f.line)}
                  title="Go to this line in the editor"
                >
                  <span className="where">{frameLabel(f)}</span>
                  {f.text && <code>{f.text}</code>}
                  {repeatLabel(f) && <span className="rep">{repeatLabel(f)}</span>}
                </button>
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}
