/** Pure view-model logic for the output pane (no React, no DOM). SPEC "User experience" 7-8. */
import type { EventLog, OutputEntry, RunError, TracebackFrame } from '@machines/log';

export type OutputItem =
  | { kind: 'stdout' | 'stderr'; text: string; i: number }
  | { kind: 'warning'; line: number | null; category: string; message: string; i: number }
  | { kind: 'figure'; png: string; width: number; height: number; n: number; i: number };

/** Warnings arrive as "<line>: <Category>: <message>" (CONTRACTS section 2). */
export function parseWarning(text: string): {
  line: number | null;
  category: string;
  message: string;
} {
  const m = /^(?:(\d+): )?([A-Za-z_][\w.]*(?:Warning|Error)): ([\s\S]*)$/.exec(text);
  if (m) return { line: m[1] ? Number(m[1]) : null, category: m[2]!, message: m[3]! };
  const l = /^(\d+): ([\s\S]*)$/.exec(text);
  if (l) return { line: Number(l[1]), category: 'Warning', message: l[2]! };
  return { line: null, category: 'Warning', message: text };
}

/** Entries as display items: consecutive stdout (or stderr) chunks merge into one block. */
export function outputItems(entries: readonly OutputEntry[]): OutputItem[] {
  const out: OutputItem[] = [];
  let figures = 0;
  for (const e of entries) {
    if (e.stream === 'figure') {
      out.push({
        kind: 'figure',
        png: e.png,
        width: e.width,
        height: e.height,
        n: ++figures,
        i: e.i,
      });
    } else if (e.stream === 'warning') {
      out.push({ kind: 'warning', ...parseWarning(e.text), i: e.i });
    } else {
      const last = out[out.length - 1];
      if (last && last.kind === e.stream) last.text += e.text;
      else out.push({ kind: e.stream, text: e.text, i: e.i });
    }
  }
  return out;
}

export function isSyntaxError(err: RunError): boolean {
  return /^(Syntax|Indentation|Tab)Error$/.test(err.type);
}

/** "… 3 frames in pandas, sklearn" for a folded library run. */
export function libraryLabel(f: Extract<TracebackFrame, { kind: 'library' }>): string {
  const n = f.count === 1 ? '1 frame' : `${f.count} frames`;
  return `… ${n}${f.modules.length ? ` in ${f.modules.join(', ')}` : ''}`;
}

export function frameLabel(f: Extract<TracebackFrame, { kind: 'student' }>): string {
  return `line ${f.line}${f.name && f.name !== '<module>' ? ` in ${f.name}` : ''}`;
}

export function repeatLabel(f: Extract<TracebackFrame, { kind: 'student' }>): string | null {
  return f.repeat && f.repeat > 1 ? `repeated ${f.repeat} times` : null;
}

export interface HandledError {
  i: number;
  line: number;
  type: string;
  message: string;
}

/** Exceptions the program caught itself: listed, but they are not the run's error. */
export function handledErrors(log: EventLog): HandledError[] {
  const out: HandledError[] = [];
  for (const e of log.events) {
    if (!e.error?.handled) continue;
    out.push({
      i: e.i,
      line: log.sites[e.site]?.line ?? 0,
      type: e.error.type,
      message: e.error.message,
    });
  }
  return out;
}

/** What to say for a run that did not finish normally (SPEC "Hard limits"). */
export function statusBanner(log: EventLog, elapsedMs: number): string | null {
  const interrupted = log.events.some((e) => e.interrupted);
  const upTo = interrupted
    ? 'The diagram shows everything up to the call that was running.'
    : 'The diagram shows everything that ran before that.';
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  switch (log.status) {
    case 'limit':
      return `The run hit the event limit and was stopped. ${upTo} Use a smaller dataset or fewer loop iterations.`;
    case 'timeout':
      return `Stopped after ${secs} s (time limit). ${upTo} Check for an endless loop or a very large dataset.`;
    case 'stopped':
      return `You stopped the run. ${upTo}`;
    default:
      return null;
  }
}
