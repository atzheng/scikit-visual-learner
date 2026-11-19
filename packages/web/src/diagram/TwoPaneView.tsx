import '@machines/render/theme.css';
import { describeStep, type EventLog, type GraphModel } from '@machines/log';
import { createElk, mountTwoPane, type TwoPaneController } from '@machines/render';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DocsOpenerContext } from '../docs/opener';
import { useStore } from '../store';
import { SummaryText } from '../timeline/SummaryText';
import { clampStep } from '../timeline/steps';
import './diagram.css';
import type { DiagramPaneProps } from './DiagramPane';
import { tooManyMessage } from './runBanner';
import { useDocs, ViewToggle } from './shared';
import { canvasPoint, nearestWire } from './view';

/** At most one re-mount per this long while a run streams. */
const REMOUNT_INTERVAL_MS = 500;
const MIN_STAGE_SCALE = 0.6;
/** Height the shelf keeps under the stage: its minimum (110 px) and the gap. */
const STAGE_RESERVE = 150;
const CUE_SLACK = 24;
const ANIMATION_SETTLE_MS = 400;

/**
 * The two-pane view: the object shelf and the current-line stage (`mountTwoPane`). The renderer takes a fixed
 * model, so a new model (a streamed update, a folding change) mounts a fresh controller and drops the old one.
 */
