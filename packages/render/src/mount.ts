// mount(): the DiagramController (CONTRACTS.md section 8). Framework-free. Builds the SVG on `setGraph`, and
// `setState` only toggles classes and text, so stepping never re-lays-out.
import type { EventLog, GraphModel, StepState } from '@machines/log';
import type { Laid } from './layout';
import { applyState, buildSvg, nodeDocTarget, setMoreOpen } from './svg';
import type { MethodDocTarget } from './svg';
import type { ApplyContext, SvgDom } from './svg';

export interface MountOptions {
  onSelectNode(id: string): void;
  /** `at` is in viewport (client) coordinates, ready for a fixed-position popover. `id` null: the pointer left. */
  onHoverEdge(id: string | null, at: DOMPoint): void;
  onClickEdge(id: string): void;
  /**
   * The user chose a method in an instance's "more methods" list (click, Enter or Space). `target` is what
   * `RuntimeClient.docs` takes (svl-3ms opens the docs panel from it). When this is not given the list
   * is plain text. The same data is on each entry as `data-doc-module`, `data-doc-name` and `data-doc-method`.
   */
  onOpenDocs?(target: MethodDocTarget, nodeId: string): void;
}

export interface DiagramController {
  setGraph(model: GraphModel, laid: Laid): void;
  /** Reveal, highlight the current node, badges, active tokens. `log` supplies value types and attributes. */
  setState(state: StepState, log?: EventLog): void;
  /** Scroll the box into view (does not move keyboard focus). */
  focusNode(id: string): void;
  /** Opens (or with `open` false closes) the "more methods" list of an instance. No-op for other ids. */
  toggleMethods(id: string, open?: boolean): void;
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

let uidCounter = 0;

export function mount(el: HTMLElement, opts: MountOptions): DiagramController {
  const doc = el.ownerDocument;
  let dom: SvgDom | null = null;
  let lastState: StepState | null = null;
  let lastLog: EventLog | undefined;
  let hoverEdge: string | null = null;
  let hoverNodeId: string | null = null;
  let selectedId: string | null = null;
  let ctx: ApplyContext | null = null;
  let destroyed = false;
  /** Instances whose "more methods" list is open; kept across a re-layout. */
  const openMore = new Set<string>();
  const uid = String(uidCounter++);
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

  const docTarget = (el: Element | null): [MethodDocTarget, string] | null => {
    if (!el || !opts.onOpenDocs) return null;
    const name = el.getAttribute('data-doc-name');
    if (name === null) return null;
    const target: MethodDocTarget = { module: el.getAttribute('data-doc-module'), name };
    if (el.hasAttribute('data-doc-attr')) target.attr = true;
    return [target, el.getAttribute('data-doc-node') ?? ''];
  };
  const toggleMore = (id: string, open?: boolean): void => {
    if (!dom) return;
    const want = open ?? !openMore.has(id);
    if (setMoreOpen(dom, id, want)) {
      if (want) openMore.add(id);
      else openMore.delete(id);
    }
  };
  /** A user toggle: the panel is moved to the front of its layer, which drops focus, so put it back. */
  const userToggleMore = (id: string): void => {
    toggleMore(id);
    (dom?.nodes.get(id)?.more?.ctl as SVGElement | undefined)?.focus();
  };
  /** Open the docs of a box (its "?" button, or "?" on the focused box). */
  const openNodeDocs = (id: string | null): boolean => {
    const n = id === null ? undefined : dom?.nodes.get(id);
    const t = n && dom ? nodeDocTarget(dom.model, n.node) : null;
    if (!t || !opts.onOpenDocs) return false;
    opts.onOpenDocs(t, n!.id);
    return true;
  };
  const onClick = (ev: Event): void => {
    const btn = closest(ev.target, 'data-docs-btn');
    if (btn) {
      openNodeDocs(btn.getAttribute('data-docs-btn'));
      return;
    }
    const doc = closest(ev.target, 'data-doc-name');
    // an attribute row opens its docs from its "?" only: a click elsewhere on the row selects the box
    if (doc && (!doc.hasAttribute('data-doc-attr') || closest(ev.target, 'data-docs-row-btn'))) {
      const t = docTarget(doc);
      if (t) opts.onOpenDocs?.(t[0], t[1]);
      return;
    }
    const more = closest(ev.target, 'data-more');
    if (more) {
      userToggleMore(more.getAttribute('data-more')!);
      return;
    }
    const edge = closest(ev.target, 'data-edge');
    if (edge) {
      opts.onClickEdge(edge.getAttribute('data-edge')!);
      return;
    }
    const node = closest(ev.target, 'data-node');
    if (node) opts.onSelectNode(node.getAttribute('data-node')!);
  };
  /** The row last focused in each box (by its attribute name), so ArrowDown re-enters where you left. */
  const lastRow = new Map<string, string>();
  const visibleRows = (box: Element): Element[] =>
    [...box.querySelectorAll('[data-doc-attr]')].filter((r) => !r.classList.contains('md-hidden'));
  /** Arrow keys on a box or one of its attribute rows (roving focus; one tab stop per box). */
  const onRowArrow = (k: KeyboardEvent): boolean => {
    if (k.ctrlKey || k.metaKey || k.altKey || k.shiftKey) return false;
    const box = closest(k.target, 'data-node');
    if (!box) return false;
    const id = box.getAttribute('data-node')!;
    const rows = visibleRows(box);
    if (rows.length === 0) return false;
    const onRow = k.target !== box ? closest(k.target, 'data-doc-attr') : null;
    const cur = onRow ? rows.indexOf(onRow) : -1;
    if (k.target !== box && cur < 0) return false;
    let to: Element;
    if (k.key === 'ArrowDown') {
      if (cur < 0) {
        const mem = lastRow.get(id);
        to = rows.find((r) => r.getAttribute('data-doc-name') === mem) ?? rows[0]!;
      } else to = rows[Math.min(cur + 1, rows.length - 1)]!;
    } else if (k.key === 'ArrowUp') {
      if (cur < 0) return false;
      to = cur === 0 ? box : rows[cur - 1]!;
    } else if (k.key === 'Escape' && cur >= 0) to = box;
    else return false;
    k.preventDefault();
    k.stopPropagation();
    (to as SVGElement).focus();
    return true;
  };
  const onKeyDown = (ev: Event): void => {
    const k = ev as KeyboardEvent;
    if (onRowArrow(k)) return;
    if (k.key === 'Escape') {
      // inside an open list: close it and give focus back to its control
      const wrap = closest(k.target, 'data-more-for');
      const id = wrap?.getAttribute('data-more-for');
      if (id && openMore.has(id)) {
        k.preventDefault();
        k.stopPropagation();
        toggleMore(id, false);
        (dom?.nodes.get(id)?.more?.ctl as SVGElement | undefined)?.focus();
      }
      return;
    }
    if (k.key === '?' && !k.ctrlKey && !k.metaKey && !k.altKey) {
      const n = closest(k.target, 'data-node');
      if (n && n === k.target && openNodeDocs(n.getAttribute('data-node'))) {
        k.preventDefault();
        k.stopPropagation();
        return;
      }
      const row = closest(k.target, 'data-doc-attr');
      const t = row && row === k.target ? docTarget(row) : null;
      if (t) {
        k.preventDefault();
        k.stopPropagation();
        opts.onOpenDocs?.(t[0], t[1]);
      }
      return;
    }
    if (k.key !== 'Enter' && k.key !== ' ') return;
    const docEl = closest(k.target, 'data-doc-name');
    if (docEl && docEl === k.target) {
      k.preventDefault();
      const t = docTarget(docEl);
      if (t) opts.onOpenDocs?.(t[0], t[1]);
      return;
    }
    const moreEl = closest(k.target, 'data-more');
    if (moreEl && moreEl === k.target) {
      k.preventDefault();
      userToggleMore(moreEl.getAttribute('data-more')!);
      return;
    }
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
    const row = closest(ev.target, 'data-doc-attr');
    const owner = row && closest(row, 'data-node');
    if (row && owner && row === ev.target)
      lastRow.set(owner.getAttribute('data-node')!, row.getAttribute('data-doc-name') ?? '');
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
      if (destroyed) return;
      if (hoverEdge) setHoverEdge(null, point(0, 0));
      if (dom) for (const [t, f] of listeners) dom.svg.removeEventListener(t, f);
      dom?.svg.remove();
      dom = buildSvg(doc, m, laid, uid, { docs: opts.onOpenDocs !== undefined });
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
      for (const id of [...openMore]) if (!setMoreOpen(dom, id, true)) openMore.delete(id);
      // Keep the step across a re-layout of the same run (streamed updates), but only when every id the
      // state refers to exists in the new model; otherwise drop it, and the caller sets a fresh state.
      if (lastState) {
        const ids = new Set([...m.nodes.map((n) => n.id), ...m.edges.map((e) => e.id)]);
        const ok = [...lastState.visibleNodes, ...lastState.visibleEdges].every((id) =>
          ids.has(id),
        );
        if (!ok) lastState = null;
      }
      if (lastState) {
        ctx.prevCurrent = lastState.current;
        applyState(dom, lastState, lastLog, ctx);
      }
    },
    setState(state, log) {
      if (destroyed) return;
      lastState = state;
      if (log) lastLog = log;
      if (!dom || !ctx) return;
      ctx.reducedMotion = reduced();
      applyState(dom, state, lastLog, ctx);
    },
    toggleMethods(id, open) {
      if (!destroyed) toggleMore(id, open);
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
      openMore.clear();
      hoverEdge = null;
      hoverNodeId = null;
      selectedId = null;
      destroyed = true;
    },
  };
  return controller;
}
