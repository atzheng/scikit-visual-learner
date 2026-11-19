import { eventLabel } from '@machines/log';
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';
import { clampStep } from './steps';

/** The run's steps as an ordered list a screen reader can walk. Selecting an item sets the step. */
export function EventList() {
  const log = useStore((s) => s.log);
  const model = useStore((s) => s.model);
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const labels = useMemo(
    () => (log && model ? model.steps.map((i) => eventLabel(log, i)) : []),
    [log, model],
  );
  const cur = clampStep(step, labels.length);
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [cur]);
  if (labels.length === 0) return <p className="muted">No steps yet.</p>;
  return (
    <ol className="event-list" aria-label="Events">
      {labels.map((label, k) => (
        <li key={k}>
          <button
            type="button"
            ref={k + 1 === cur ? currentRef : undefined}
            className="event-item"
            aria-current={k + 1 === cur ? 'step' : undefined}
            onClick={() => setStep(k + 1)}
          >
            {label}
          </button>
        </li>
      ))}
    </ol>
  );
}
