import '@machines/render/theme.css';
import {
  stateAt,
  type DocTarget,
  type EventLog,
  type GraphModel,
  type StepState,
} from '@machines/log';
import {
  attrRowsFor,
  createElk,
  createLegendList,
  edgeLabelsFor,
  layout,
  mount,
  moreMethodsFor,
  type DiagramController,
  type Laid,
} from '@machines/render';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { DocsPanel } from '../docs/DocsPanel';
import { docRequest } from '../docs/model';
import { useStore } from '../store';
import { clampStep, nodeForSite, stepForKey } from '../timeline/steps';
import './diagram.css';
import { followNodes, followView, READABLE_K, unionRect } from './follow';
import { ensureVisible, fitView, panBy, zoomAt, type View } from './panzoom';
import { Relayouter, layoutSignature, stickyTier, type Tier } from './pipeline';
import { tooManyMessage } from './runBanner';

const LEGEND_KEY = 'machines.legendOpen';
function readLegendOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(LEGEND_KEY) === '1';
  } catch {
    return false;
  }
}
function writeLegendOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(LEGEND_KEY, open ? '1' : '0');
  } catch {
    // storage denied: the legend just starts closed next time
  }
}

const FOLLOW_KEY = 'machines.follow';
function readFollow(): boolean {
  try {
    return globalThis.localStorage?.getItem(FOLLOW_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeFollow(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(FOLLOW_KEY, on ? '1' : '0');
  } catch {
    // storage denied: Follow starts on next time
  }
}
const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The legend list, built by the renderer package and kept in the DOM while open. */
function LegendPanel() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const list = createLegendList(document);
    host.append(list);
    return () => list.remove();
  }, []);
  return <div ref={ref} className="md-legend diagram-legend" id="diagram-legend" />;
}

/** At most one layout per this long while a run streams (SPEC "Layout"). */
export const RELAYOUT_INTERVAL_MS = 500;

interface Shown {
  model: GraphModel;
  log: EventLog;
}
interface Input extends Shown {
  tier: Tier;
}

export interface DiagramPaneProps {
  /** Site id under the editor cursor: its box gets the hover style (null clears). */
  cursorSite?: number | null;
  /** Hooks for the inspect UI (svl-bwv.5); the pane itself does nothing with them. */
  onHoverEdge?(id: string | null, at: DOMPoint): void;
  onClickEdge?(id: string): void;
  /** Receives the controller (and the shown model/log) for inspect features. */
  controllerRef?: { current: DiagramController | null };
}

const KEY_PAN = 48;
/** Room under the last row for the error text under a box. */
const fitContent = (s: { w: number; h: number }) => ({ w: s.w, h: s.h > 0 ? s.h + 40 : 0 });
const EMPTY_MODEL: GraphModel = { nodes: [], edges: [], steps: [] };
const EMPTY_LAID: Laid = { width: 0, height: 0, nodes: {}, edges: {}, labels: {}, dropped: 0 };

