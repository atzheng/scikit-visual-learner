/** Status-line text for the runtime (pure, so it is testable). */
import type { ProgressMessage } from './client';

export function progressText(p: ProgressMessage): string {
  const n = p.total > 1 ? ` (${p.done}/${p.total})` : '';
  switch (p.phase) {
    case 'pyodide':
      return 'Loading Python…';
    case 'packages':
      return `Loading numpy, pandas, scikit-learn${n}…`;
    case 'recorder':
      return 'Installing the recorder…';
    case 'matplotlib': // posted during a run: 0/1 while the wheels load, 1/1 when they are in
      return p.done < p.total ? 'Loading matplotlib…' : 'Running…';
    case 'datasets':
      return `Loading datasets${n}…`;
  }
}

/** True for Pyodide's "Loading a, b, c" message when matplotlib is among the packages (direct or indirect import). */
export function loadsMatplotlib(message: string): boolean {
  return /^Loading\b.*\bmatplotlib\b/.test(message);
}

export function versionsText(v: Record<string, string>): string {
  const parts = [
    v.python && `Python ${v.python}`,
    v.numpy && `numpy ${v.numpy}`,
    v.pandas && `pandas ${v.pandas}`,
    v.sklearn && `scikit-learn ${v.sklearn}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** The toolbar's elapsed counter appears after 2 s. */
export function elapsedLabel(ms: number): string | null {
  return ms >= 2000 ? `${Math.floor(ms / 1000)} s` : null;
}
