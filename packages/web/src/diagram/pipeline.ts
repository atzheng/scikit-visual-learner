/** Layout scheduling policy (pure, injectable clock): throttle while streaming, skip identical layouts. */
import type { GraphModel } from '@machines/log';
import { longEdgeLoad, tierFor } from '@machines/render';

export type Tier = 0 | 1 | 2;

/** The highest layout tier seen so far in a run (the style must not flip back and forth as it grows). */
export function stickyTier(model: GraphModel, prev: Tier): Tier {
  const t = tierFor(
    longEdgeLoad(
      model.nodes,
      model.edges.map((e) => ({ fromNode: e.from.node, toNode: e.to.node })),
    ),
  );
  return Math.max(prev, t) as Tier;
}

/**
 * A string that changes exactly when the layout would: node, port and edge ids and labels, instance
 * parameters, attribute rows and wire label texts. Execution counts and timeline data are not in it.
 */
export function layoutSignature(
  model: GraphModel,
  attrRows: Record<string, string[]>,
  edgeLabels: Record<string, string>,
): string {
  const nodes = model.nodes.map((n) => {
    switch (n.kind) {
      case 'call':
        return [n.id, 'c', n.parent, n.order, n.name, n.inPorts, n.outPorts];
      case 'instance':
        return [n.id, 'i', n.parent, n.order, n.className, n.varName, n.params];
      case 'expr':
      case 'store':
        return [n.id, n.kind, n.parent, n.order, n.text];
      case 'source':
        return [n.id, 's', n.parent, n.order, n.label];
    }
  });
  const edges = model.edges.map((e) => [e.id, e.from, e.to, e.dashed, e.nameLabel]);
  return JSON.stringify([nodes, edges, attrRows, edgeLabels, model.tooMany ?? 0]);
}

export interface RelayouterOptions<In, Out> {
  signature(input: In): string;
  /** Does the (async) layout. */
  run(input: In): Promise<Out>;
  /** Shows a layout for the input it was computed for (or a later input with the same signature). */
  apply(input: In, out: Out): void;
  onError?(e: unknown): void;
  /** Minimum time between layout starts while streaming. */
  intervalMs: number;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

/**
 * update(input, final) schedules a layout of the newest input: at most one per `intervalMs` while streaming,
 * immediately when `final`. One layout runs at a time; stale results are never shown over a newer one.
 * Inputs with an unchanged signature are applied without a layout.
 */
export class Relayouter<In, Out> {
  private latest: In | null = null;
  private final = false;
  private timer: unknown = null;
  private lastStart = -Infinity;
  private busy = false;
  private doneSig: string | null = null;
  private done: Out | null = null;
  private gen = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly o: RelayouterOptions<In, Out>) {
    this.now = o.now ?? (() => performance.now());
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  update(input: In, final: boolean): void {
    this.latest = input;
    this.final = this.final || final;
    if (this.busy) return; // picked up when the running layout ends
    this.schedule();
  }

  /** A new run: forget the last layout and drop any layout in flight. */
  reset(): void {
    this.gen++;
    this.cancelTimer();
    this.latest = null;
    this.final = false;
    this.busy = false;
    this.doneSig = null;
    this.done = null;
    this.lastStart = -Infinity;
  }

  dispose(): void {
    this.reset();
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.latest === null) return;
    if (this.final) {
      this.cancelTimer();
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    const wait = Math.max(0, this.lastStart + this.o.intervalMs - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    const input = this.latest;
    if (input === null || this.busy) return;
    const sig = this.o.signature(input);
    if (this.done !== null && sig === this.doneSig) {
      this.o.apply(input, this.done);
      return;
    }
    this.busy = true;
    this.lastStart = this.now();
    const gen = this.gen;
    this.o.run(input).then(
      (out) => {
        if (gen !== this.gen) return;
        this.busy = false;
        this.done = out;
        this.doneSig = sig;
        this.o.apply(input, out);
        if (this.latest !== input) this.schedule();
      },
      (e: unknown) => {
        if (gen !== this.gen) return;
        this.busy = false;
        this.o.onError?.(e);
      },
    );
  }
}