export function DiagramPane({
  cursorSite = null,
  onHoverEdge,
  onClickEdge,
  controllerRef,
}: DiagramPaneProps) {
  const log = useStore((s) => s.log);
  const model = useStore((s) => s.model);
  const running = useStore((s) => s.running);
  const runSeq = useStore((s) => s.runSeq);
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const selectedNode = useStore((s) => s.selection.node);
  const showAll = useStore((s) => s.showAllObjects);
  const setShowAll = useStore((s) => s.setShowAllObjects);

  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<DiagramController | null>(null);
  const laidSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const autoFit = useRef(true);
  const [shown, setShown] = useState<Shown | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [legendOpen, setLegendOpen] = useState(readLegendOpen);
  const toggleLegend = () => {
    writeLegendOpen(!legendOpen);
    setLegendOpen(!legendOpen);
  };
  const [followOn, setFollowOn] = useState(readFollow);
  /** A manual pan or zoom pauses following until the next step (or the Follow button). */
  const suspended = useRef(false);
  const lastStep = useRef<number | null>(null);
  const shownRef = useRef<Shown | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [docs, setDocs] = useState<{
    target: DocTarget;
    nodeId: string;
  } | null>(null);
  const docsOpener = useRef<Element | null>(null);
  const closeDocs = useCallback(() => {
    setDocs(null);
    const o = docsOpener.current;
    docsOpener.current = null;
    if (o instanceof HTMLElement || o instanceof SVGElement) o.focus();
  }, []);
  const latest = useRef({ onHoverEdge, onClickEdge });
  latest.current = { onHoverEdge, onClickEdge };

  const applyView = useCallback((v: View, animate = false) => {
    viewRef.current = v;
    const stage = stageRef.current;
    if (stage) {
      // only a step's pan glides, and not at all under reduced motion; dragging and zooming never lag
      stage.style.transition = animate && !reducedMotion() ? 'transform 0.25s ease-out' : 'none';
      stage.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    }
    setZoomPct(Math.round(v.k * 100));
  }, []);
  const viewportSize = useCallback(() => {
    const r = viewportRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  }, []);
  const fit = useCallback(() => {
    autoFit.current = true;
    suspended.current = true;
    applyView(fitView(fitContent(laidSize.current), viewportSize()));
  }, [applyView, viewportSize]);
  const userView = useCallback(
    (v: View) => {
      autoFit.current = false;
      suspended.current = true;
      applyView(v);
    },
    [applyView],
  );
  /** A move the pane makes by itself (follow, keeping the editor's box in view): does not pause following. */
  const moveView = useCallback(
    (v: View, animate = false) => {
      autoFit.current = false;
      applyView(v, animate);
    },
    [applyView],
  );
  /** Pan and zoom to the boxes of the step in `st` (or fit, when the whole diagram is readable). */
  const followStep = useCallback(
    (st: StepState | null, animate: boolean) => {
      const ctl = ctlRef.current;
      const sh = shownRef.current;
      if (!ctl || !sh) return;
      const bounds = (id: string) => ctl.nodeBounds(id);
      const rects = st
        ? followNodes(sh.model, st).flatMap((id) => {
            const b = bounds(id);
            return b ? [b] : [];
          })
        : [];
      const content = fitContent(laidSize.current);
      const vp = viewportSize();
      const v = followView(
        viewRef.current,
        unionRect(rects),
        st?.currentNode ? bounds(st.currentNode) : null,
        content,
        vp,
      );
      autoFit.current = fitView(content, vp).k >= READABLE_K;
      applyView(v, animate);
    },
    [applyView, viewportSize],
  );

  // ---- the diagram controller, created once
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ctl = mount(stage, {
      onSelectNode: (id) => useStore.getState().selectNode(id),
      onOpenDocs: (t, nodeId) => {
        docsOpener.current ??= document.activeElement;
        setDocs({
          target: docRequest(t, useStore.getState().runSource),
          nodeId,
        });
      },
      onHoverEdge: (id, at) => latest.current.onHoverEdge?.(id, at),
      onClickEdge: (id) => {
        // a folded temporary's chip opens into its box
        const chip = useStore.getState().model?.edges.find((e) => e.id === id)?.chip;
        if (chip) {
          useStore.getState().unfold(chip.node);
          return;
        }
        useStore.setState({ selection: { edge: id, pinned: true } });
        latest.current.onClickEdge?.(id);
      },
    });
    ctlRef.current = ctl;
    if (controllerRef) controllerRef.current = ctl;
    return () => {
      ctl.destroy();
      ctlRef.current = null;
      if (controllerRef) controllerRef.current = null;
    };
  }, [controllerRef]);

  // ---- layout pipeline: model -> (throttled) layout -> setGraph
  const relayouter = useRef<Relayouter<Input, Laid> | null>(null);
  const tierRef = useRef<Tier>(0);
  const skipModel = useRef<GraphModel | null>(null);
  useEffect(() => {
    const elk = createElk({ workerUrl: elkWorkerUrl });
    const r = new Relayouter<Input, Laid>({
      intervalMs: RELAYOUT_INTERVAL_MS,
      signature: ({ model: m, log: l }) =>
        layoutSignature(m, attrRowsFor(m, l), edgeLabelsFor(m, l), moreMethodsFor(m, l)),
      run: ({ model: m, log: l, tier }) =>
        layout(m, {
          elk,
          attrRows: attrRowsFor(m, l),
          moreMethods: moreMethodsFor(m, l),
          edgeLabels: edgeLabelsFor(m, l),
          minTier: tier,
        }),
      apply: ({ model: m, log: l }, laid) => {
        const ctl = ctlRef.current;
        if (!ctl) return;
        setLayoutError(null);
        ctl.setGraph(m, laid);
        laidSize.current = { w: laid.width, h: laid.height };
        // setGraph re-applies the old state only when its ids still exist: set the shown step now.
        const st = stateAt(m, l, clampStep(useStore.getState().step, m.steps.length));
        ctl.setState(st, l);
        if (autoFit.current) applyView(fitView(fitContent(laidSize.current), viewportSize()));
        shownRef.current = { model: m, log: l };
        setShown({ model: m, log: l });
      },
      onError: (e) => setLayoutError(e instanceof Error ? e.message : String(e)),
    });
    relayouter.current = r;
    return () => {
      r.dispose();
      relayouter.current = null;
    };
  }, [applyView, viewportSize]);

  // New run: reset the sticky tier and fit mode. The old diagram stays until the first update arrives.
  useEffect(() => {
    tierRef.current = 0;
    skipModel.current = useStore.getState().model;
    autoFit.current = true;
    suspended.current = false;
    lastStep.current = null;
    relayouter.current?.reset();
  }, [runSeq]);

  useEffect(() => {
    if (!model || !log) {
      // A new run cleared the log: drop the old diagram too.
      ctlRef.current?.setGraph(EMPTY_MODEL, EMPTY_LAID);
      laidSize.current = { w: 0, h: 0 };
      shownRef.current = null;
      setShown(null);
      return;
    }
    if (model === skipModel.current) return;
    tierRef.current = stickyTier(model, tierRef.current);
    relayouter.current?.update({ model, log, tier: tierRef.current }, !running);
  }, [model, log, running]);

  // ---- step -> highlight state (no layout)
  const stepState = useMemo(
    () =>
      shown ? stateAt(shown.model, shown.log, clampStep(step, shown.model.steps.length)) : null,
    [shown, step],
  );
  useEffect(() => {
    const ctl = ctlRef.current;
    if (!ctl || !stepState || !shown) return;
    ctl.setState(stepState, shown.log);
    const stepNow = stepState.current;
    const stepped = lastStep.current !== stepNow;
    lastStep.current = stepNow;
    // the next step resumes following, unless it is only the slider tracking a streaming run
    if (stepped && !useStore.getState().running) suspended.current = false;
    if (followOn) {
      if (!suspended.current) followStep(stepState, stepped);
      return;
    }
    const id = stepState.currentNode;
    if (id && !autoFit.current) {
      const b = ctl.nodeBounds(id);
      if (b) moveView(ensureVisible(viewRef.current, b, viewportSize()));
    }
  }, [stepState, shown, followOn, followStep, moveView, viewportSize]);
  const toggleFollow = () => {
    writeFollow(!followOn);
    suspended.current = false;
    setFollowOn(!followOn);
  };

  useEffect(() => {
    ctlRef.current?.setSelectedNode(selectedNode ?? null);
  }, [selectedNode, shown]);

  // ---- editor cursor -> hover style on the box
  useEffect(() => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    const id =
      shown && cursorSite !== null ? nodeForSite(shown.model, shown.log, cursorSite) : null;
    ctl.hoverNode(id);
    if (id && !autoFit.current) {
      const b = ctl.nodeBounds(id);
      if (b) moveView(ensureVisible(viewRef.current, b, viewportSize()));
    }
  }, [cursorSite, shown, moveView, viewportSize]);

  // ---- pan / zoom
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd + wheel, and trackpad pinch (which arrives as ctrl + wheel), zoom at the pointer.
        const r = vp.getBoundingClientRect();
        userView(
          zoomAt(
            viewRef.current,
            Math.exp(-e.deltaY * unit * 0.01),
            e.clientX - r.left,
            e.clientY - r.top,
          ),
        );
      } else {
        userView(panBy(viewRef.current, -e.deltaX * unit, -e.deltaY * unit));
      }
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    // Tabbing to an off-screen box scrolls the viewport natively: turn that into a pan.
    const onScroll = () => {
      if (vp.scrollLeft === 0 && vp.scrollTop === 0) return;
      const dx = -vp.scrollLeft;
      const dy = -vp.scrollTop;
      vp.scrollLeft = 0;
      vp.scrollTop = 0;
      userView(panBy(viewRef.current, dx, dy));
    };
    vp.addEventListener('scroll', onScroll);
    const ro = new ResizeObserver(() => {
      if (autoFit.current && laidSize.current.w > 0)
        applyView(fitView(fitContent(laidSize.current), viewportSize()));
    });
    ro.observe(vp);
    return () => {
      vp.removeEventListener('wheel', onWheel);
      vp.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [userView, applyView, viewportSize]);

  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    d.x = e.clientX;
    d.y = e.clientY;
    userView(panBy(viewRef.current, dx, dy));
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    if (drag.current?.moved) suppressClick.current = true;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.stopPropagation();
  };

  const zoomBy = (f: number) => {
    const s = viewportSize();
    userView(zoomAt(viewRef.current, f, s.w / 2, s.h / 2));
  };
  const maxStep = model?.steps.length ?? 0;
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const next = stepForKey(e.nativeEvent, clampStep(step, maxStep), maxStep);
    if (next !== null) {
      e.preventDefault();
      setStep(next);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const v = viewRef.current;
    const handled = ((): boolean => {
      switch (e.key) {
        case '+':
        case '=':
          return (zoomBy(1.25), true);
        case '-':
          return (zoomBy(0.8), true);
        case '0':
          return (fit(), true);
        case 'ArrowUp':
          return (userView(panBy(v, 0, KEY_PAN)), true);
        case 'ArrowDown':
          return (userView(panBy(v, 0, -KEY_PAN)), true);
        case 'ArrowLeft':
          return e.shiftKey ? (userView(panBy(v, KEY_PAN, 0)), true) : false;
        case 'ArrowRight':
          return e.shiftKey ? (userView(panBy(v, -KEY_PAN, 0)), true) : false;
        default:
          return false;
      }
    })();
    if (handled) e.preventDefault();
  };

  const truncated = shown?.model.truncated;
  const empty = shown !== null && shown.model.nodes.length === 0;
  return (
    <section className="diagram-pane" aria-label="Diagram">
      <div className="diagram-tools">
        <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (+)">
          +
        </button>
        <button
          type="button"
          onClick={() => zoomBy(0.8)}
          aria-label="Zoom out"
          title="Zoom out (-)"
        >
          −
        </button>
        <button type="button" onClick={fit} title="Fit the diagram to the pane (0)">
          Fit
        </button>
        <span className="zoom-level" aria-label={`Zoom ${zoomPct} percent`}>
          {zoomPct}%
        </span>
        <button
          type="button"
          className="follow-toggle"
          aria-pressed={followOn}
          onClick={toggleFollow}
          title="Keep the boxes of the current step in view, at a readable size"
        >
          Follow
        </button>
        <button
          type="button"
          className="objects-toggle"
          aria-pressed={showAll}
          onClick={() => setShowAll(!showAll)}
          title="Draw every object as a box, instead of folding unnamed one-use temporaries into small chips on their wires"
        >
          All objects
        </button>
        <button
          type="button"
          className="legend-toggle"
          aria-expanded={legendOpen}
          aria-controls="diagram-legend"
          onClick={toggleLegend}
          title="Show or hide the legend that explains the shapes and colours"
        >
          Legend
        </button>
        {running && (
          <span className="run-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Running…
          </span>
        )}
      </div>
      {legendOpen && <LegendPanel />}
      {truncated && (
        <p className="banner" role="status" data-testid="too-many">
          <span aria-hidden="true">⚠ </span>
          {tooManyMessage(truncated)}
        </p>
      )}
      {layoutError && (
        <p className="banner error" role="alert">
          <span aria-hidden="true">⚠ </span>
          The diagram could not be laid out: {layoutError}
        </p>
      )}
      <div className="diagram-body">
        <div
          ref={viewportRef}
          className="diagram-viewport"
          tabIndex={0}
          role="group"
          aria-label="Diagram. Left and right arrows step through the run. Plus, minus and zero zoom. Up and down arrows pan."
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onClickCapture={onClickCapture}
        >
          <div ref={stageRef} className="diagram-stage" />
          {!shown && !running && (
            <p className="diagram-empty muted">Run your code to see its diagram here.</p>
          )}
          {!shown && running && <p className="diagram-empty muted">Waiting for the first call…</p>}
          {empty && (
            <p className="diagram-empty muted">
              The run made no library calls to draw. Call something from numpy, pandas or
              scikit-learn.
            </p>
          )}
        </div>
        {docs && (
          <DocsPanel
            target={docs.target}
            nodeId={docs.nodeId}
            model={model}
            log={log}
            step={step}
            onClose={closeDocs}
          />
        )}
      </div>
    </section>
  );
}
