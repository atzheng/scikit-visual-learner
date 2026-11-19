/** "Follow the current step" (svl-lo6): which boxes to keep in view, and the view that shows them readably. Pure. */
import type { GraphModel, StepState } from '@machines/log';
import { clampK, fitView, isVisible, type Rect, type Size, type View } from './panzoom';

/** Smallest scale at which box text stays readable; following never zooms out past it. */
export const READABLE_K = 0.8;
const PAD = 24;

/**
 * The boxes to keep in view at a step: the current node, the boxes wired into it or out of it (the visible
 * value wires), and the instance that owns it.
 */
export function followNodes(model: GraphModel, state: StepState): string[] {
  const cur = state.currentNode;
  if (cur === null) return [];
  const ids = new Set<string>([cur]);
  const node = model.nodes.find((n) => n.id === cur);
  if (node?.parent) ids.add(node.parent);
  for (const e of model.edges) {
    if (!state.visibleEdges.has(e.id)) continue;
    if (e.to.node === cur) ids.add(e.from.node);
    else if (e.from.node === cur) ids.add(e.to.node);
  }
  return [...ids];
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The view while following. When the whole diagram fits at a readable scale, that fit is the view (nothing
 * to follow). Otherwise the scale is the largest up to 1:1 that shows `focus`, but never below READABLE_K,
 * and the view only moves when the focus is not already fully on screen at a readable scale. Without a
 * focus (no step yet) the top of the diagram is shown at a readable scale. `anchor` is the running box:
 * when the focus is too big for the viewport at a readable scale, it is the one kept in the middle.
 */
export function followView(
  view: View,
  focus: Rect | null,
  anchor: Rect | null,
  content: Size,
  viewport: Size,
): View {
  const fit = fitView(content, viewport);
  if (fit.k >= READABLE_K || viewport.w <= 0 || viewport.h <= 0) return fit;
  if (focus === null) return { k: READABLE_K, x: PAD, y: PAD };
  const readable = view.k >= READABLE_K && view.k <= 1.25;
  if (readable && isVisible(view, focus, viewport, 12)) return view;
  const kFocus = Math.min(
    (viewport.w - 2 * PAD) / Math.max(1, focus.w),
    (viewport.h - 2 * PAD) / Math.max(1, focus.h),
  );
  const k = clampK(Math.min(1, Math.max(READABLE_K, kFocus)));
  const tooBig = focus.w * k > viewport.w - 2 * PAD || focus.h * k > viewport.h - 2 * PAD;
  const r = tooBig ? (anchor ?? focus) : focus;
  return { k, x: viewport.w / 2 - (r.x + r.w / 2) * k, y: viewport.h / 2 - (r.y + r.h / 2) * k };
}
