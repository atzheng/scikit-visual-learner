/** Pure pan/zoom maths for the diagram viewport. A view maps diagram point p to screen p * k + (x, y). */
export interface View {
  x: number;
  y: number;
  k: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_K = 0.05;
export const MAX_K = 4;

export const clampK = (k: number): number => Math.min(MAX_K, Math.max(MIN_K, k));

/** Zoom by `factor` keeping the screen point (px, py) fixed. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const k = clampK(v.k * factor);
  const f = k / v.k;
  return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { ...v, x: v.x + dx, y: v.y + dy };
}

/** Scale to fit the content (never magnifying past 1:1), centred in the viewport with `pad` around it. */
export function fitView(content: Size, viewport: Size, pad = 16): View {
  if (content.w <= 0 || content.h <= 0 || viewport.w <= 0 || viewport.h <= 0)
    return { x: 0, y: 0, k: 1 };
  const k = clampK(
    Math.min(1, (viewport.w - 2 * pad) / content.w, (viewport.h - 2 * pad) / content.h),
  );
  return {
    k,
    x: (viewport.w - content.w * k) / 2,
    y: Math.max(pad, (viewport.h - content.h * k) / 2),
  };
}

/** Pan (keeping the zoom) so the rectangle is centred. */
export function centerOn(v: View, r: Rect, viewport: Size): View {
  return {
    k: v.k,
    x: viewport.w / 2 - (r.x + r.w / 2) * v.k,
    y: viewport.h / 2 - (r.y + r.h / 2) * v.k,
  };
}

/** True when the whole rectangle lies inside the viewport, `margin` px in. */
export function isVisible(v: View, r: Rect, viewport: Size, margin = 8): boolean {
  return (
    r.x * v.k + v.x >= margin &&
    r.y * v.k + v.y >= margin &&
    (r.x + r.w) * v.k + v.x <= viewport.w - margin &&
    (r.y + r.h) * v.k + v.y <= viewport.h - margin
  );
}

/** Keep the rectangle on screen: unchanged when it is visible, else centred. */
export function ensureVisible(v: View, r: Rect, viewport: Size): View {
  return isVisible(v, r, viewport) ? v : centerOn(v, r, viewport);
}
