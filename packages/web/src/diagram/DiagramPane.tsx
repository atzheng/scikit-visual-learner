import '@machines/render/theme.css';
import { stateAt, type EventLog, type GraphModel } from '@machines/log';
import {
  attrRowsFor,
  createElk,
  edgeLabelsFor,
  layout,
  mount,
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
import { useStore } from '../store';
import { clampStep, nodeForSite, stepForKey } from '../timeline/steps';
import './diagram.css';
import { ensureVisible, fitView, panBy, zoomAt, type View } from './panzoom';
import { Relayouter, layoutSignature, stickyTier, type Tier } from './pipeline';
import { bannerForLog, tooManyMessage } from './runBanner';

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

export function DiagramPane({
  cursorSite = null,
  onHoverEdge,
  onClickEdge,
  controllerRef,
}: DiagramPaneProps) {
  const log = useStore((s) => s.log);
  const model = useStore((s) => s.model);
  const running = useStore((s) => s.running);
  const runId = useStore((s) => s.runId);
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const selectedNode = useStore((s) => s.selection.node);

  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<DiagramController | null>(null);
  const laidSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const autoFit = useRef(true);
  const [shown, setShown] = useState<Shown | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const latest = useRef({ onHoverEdge, onClickEdge });
  latest.current = { onHoverEdge, onClickEdge };

  const applyView = useCallback((v: View) => {
    viewRef.current = v;
    const stage = stageRef.current;
    if (stage) stage.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    setZoomPct(Math.round(v.k * 100));
  }, []);
  const viewportSize = useCallback(() => {
    const r = viewportRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  }, []);
  const fit = useCallback(() => {
    autoFit.current = true;
    applyView(fitView(laidSize.current, viewportSize()));
  }, [applyView, viewportSize]);
  const userView = useCallback(
    (v: View) => {
      autoFit.current = false;
      applyView(v);
    },
    [applyView],
  );

  // ---- the diagram controller, created once
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ctl = mount(stage, {
      onSelectNode: (id) => useStore.getState().selectNode(id),
      onHoverEdge: (id, at) => latest.current.onHoverEdge?.(id, at),
      onClickEdge: (id) => {
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
        layoutSignature(m, attrRowsFor(m, l), edgeLabelsFor(m, l)),
      run: ({ model: m, log: l, tier }) =>
        layout(m, {
          elk,
          attrRows: attrRowsFor(m, l),
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
        if (autoFit.current) applyView(fitView(laidSize.current, viewportSize()));
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
    relayouter.current?.reset();
  }, [runId]);

  useEffect(() => {
    if (!model || !log || model === skipModel.current) return;
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
    const id = stepState.currentNode;
    if (id && !autoFit.current) {
      const b = ctl.nodeBounds(id);
      if (b) userView(ensureVisible(viewRef.current, b, viewportSize()));
    }
  }, [stepState, shown, userView, viewportSize]);

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
      if (b) userView(ensureVisible(viewRef.current, b, viewportSize()));
    }
  }, [cursorSite, shown, userView, viewportSize]);

  // ---- pan / zoom
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : 1;
      userView(
        zoomAt(
          viewRef.current,
          Math.exp(-e.deltaY * unit * 0.002),
          e.clientX - r.left,
          e.clientY - r.top,
        ),
      );
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
        applyView(fitView(laidSize.current, viewportSize()));
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

  const banner = !running && log ? bannerForLog(log) : null;
  const tooMany = shown?.model.tooMany;
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
        {running && (
          <span className="run-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Running…
          </span>
        )}
      </div>
      {banner && (
        <p className="banner" role="status" data-testid="run-banner">
          <span aria-hidden="true">⚠ </span>
          {banner}
        </p>
      )}
      {tooMany !== undefined && (
        <p className="banner" role="status" data-testid="too-many">
          <span aria-hidden="true">⚠ </span>
          {tooManyMessage(tooMany)}
        </p>
      )}
      {layoutError && (
        <p className="banner error" role="alert">
          <span aria-hidden="true">⚠ </span>
          The diagram could not be laid out: {layoutError}
        </p>
      )}
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
    </section>
  );
}
