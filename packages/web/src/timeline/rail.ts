/** Pure logic for the code-gutter timeline rail: line -> steps mapping, collapse rule, dot states. */
import type { EventLog, GraphModel } from '@machines/log';
import { eventSiteId } from './steps';

/** More executions of one line than this collapse to a "×n" chip. */
export const MAX_RAIL_DOTS = 8;

/** 1-based source line -> the steps (1-based, ascending) whose event is a call on that line. */
export function stepsByLine(model: GraphModel, log: EventLog): Map<number, number[]> {
  const out = new Map<number, number[]>();
  model.steps.forEach((ev, k) => {
    const site = eventSiteId(log, ev);
    const line = site === null ? undefined : log.sites[site]?.line;
    if (line === undefined) return;
    const a = out.get(line);
    if (a) a.push(k + 1);
    else out.set(line, [k + 1]);
  });
  return out;
}

/** ran = before the playhead (filled), current (ringed), pending = not yet reached (hollow). */
export type DotState = 'ran' | 'current' | 'pending';

export function dotState(step: number, cur: number): DotState {
  return step < cur ? 'ran' : step === cur ? 'current' : 'pending';
}

export type RailCell =
  | { mode: 'dots'; dots: { step: number; state: DotState }[] }
  | {
      mode: 'chip';
      n: number;
      /** 1-based position of the current step among this line's steps, or null when elsewhere. */
      k: number | null;
    };

/** What one line shows for the steps it ran at, given the current step. */
export function railCell(steps: readonly number[], cur: number, max = MAX_RAIL_DOTS): RailCell {
  if (steps.length <= max)
    return { mode: 'dots', dots: steps.map((step) => ({ step, state: dotState(step, cur) })) };
  const idx = steps.indexOf(cur);
  return { mode: 'chip', n: steps.length, k: idx < 0 ? null : idx + 1 };
}

/** Where a chip click goes: the next execution after `cur` on this line, wrapping to the first. */
export function chipTarget(steps: readonly number[], cur: number): number | null {
  if (steps.length === 0) return null;
  return steps.find((s) => s > cur) ?? steps[0]!;
}
