/** Status banners for runs that did not finish normally (pure). SPEC "Hard limits". */
import type { EventLog, RunStatus } from '@machines/log';

export function runBanner(status: RunStatus, interrupted: boolean): string | null {
  const upTo = interrupted
    ? 'The diagram shows everything up to the call that was running.'
    : 'The diagram shows everything that ran before that.';
  switch (status) {
    case 'limit':
      return `The run hit the event limit and was stopped. ${upTo} Use a smaller dataset or fewer loop iterations.`;
    case 'timeout':
      return `The run hit the time limit and was stopped. ${upTo} Check for an endless loop or a very large dataset.`;
    case 'stopped':
      return `You stopped the run. ${upTo}`;
    default:
      return null;
  }
}

export function bannerForLog(log: EventLog): string | null {
  return runBanner(
    log.status,
    log.events.some((e) => e.interrupted),
  );
}

export function tooManyMessage(t: { shown: number; total: number; line: number }): string {
  return `Showing the first ${t.shown} boxes (up to line ${t.line}). This program makes ${t.total}. Narrow the code (fewer calls, or a smaller loop body) to see the rest.`;
}
