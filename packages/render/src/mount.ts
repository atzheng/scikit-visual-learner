// mount(): the DiagramController (CONTRACTS.md section 8). Framework-free. Builds the SVG on `setGraph`, and
// `setState` only toggles classes and text, so stepping never re-lays-out.
import type { EventLog, GraphModel, StepState } from '@machines/log';
import type { Laid } from './layout';
import { applyState, buildSvg } from './svg';
import type { ApplyContext, SvgDom } from './svg';

export interface MountOptions {
  onSelectNode(id: string): void;
  /** `at` is in viewport (client) coordinates, ready for a fixed-position popover. `id` null: the pointer left. */
  onHoverEdge(id: string | null, at: DOMPoint): void;
  onClickEdge(id: string): void;
}

export interface DiagramController {
  setGraph(model: GraphModel, laid: Laid): void;
  /** Reveal, highlight the current node, badges, active tokens. `log` supplies value types and attributes. */
  setState(state: StepState, log?: EventLog): void;
  /** Scroll the box into view (does not move keyboard focus). */
  focusNode(id: string): void;
  /** Hover style on a box (editor cursor sync); null clears. */
  hoverNode(id: string | null): void;
  /** Selected style on a box (e.g. the one shown in the inspect panel); null clears. */
  setSelectedNode(id: string | null): void;
  /** Box in diagram coordinates, for pan/zoom to fit. */
  nodeBounds(id: string): { x: number; y: number; w: number; h: number } | null;
  /** The root `<svg>` (width/height are the layout size in px). */
  readonly svg: SVGSVGElement | null;
  destroy(): void;
}

function point(x: number, y: number): DOMPoint {
  if (typeof DOMPoint !== 'undefined') return new DOMPoint(x, y);
  return {
    x,
    y,
    z: 0,
    w: 1,
    matrixTransform: () => point(x, y),
    toJSON: () => ({ x, y }),
  } as DOMPoint;
}

function closest(target: EventTarget | null, attr: string): Element | null {
  return target instanceof Element ? target.closest(`[${attr}]`) : null;
}

