/** Pure span helpers: Site positions (CONTRACTS.md section 2) to CodeMirror offsets. */

import type { Site } from '@machines/log';

/** The fields of a Site the editor needs. Lines are 1-based, columns 0-based, in code points. */
export type SpanSite = Pick<Site, 'id' | 'kind' | 'line' | 'col' | 'end_line' | 'end_col'>;

export interface OffsetRange {
  from: number;
  to: number;
}

/** UTF-16 offsets of the start of every line (CodeMirror counts UTF-16 units). */
export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (source.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Offset of code-point column `col` on the line starting at `lineStart`, clamped to the line end. */
function advance(source: string, lineStart: number, col: number): number {
  let i = lineStart;
  for (let n = 0; n < col && i < source.length; n++) {
    const c = source.charCodeAt(i);
    if (c === 10 || c === 13) break;
    // A surrogate pair is one code point and two UTF-16 units.
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < source.length ? 2 : 1;
  }
  return i;
}

/** Convert a site to CodeMirror offsets, or null when its lines lie outside the source. */
export function siteRange(
  source: string,
  site: SpanSite,
  starts = lineStarts(source),
): OffsetRange | null {
  const a = starts[site.line - 1];
  const b = starts[site.end_line - 1];
  if (a === undefined || b === undefined) return null;
  const from = advance(source, a, site.col);
  const to = advance(source, b, site.end_col);
  return to < from ? null : { from, to };
}

/** The innermost call site whose span contains `offset` (ends inclusive), or null. */
export function siteAt<S extends SpanSite>(
  sites: readonly S[],
  offset: number,
  source: string,
): S | null {
  const starts = lineStarts(source);
  let best: S | null = null;
  let bestLen = Infinity;
  for (const site of sites) {
    if (site.kind !== 'call') continue;
    const r = siteRange(source, site, starts);
    if (!r || offset < r.from || offset > r.to) continue;
    const len = r.to - r.from;
    if (len < bestLen) {
      best = site;
      bestLen = len;
    }
  }
  return best;
}

/**
 * Site positions refer to the source at Run time. They are valid only while the document is still
 * exactly that source; after any edit they would point at the wrong code, so they are dropped.
 */
export function sitesValid(runSource: string | undefined, doc: string): boolean {
  return runSource !== undefined && runSource === doc;
}
