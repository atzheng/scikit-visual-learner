// Attribute comparison shared by the inspect panel (packages/web/src/inspect) and the step summary
// (describe.ts): one rule for "this attribute changed", so the two never disagree.
import type { Token, ValueSummary } from './types';

export interface AttrRow {
  name: string;
  before: Token | null;
  after: Token | null;
  /** The attribute was added, removed, or holds a different value after the call. */
  changed: boolean;
}

/**
 * Whether a recorded repr may be cut short. The recorder's `repr` is `reprlib.repr` (which marks what it
 * drops with `...`: long containers, strings, ints) clipped to 40 characters with a final `…`
 * (python/machines/values.py `_repr`, `_clip`). Those marks are the only signal there is.
 */
export function reprTruncated(repr: string | undefined): boolean {
  return repr === undefined || repr.includes('...') || repr.includes('…');
}

/**
 * Whether two attribute tokens hold the same value. An object token names a version of the object, so the
 * same token means unchanged and any other means it was changed (or replaced). A scalar token (`s...`) is
 * minted per observation, so two of them are the same when type and repr agree and neither repr is
 * truncated; otherwise the tokens decide, and a mismatch shows as changed (a real change is never hidden).
 */
export function sameValue(
  a: Token | null,
  b: Token | null,
  values: Record<Token, ValueSummary>,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const x = values[a];
  const y = values[b];
  if (!a.startsWith('s') || !b.startsWith('s') || !x || !y) return false;
  if (reprTruncated(x.repr) || reprTruncated(y.repr)) return false;
  return x.type === y.type && x.repr === y.repr;
}

/** Attribute rows for the panel: every attribute before or after, the changed ones first. */
export function attrRows(
  before: Record<string, Token> | undefined,
  after: Record<string, Token> | undefined,
  values: Record<Token, ValueSummary> = {},
): AttrRow[] {
  const b = before ?? {};
  const a = after ?? {};
  const names = [...Object.keys(a), ...Object.keys(b).filter((n) => !(n in a))];
  const rows = names.map((name): AttrRow => {
    const bt = name in b ? b[name]! : null;
    const at = name in a ? a[name]! : null;
    return { name, before: bt, after: at, changed: !sameValue(bt, at, values) };
  });
  return [...rows.filter((r) => r.changed), ...rows.filter((r) => !r.changed)];
}