export function mount(el: HTMLElement, opts: MountOptions): DiagramController {
  const doc = el.ownerDocument;
  let dom: SvgDom | null = null;
  let lastState: StepState | null = null;
  let lastLog: EventLog | undefined;
  let hoverEdge: string | null = null;
  let hoverNodeId: string | null = null;
  let selectedId: string | null = null;
  let ctx: ApplyContext | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const reduced = (): boolean =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const edgeEls = (id: string): Element[] =>
    dom
      ? [dom.edges.get(id)?.g, dom.edges.get(id)?.label].filter((x): x is SVGGElement => !!x)
      : [];
  const setHoverEdge = (id: string | null, at: DOMPoint): void => {
    if (id === hoverEdge) return;
    if (hoverEdge) for (const e of edgeEls(hoverEdge)) e.classList.remove('md-hover');
    hoverEdge = id;
    if (id) for (const e of edgeEls(id)) e.classList.add('md-hover');
    opts.onHoverEdge(id, at);
  };

  const onClick = (ev: Event): void => {
    const edge = closest(ev.target, 'data-edge');
    if (edge) {
      opts.onClickEdge(edge.getAttribute('data-edge')!);
      return;
    }
    const node = closest(ev.target, 'data-node');
    if (node) opts.onSelectNode(node.getAttribute('data-node')!);
  };
  const onKeyDown = (ev: Event): void => {
    const k = ev as KeyboardEvent;
    if (k.key !== 'Enter' && k.key !== ' ') return;
    const edge = closest(k.target, 'data-edge');
    const node = closest(k.target, 'data-node');
    // only act on the focused element itself, so Enter in a nested control is left alone
    if (edge && edge === k.target) {
      k.preventDefault();
      opts.onClickEdge(edge.getAttribute('data-edge')!);
    } else if (node && node === k.target) {
      k.preventDefault();
      opts.onSelectNode(node.getAttribute('data-node')!);
    }
  };
  const onOver = (ev: Event): void => {
    const m = ev as MouseEvent;
    const edge = closest(m.target, 'data-edge');
    if (edge) setHoverEdge(edge.getAttribute('data-edge'), point(m.clientX, m.clientY));
  };
  const onOut = (ev: Event): void => {
    const m = ev as MouseEvent;
    if (!closest(m.target, 'data-edge')) return;
    const to = closest(m.relatedTarget, 'data-edge');
    if (to?.getAttribute('data-edge') === hoverEdge) return;
    setHoverEdge(null, point(m.clientX, m.clientY));
  };
  const onFocusIn = (ev: Event): void => {
    const edge = closest(ev.target, 'data-edge');
    if (!edge || !(ev.target instanceof Element) || !ev.target.classList.contains('md-edge-label'))
      return;
    const r = ev.target.getBoundingClientRect();
    setHoverEdge(edge.getAttribute('data-edge'), point(r.left + r.width / 2, r.bottom));
  };
  const onFocusOut = (ev: Event): void => {
    if (
      hoverEdge &&
      ev.target instanceof Element &&
      ev.target.classList.contains('md-edge-label')
    ) {
      setHoverEdge(null, point(0, 0));
    }
  };

  const listeners: [string, (e: Event) => void][] = [
    ['click', onClick],
    ['keydown', onKeyDown],
    ['mouseover', onOver],
    ['mouseout', onOut],
    ['focusin', onFocusIn],
    ['focusout', onFocusOut],
  ];

  const applyNodeClass = (id: string | null, cls: string): void => {
    if (!dom) return;
    for (const h of dom.nodes.values()) h.g.classList.toggle(cls, h.id === id);
  };

  const controller: DiagramController = {
    setGraph(m, laid) {
      if (dom) for (const [t, f] of listeners) dom.svg.removeEventListener(t, f);
      dom?.svg.remove();
      dom = buildSvg(doc, m, laid);
      for (const [t, f] of listeners) dom.svg.addEventListener(t, f);
      el.append(dom.svg);
      hoverEdge = null;
      const steps = m.steps;
      ctx = {
        model: m,
        lastStep: steps.length ? steps[steps.length - 1]! : null,
        prevCurrent: undefined,
        reducedMotion: reduced(),
        schedule: (fn) => {
          const t = setTimeout(() => {
            timers.delete(t);
            fn();
          }, 60);
          timers.add(t);
        },
      };
      applyNodeClass(hoverNodeId, 'md-hover');
      applyNodeClass(selectedId, 'md-selected');
      // keep what the student was looking at across a re-layout (streamed updates)
      if (lastState) {
        ctx.prevCurrent = lastState.current;
        applyState(dom, lastState, lastLog, ctx);
      }
    },
    setState(state, log) {
      lastState = state;
      if (log) lastLog = log;
      if (!dom || !ctx) return;
      ctx.reducedMotion = reduced();
      applyState(dom, state, lastLog, ctx);
    },
    focusNode(id) {
      const g = dom?.nodes.get(id)?.g;
      if (g && typeof g.scrollIntoView === 'function') {
        g.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          behavior: reduced() ? 'auto' : 'smooth',
        });
      }
    },
    hoverNode(id) {
      hoverNodeId = id;
      applyNodeClass(id, 'md-hover');
    },
    setSelectedNode(id) {
      selectedId = id;
      applyNodeClass(id, 'md-selected');
    },
    nodeBounds(id) {
      const l = dom?.nodes.get(id)?.laid;
      return l ? { x: l.x, y: l.y, w: l.w, h: l.h } : null;
    },
    get svg() {
      return dom?.svg ?? null;
    },
    destroy() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (dom) for (const [t, f] of listeners) dom.svg.removeEventListener(t, f);
      dom?.svg.remove();
      dom = null;
      lastState = null;
    },
  };
  return controller;
}
