import '@machines/render/theme.css';
import { describeStep, type EventLog, type GraphModel } from '@machines/log';
import { createElk, mountTwoPane, type TwoPaneController } from '@machines/render';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DocsOpenerContext } from '../docs/opener';
import { useStore } from '../store';
import { SummaryText } from '../timeline/SummaryText';
import { clampStep } from '../timeline/steps';
import './diagram.css';
import type { DiagramPaneProps } from './DiagramPane';
import { tooManyMessage } from './runBanner';
import { useDocs, ViewToggle } from './shared';
import { nearestWire } from './view';

/** At most one re-mount per this long while a run streams. */
const REMOUNT_INTERVAL_MS = 500;

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
      setMounted(null);
      setHead(null);
      return;
    }
    let cancelled = false;
    const wait = running ? Math.max(0, lastMount.current + REMOUNT_INTERVAL_MS - Date.now()) : 0;
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
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        },
      );
    }, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [model, log, running]);
  useEffect(
    () => () => {
      ctlRef.current?.destroy();
      ctlRef.current = null;
    },
    [],
  );

  // ---- step -> the stage
  useEffect(() => {
    const ctl = ctlRef.current;
    if (!ctl || !mounted) return;
    // svl-61q.3: pass `{ animate: useStore.getState().stepSingle }` as the second argument here.
    ctl.setStep(clampStep(step, mounted.model.steps.length));
    hover.current = null;
  }, [step, mounted]);

  // ---- hover and click on a wire of the stage (the wires svg takes no pointer events: hit-test its plan)
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !mounted) return;
    const wireAt = (e: PointerEvent | MouseEvent): string | null => {
      const ctl = ctlRef.current;
      if (!ctl || !(e.target instanceof Element) || e.target.closest('.md-card')) return null;
      const r = ctl.stageEl.getBoundingClientRect();
      return nearestWire(ctl.plan, e.clientX - r.left, e.clientY - r.top)?.edge ?? null;
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
