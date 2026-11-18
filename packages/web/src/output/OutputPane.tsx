import { Traceback } from './Traceback';

/** Placeholder: print output and figures, tagged by event. */
export function OutputPane() {
  return (
    <div className="output" tabIndex={0} role="region" aria-label="Output">
      <p className="muted">Output appears here.</p>
      <Traceback />
    </div>
  );
}
