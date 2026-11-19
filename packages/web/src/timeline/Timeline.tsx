import { eventLabel } from '@machines/log';
import { useState, type KeyboardEvent } from 'react';
import { useStore } from '../store';
import { EventList } from './EventList';
import { clampStep, stepForKey } from './steps';
import './timeline.css';

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
      <div id="event-list-region" hidden={!listOpen}>
        {listOpen && <EventList />}
      </div>
    </div>
  );
}