export function TwoPaneView({ onHoverEdge, onClickEdge, children }: DiagramPaneProps) {
  const log = useStore((s) => s.log);
  const model = useStore((s) => s.model);
  const running = useStore((s) => s.running);
  const step = useStore((s) => s.step);
  const showAll = useStore((s) => s.showAllObjects);
  const setShowAll = useStore((s) => s.setShowAllObjects);

  const hostRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<TwoPaneController | null>(null);
  const elkRef = useRef<ReturnType<typeof createElk> | null>(null);
  const lastMount = useRef(0);
  const hover = useRef<string | null>(null);
  const pending = useRef<{ model: GraphModel; log: EventLog } | null>(null);
  const applied = useRef<{ mounted: unknown; step: number } | null>(null);
  const scale = useRef(1);
  const latest = useRef({ onHoverEdge, onClickEdge });
  latest.current = { onHoverEdge, onClickEdge };
  const { openDocs, docsPanel } = useDocs();
  const openDocsRef = useRef(openDocs);
  openDocsRef.current = openDocs;

  const [mounted, setMounted] = useState<{ model: GraphModel; log: EventLog } | null>(null);
  const [head, setHead] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- model -> (throttled) mount of a controller
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!model || !log) {
      ctlRef.current?.destroy();
      ctlRef.current = null;
      pending.current = null;
      setMounted(null);
      setHead(null);
      return;
    }
    // the same model and log are already drawn (or on their way): `running` flipping must not mount a second root
    if (pending.current?.model === model && pending.current.log === log) return;
    pending.current = { model, log };
    let cancelled = false;
    const wait = useStore.getState().running
      ? Math.max(0, lastMount.current + REMOUNT_INTERVAL_MS - Date.now())
      : 0;
    const timer = setTimeout(() => {
      elkRef.current ??= createElk({ workerUrl: elkWorkerUrl });
      mountTwoPane(host, model, log, {
        onSelectNode: (id) => useStore.getState().selectNode(id),
        onOpenDocs: (t, nodeId) => openDocsRef.current(t, nodeId),
        elk: elkRef.current,
      }).then(
        (ctl) => {
          if (cancelled) {
            ctl.destroy();
            if (pending.current?.model === model) pending.current = null;
            return;
          }
          lastMount.current = Date.now();
          ctlRef.current?.destroy();
          ctlRef.current = ctl;
          setError(null);
          // one live region for the step: the timeline's. The stage's own notes stay readable text.
          const sec = ctl.stageEl.parentElement;
          sec?.querySelector('.md-stage-notes')?.removeAttribute('aria-live');
          const h = host.ownerDocument.createElement('div');
          h.className = 'stage-head';
          sec?.prepend(h);
          setHead(h);
          ctl.setStep(clampStep(useStore.getState().step, model.steps.length));
          setMounted({ model, log });
        },
        (e: unknown) => {
          pending.current = null;
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        },
      );
    }, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (pending.current?.model === model && pending.current.log === log) pending.current = null;
    };
  }, [model, log]);
  useEffect(
    () => () => {
      ctlRef.current?.destroy();
      ctlRef.current = null;
    },
    [],
  );

  /**
   * Scale the stage canvas to fit its pane, by width and by height (floor 0.6, then the stage scrolls), and
   * show a cue while content is still below the fold.
   */
  const fitStage = useCallback(() => {
    const ctl = ctlRef.current;
    const sec = ctl?.stageEl.parentElement;
    const root = sec?.parentElement;
    if (!ctl || !sec || !root) return;
    const w = ctl.plan?.width ?? 0;
    const h = ctl.plan?.height ?? 0;
    delete sec.dataset.overflow; // measure without the cue itself, which adds height
    // what the stage holds besides the canvas: its top (summary, notes, padding) and bottom padding. Not
    // `scrollHeight`: a card sliding in from the shelf inflates it mid-animation.
    const overhead =
      ctl.stageEl.getBoundingClientRect().top - sec.getBoundingClientRect().top + sec.scrollTop + 9;
    const kW = (sec.clientWidth - 18) / (w || 1);
    // stacked: the shelf keeps room under the stage; side by side the stage has the whole pane height
    const sideBySide = getComputedStyle(root).flexDirection === 'row';
    const reserve = sideBySide ? 0 : STAGE_RESERVE;
    const kH = (root.clientHeight - reserve - overhead - 2) / (h || 1);
    const k = w > 0 ? Math.max(MIN_STAGE_SCALE, Math.min(1, kW, kH)) : 1;
    // CSS zoom, not a transform: the layout box shrinks with it, so the stage's height and scroll area follow
    ctl.stageEl.style.zoom = k < 1 ? String(k) : '';
    scale.current = k;
    // a few px of blank under the last card is not "more": the cue needs real hidden content
    if (
      sec.scrollHeight > sec.clientHeight + CUE_SLACK &&
      sec.scrollTop + sec.clientHeight < sec.scrollHeight - CUE_SLACK
    )
      sec.dataset.overflow = '';
    else delete sec.dataset.overflow;
  }, []);

  // ---- step -> the stage
  useEffect(() => {
    const ctl = ctlRef.current;
    if (!ctl || !mounted) return;
    const n = clampStep(step, mounted.model.steps.length);
    // animate only a real one-step move on the controller already showing the previous step: never a
    // remount, a view switch or the All objects toggle
    const prev = applied.current;
    const animate =
      prev !== null &&
      prev.mounted === mounted &&
      prev.step !== n &&
      useStore.getState().stepSingle;
    applied.current = { mounted, step: n };
    ctl.setStep(n, { animate });
    if (useStore.getState().stepSingle) useStore.setState({ stepSingle: false });
    hover.current = null;
    fitStage();
    // the cue measures overflow, which is only true once the cards have landed
    const settle = setTimeout(fitStage, ANIMATION_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [step, mounted, fitStage]);
  useEffect(() => {
    const sec = ctlRef.current?.stageEl.parentElement;
    if (!sec) return;
    sec.addEventListener('scroll', fitStage);
    return () => sec.removeEventListener('scroll', fitStage);
  }, [mounted, fitStage]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(fitStage);
    ro.observe(host);
    // the summary sentence wraps to more or fewer lines as the step changes, which changes the room left
    if (head) ro.observe(head);
    return () => ro.disconnect();
  }, [fitStage, head]);

  // ---- hover and click on a wire of the stage (the wires svg takes no pointer events: hit-test its plan)
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !mounted) return;
    const wireAt = (e: PointerEvent | MouseEvent): string | null => {
      const ctl = ctlRef.current;
      if (!ctl || !(e.target instanceof Element) || e.target.closest('.md-card')) return null;
      const r = ctl.stageEl.getBoundingClientRect();
      const p = canvasPoint(e.clientX, e.clientY, r, scale.current);
      return nearestWire(ctl.plan, p.x, p.y)?.edge ?? null;
    };
    const setHover = (id: string | null, e: PointerEvent | MouseEvent) => {
      if (id === hover.current) return;
      const ctl = ctlRef.current;
      const g = (i: string | null) =>
        i ? ctl?.stageEl.querySelector(`[data-edge="${CSS.escape(i)}"]`) : null;
      g(hover.current)?.classList.remove('md-hover');
      hover.current = id;
      g(id)?.classList.add('md-hover');
      if (ctl) ctl.stageEl.style.cursor = id ? 'pointer' : '';
      latest.current.onHoverEdge?.(id, new DOMPoint(e.clientX, e.clientY));
    };
    const onMove = (e: PointerEvent) => setHover(wireAt(e), e);
    const onLeave = (e: PointerEvent) => setHover(null, e);
    const onClick = (e: MouseEvent) => {
      const id = wireAt(e);
      if (!id) return;
      useStore.setState({ selection: { edge: id, pinned: true } });
      latest.current.onClickEdge?.(id);
    };
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('click', onClick);
    return () => {
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('click', onClick);
    };
  }, [mounted]);

  const summary = useMemo(
    () =>
      mounted
        ? describeStep(mounted.model, mounted.log, clampStep(step, mounted.model.steps.length))
        : [],
    [mounted, step],
  );
  const truncated = model?.truncated;
  const empty = mounted !== null && mounted.model.nodes.length === 0;
  return (
    <section className="diagram-pane" aria-label="Diagram">
      <div className="diagram-tools">
        <ViewToggle />
        <button
          type="button"
          className="objects-toggle"
          aria-pressed={showAll}
          onClick={() => setShowAll(!showAll)}
          title="Draw every object as a box, instead of folding unnamed one-use temporaries into small chips on their wires"
        >
          All objects
        </button>
        {running && (
          <span className="run-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Running…
          </span>
        )}
      </div>
      {truncated && (
        <p className="banner" role="status" data-testid="too-many">
          <span aria-hidden="true">⚠ </span>
          {tooManyMessage(truncated)}
        </p>
      )}
      {error && (
        <p className="banner error" role="alert">
          <span aria-hidden="true">⚠ </span>
          The diagram could not be laid out: {error}
        </p>
      )}
      <div className="diagram-body twopane-body">
        <div className="twopane-host" ref={hostRef} data-testid="twopane">
          {!mounted && !running && (
            <p className="diagram-empty muted">Run your code to see its diagram here.</p>
          )}
          {!mounted && running && (
            <p className="diagram-empty muted">Waiting for the first call…</p>
          )}
          {empty && (
            <p className="diagram-empty muted">
              The run made no library calls to draw. Call something from numpy, pandas or
              scikit-learn.
            </p>
          )}
        </div>
        <DocsOpenerContext.Provider value={openDocs}>{children}</DocsOpenerContext.Provider>
        {docsPanel}
      </div>
      {head &&
        createPortal(
          <p className="step-summary" data-testid="step-summary">
            <SummaryText parts={summary} />
          </p>,
          head,
        )}
    </section>
  );
}
