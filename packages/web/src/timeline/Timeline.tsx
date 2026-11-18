import { useStore } from '../store';
import { EventList } from './EventList';

/** Placeholder: step slider. The real one has steps.length as max (section 8). */
export function Timeline() {
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  return (
    <div className="timeline">
      <label htmlFor="timeline-slider">Step</label>
      <input
        id="timeline-slider"
        type="range"
        min={0}
        max={0}
        value={step}
        onChange={(e) => setStep(Number(e.target.value))}
        disabled
      />
      <span>{step} / 0</span>
      <EventList />
    </div>
  );
}
