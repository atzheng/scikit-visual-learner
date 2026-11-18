import type { AppState } from '../store';

export type Origin = AppState['origin'];

/**
 * Origin transitions for link code (CONTRACTS.md 10.14). Only 'link' moves: it becomes 'edited'
 * on the first change to the source or the first Run. Other origins are left to their owners.
 */
export function nextOrigin(
  origin: Origin,
  s: { source: string; linkSource: string | null; running: boolean },
): Origin {
  if (origin !== 'link') return origin;
  if (s.running || (s.linkSource !== null && s.source !== s.linkSource)) return 'edited';
  return origin;
}

/** True when replacing the editor from a new link would throw away work. */
export function hasUnsavedWork(s: {
  origin: Origin;
  running: boolean;
  source: string;
  baseline: string;
}): boolean {
  if (s.running || s.origin === 'edited') return true;
  return s.origin !== 'link' && s.source !== s.baseline;
}
