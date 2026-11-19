import { describeStep, eventLabel, summaryText } from '@machines/log';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useStore } from '../store';
import { EventList } from './EventList';
import { SummaryText } from './SummaryText';
import { clampStep, stepForKey } from './steps';
import './timeline.css';

const ANNOUNCE_DELAY_MS = 300;

/** Slider over steps 0..N with prev/next, a "k of n" label and a collapsible event list. */
export function Timeline() {
  const model = useStore((s) => s.model);
  const log = useStore((s) => s.log);
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const [listOpen, setListOpen] = useState(false);
  const max = model?.steps.length ?? 0;
  const cur = clampStep(step, max);
  const event = model && log && cur > 0 ? eventLabel(log, model.steps[cur - 1]!) : null;
  const summary = useMemo(
    () => (model && log ? describeStep(model, log, cur) : []),
    [model, log, cur],
  );
  const running = useStore((s) => s.running);
  const [announced, setAnnounced] = useState('');
  const spoken = useMemo(() => summaryText(summary), [summary]);
  useEffect(() => {
    if (running) {
      setAnnounced('');
      return;
    }
    const h = setTimeout(() => setAnnounced(spoken), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(h);
  }, [spoken, running]);
  const text = `Step ${cur} of ${max}`;
  const onKeyDown = (e: KeyboardEvent) => {
    const next = stepForKey(e.nativeEvent, cur, max, { vertical: true });
    if (next === null) return;
    e.preventDefault();
    setStep(next);
  };
  return (
    <div className="timeline">
      <div className="timeline-row">
        <button
          type="button"
          aria-label="Previous step"
          disabled={cur <= 0}
          onClick={() => setStep(cur - 1)}
        >
          ◀
        </button>
        <label htmlFor="timeline-slider" className="visually-hidden">
          Step
        </label>
        <input
          id="timeline-slider"
          type="range"
          min={0}
          max={max}
          step={1}
          value={cur}
          disabled={max === 0}
          aria-valuetext={event ? `${text}: ${event}` : text}
          onChange={(e) => setStep(Number(e.target.value))}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          aria-label="Next step"
          disabled={cur >= max}
          onClick={() => setStep(cur + 1)}
        >
          ▶
        </button>
        <output className="step-label" htmlFor="timeline-slider">
          {cur} of {max}
        </output>
        <button
          type="button"
          aria-expanded={listOpen}
          aria-controls="event-list-region"
          onClick={() => setListOpen((o) => !o)}
        >
          {listOpen ? 'Hide event list' : 'Event list'}
        </button>
      </div>
      <p className="current-event" data-testid="current-event">
        {event ?? (max > 0 ? 'Before the first step' : 'No steps yet')}
      </p>
      <p className="step-summary" data-testid="step-summary">
        <SummaryText parts={summary} />
      </p>
      {/* The visible sentence is instant; what a screen reader hears waits for the step to settle (a slider drag does not spam) and stays silent while a run streams. */}
      <p
        className="visually-hidden"
        data-testid="step-summary-live"
        aria-live="polite"
        aria-atomic="true"
      >
        {announced}
      </p>
      <div id="event-list-region" hidden={!listOpen}>
        {listOpen && <EventList />}
      </div>
    </div>
  );
}
