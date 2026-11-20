/** Pure text for the timeline's step counter: the position inside the current source line, with the overall step kept secondary. */
import { lineStageAt, type EventLog, type GraphModel } from '@machines/log';

export interface StepCounter {
  /** Primary text: "Start", "Line 9", "Line 9 · call 2 of 4", "Line 9 · step 2 of 3". */
  primary: string;
  /** Secondary text: the overall step, "11/16". */
  overall: string;
  /** Screen reader text: the primary text plus the overall step, "Line 9, call 2 of 4, step 11 of 16". */
  spoken: string;
  /** Position within the line group (1-based) and the group's size; 0 and 0 when there is no group. */
  inLine: number;
  lineTotal: number;
}

/**
 * Wording: a line group is the run of consecutive steps that share a source line (`lineStageAt`). A group of one
 * reads "Line N". A group of several reads "Line N · call k of n" when every step shown so far is a call; if it
 * mixes kinds (a call with a store or an expression), it counts "step k of n", because not every step is a call.
 * Steps with no line read "Step k". Step 0 reads "Start". The last step is still its line's step, so there is no
 * "End" wording (the run cue announces the end).
 */
export function stepCounter(
  model: GraphModel | null,
  log: EventLog | null,
  step: number,
  max: number,
): StepCounter {
  const overall = `${step}/${max}`;
  const whole = `step ${step} of ${max}`;
  if (!model || !log || max === 0)
    return { primary: 'No steps', overall: '', spoken: 'No steps', inLine: 0, lineTotal: 0 };
  if (step <= 0)
    return { primary: 'Start', overall, spoken: `Start, ${whole}`, inLine: 0, lineTotal: 0 };
  const here = lineStageAt(model, log, step);
  if (!here) return { primary: `Step ${step}`, overall, spoken: whole, inLine: 1, lineTotal: 1 };
  // the group's size: walk forward while the next step still belongs to the same group
  const k = here.calls.length;
  let total = k;
  for (let s = step + 1; s <= max; s++) {
    const next = lineStageAt(model, log, s);
    if (!next || next.first !== here.first) break;
    total = next.calls.length;
  }
  const line = here.line === null ? `Step ${step}` : `Line ${here.line}`;
  if (total <= 1)
    return { primary: line, overall, spoken: `${line}, ${whole}`, inLine: 1, lineTotal: 1 };
  const full = lineStageAt(model, log, step + (total - k));
  const allCalls = (full ?? here).calls.every((c) => c.stage.kind === 'call');
  const part = `${allCalls ? 'call' : 'step'} ${k} of ${total}`;
  return {
    primary: `${line} · ${part}`,
    overall,
    spoken: `${line}, ${part}, ${whole}`,
    inLine: k,
    lineTotal: total,
  };
}
