import { describeStep, eventLabel, stateAt, summaryText } from '@machines/log';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../store';
import { EventList } from './EventList';
import { SummaryText } from './SummaryText';
import { clampStep, endCue, hasLaterOutput, stepForKey } from './steps';
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
  const twoPane = useStore((s) => s.view) === 'two';
  const status = useStore((s) => s.log?.status ?? 'ok');
  const cue = endCue(status, running, max);
  const [announced, setAnnounced] = useState('');
  // The end cue is spoken once per run, with the first update after the run finishes; stepping never repeats it.
  const cueSpokenFor = useRef<unknown>(null);
  const spoken = useMemo(() => summaryText(summary), [summary]);
  useEffect(() => {
    if (running) {
      setAnnounced('');
      return;
    }
    const h = setTimeout(() => {
      if (cue && cueSpokenFor.current !== log) {
        cueSpokenFor.current = log;
        setAnnounced(`The run ${cue}. ${spoken}`);
      } else setAnnounced(spoken);
    }, ANNOUNCE_DELAY_MS);
    return () => clearTimeout(h);
  }, [spoken, running, cue, log]);
  const moreOutput = useMemo(
    () =>
      model && log && !running
        ? hasLaterOutput(
            stateAt(model, log, cur).output.length,
            stateAt(model, log, max).output.length,
          )
        : false,
    [model, log, running, cur, max],
  );
  const text = `Step ${cur} of ${max}`;
  const onKeyDown = (e: KeyboardEvent) => {
    const next = stepForKey(e.nativeEvent, cur, max, { vertical: true });
    if (next === null) return;
    e.preventDefault();
    setStep(next, Math.abs(next - cur) === 1);
  };
  return (
    <div className="timeline">
      <div className="timeline-row">
        <button
          type="button"
          aria-label="Previous step"
          disabled={cur <= 0}
          onClick={() => setStep(cur - 1, true)}
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
          onClick={() => setStep(cur + 1, true)}
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
      {(cue || moreOutput) && (
        <p className="run-cue" data-testid="run-cue">
          {cue && (
            <>
              <span aria-hidden="true">⚠ </span>
              <span data-testid="run-cue-end">The run {cue}.</span>{' '}
              {cur < max && (
                <button type="button" className="cue-jump" onClick={() => setStep(max)}>
                  Jump to step {max}
                </button>
              )}
            </>
          )}
          {cue && moreOutput && ' '}
          {moreOutput && <span data-testid="more-output">More output at later steps.</span>}
        </p>
      )}
      <p className="current-event" data-testid="current-event">
        {event ?? (max > 0 ? 'Before the first step' : 'No steps yet')}
      </p>
      {/* In the two-pane view the sentence sits in the stage header; the live region below stays here. */}
      {!twoPane && (
        <p className="step-summary" data-testid="step-summary">
          <SummaryText parts={summary} />
        </p>
      )}
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
