import type { PlanWire, StagePlan } from '@machines/render';

/** The two views of the diagram pane: shelf and stage (default), or the whole diagram. */
export type DiagramView = 'two' | 'full';

const VIEW_KEY = 'machines.view';
export function readView(): DiagramView {
  try {
    return globalThis.localStorage?.getItem(VIEW_KEY) === 'full' ? 'full' : 'two';
  } catch {
    return 'two';
  }
}
export function writeView(v: DiagramView): void {
  try {
    globalThis.localStorage?.setItem(VIEW_KEY, v);
  } catch {
    // storage denied: the two-pane view is the default next time
  }
}

/** Distance from (x, y) to the polyline `pts`. */
export function distToPolyline(pts: [number, number][], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[i + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

/** The data wire (not the owner line) of the stage nearest to a canvas point, within `tol` px. */
export function nearestWire(
  plan: StagePlan | null,
  x: number,
  y: number,
  tol = 7,
): PlanWire | null {
  let best: PlanWire | null = null;
  let bd = tol;
  for (const w of plan?.wires ?? []) {
    if (w.edge === null) continue;
    const d = distToPolyline(w.points, x, y);
    if (d <= bd) {
      best = w;
      bd = d;
    }
  }
  return best;
}

/** A client point in plan coordinates, for a canvas zoomed by `k` whose top left is at `origin`. */
export function canvasPoint(
  clientX: number,
  clientY: number,
  origin: { left: number; top: number },
  k: number,
): { x: number; y: number } {
  return { x: (clientX - origin.left) / k, y: (clientY - origin.top) / k };
}
