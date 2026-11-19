// Pure logic of the inspect UI (SPEC "User experience" 5): popover placement, what a value summary says
// about itself, and the attribute rows of the instance panel. No React, no DOM.
import { attrRows, reprTruncated, sameValue } from '@machines/log';
import type {
  AttrRow,
  EventLog,
  GraphModel,
  InstanceNode,
  StepState,
  Token,
  ValueSummary,
} from '@machines/log';

export interface Size {
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}

/**
 * Top-left corner for a popover of `size` next to the pointer `at`, in viewport coordinates. It sits
 * below and right of the point; when that would leave the viewport it flips to the other side, and as a
 * last resort it is clamped, so it never leaves the viewport (unless it is larger than the viewport,
 * when its top-left corner stays visible).
 */
export function placePopover(at: Pt, size: Size, viewport: Size, gap = 12, margin = 8): Pt {
  const place = (p: number, len: number, room: number): number => {
    let v = p + gap;
    if (v + len > room - margin) v = p - gap - len;
    return Math.max(margin, Math.min(v, room - margin - len));
  };
  return { x: place(at.x, size.w, viewport.w), y: place(at.y, size.h, viewport.h) };
}

/** The first line of a preview: the type, and the shape when there is one ("DF (150 × 4)"). */
export function summaryTitle(v: ValueSummary | undefined): string {
  if (!v) return 'value unavailable';
  const shape = v.shape ? ` (${v.shape.join(' × ')})` : '';
  return `${v.type}${shape}`;
}

/** Secondary facts: the dtype, or the DataFrame's dtype when all columns share one. */
export function summaryDetail(v: ValueSummary): string | null {
  if (v.dtype) return `dtype ${v.dtype}`;
  if (v.dtypes && v.dtypes.length > 0 && new Set(v.dtypes).size === 1)
    return `all columns ${v.dtypes[0]}`;
  return null;
}

/** True when a table or matrix could have been shown but the 1 MB preview budget was spent. */
export function previewOmitted(v: ValueSummary): boolean {
  return v.preview === undefined && (v.shape !== undefined || v.columns !== undefined);
}

/** What the preview's size cap hid (5 rows, 8 or 5 columns), as text; null when nothing is hidden. */
export function truncationNote(v: ValueSummary): string | null {
  const p = v.preview;
  if (!p || !v.shape) return null;
  if (p.kind === 'matrix' && v.shape.length === 1) {
    const shown = p.rows[0]?.length ?? 0;
    return v.shape[0]! > shown ? `first ${shown} of ${v.shape[0]} values` : null;
  }
  const rows = v.shape[0] ?? 0;
  const cols = p.kind === 'table' ? p.columns.length : (p.rows[0]?.length ?? 0);
  const fullCols = v.shape.length > 1 ? v.shape[1]! : (v.columns?.length ?? cols);
  const parts: string[] = [];
  if (rows > p.rows.length) parts.push(`first ${p.rows.length} of ${rows} rows`);
  if (fullCols > cols) parts.push(`first ${cols} of ${fullCols} columns`);
  return parts.length ? parts.join(', ') : null;
}

/** The token a wire carries at this step: the active one, else the latest use. */
export function edgeToken(
  model: GraphModel,
  state: StepState | null,
  edgeId: string,
): Token | null {
  const active = state?.activeToken.get(edgeId);
  if (active) return active;
  const e = model.edges.find((x) => x.id === edgeId);
  if (!e) return null;
  return e.chip?.token ?? e.uses[e.uses.length - 1]?.token ?? null;
}

// The changed-attribute rule lives in @machines/log, shared with the step summary (describeStep).
export { attrRows, reprTruncated, sameValue };
export type { AttrRow };

/** One line for an attribute value in the panel. */
export function valueLine(v: ValueSummary | undefined): string {
  if (!v) return '—';
  if (v.repr !== undefined && v.shape === undefined) return v.repr;
  return summaryTitle(v);
}

export interface InspectTarget {
  node: InstanceNode;
  /** The step is a method call on this instance: the panel compares before and after it. */
  call: boolean;
  before: Record<string, Token>;
  after: Record<string, Token>;
}

/**
 * Which instance the side panel shows, if any: the selected instance box, or the instance a method call
 * at the current step belongs to. At a call step the attributes are those around the call; otherwise
 * (a box was clicked but the step is elsewhere) the instance's attributes as of the step, unchanged.
 */
export function inspectTarget(
  model: GraphModel,
  log: EventLog,
  state: StepState,
  selectedNode: string | undefined,
): InspectTarget | null {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const instanceOf = (id: string | null | undefined): InstanceNode | null => {
    let n = id ? byId.get(id) : undefined;
    if (n && n.kind !== 'instance' && n.parent) n = byId.get(n.parent);
    return n?.kind === 'instance' ? n : null;
  };
  const stepped = state.attrsAfter !== undefined ? instanceOf(state.currentNode) : null;
  // A new object at this step (not a mutation of an earlier one): its attributes are not a change.
  const isNew =
    stepped !== null && stepped.versions.some((v) => v.i === state.current && v.kind === 'new');
  const selected = instanceOf(selectedNode);
  if (stepped && state.attrsAfter && isNew) {
    return { node: stepped, call: false, before: state.attrsAfter, after: state.attrsAfter };
  }
  if (stepped && state.attrsAfter && (!selected || selected.id === stepped.id)) {
    return { node: stepped, call: true, before: state.attrsBefore ?? {}, after: state.attrsAfter };
  }
  const node = selected ?? stepped;
  if (!node) return null;
  const tok = state.activeVersion.get(node.id);
  const attrs = (tok !== undefined ? log.values[tok]?.attrs : undefined) ?? {};
  return { node, call: false, before: attrs, after: attrs };
}
