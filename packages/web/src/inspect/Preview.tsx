import { stateAt, type ValueSummary } from '@machines/log';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { clampStep } from '../timeline/steps';
import './inspect.css';
import {
  edgeToken,
  placePopover,
  previewOmitted,
  summaryDetail,
  summaryTitle,
  truncationNote,
  type Pt,
} from './model';

/** The facts and the table or matrix of one value. Used by the wire popover and by the attribute panel. */
export function ValueBody({ value }: { value: ValueSummary | undefined }) {
  if (!value) return <p className="pv-note">No summary was recorded for this value.</p>;
  const detail = summaryDetail(value);
  const note = truncationNote(value);
  const p = value.preview;
  return (
    <div className="pv-body">
      <p className="pv-title">
        <span className="pv-type">{summaryTitle(value)}</span>
        {detail && <span className="pv-detail">{detail}</span>}
      </p>
      {value.repr !== undefined && value.shape === undefined && (
        <p className="pv-repr">
          <code>{value.repr}</code>
        </p>
      )}
      {p?.kind === 'table' && (
        <div className="pv-scroll" tabIndex={0} role="group" aria-label="Table preview">
          <table className="pv-table">
            <thead>
              <tr>
                <th scope="col" className="pv-corner" />
                {p.columns.map((c, i) => (
                  <th key={i} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r, i) => (
                <tr key={i}>
                  <th scope="row">{p.index[i]}</th>
                  {r.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p?.kind === 'matrix' && (
        <div className="pv-scroll" tabIndex={0} role="group" aria-label="Array preview">
          <table className="pv-table pv-matrix">
            <tbody>
              {p.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <p className="pv-note">{note}</p>}
      {previewOmitted(value) && <p className="pv-note">preview omitted (size limit)</p>}
    </div>
  );
}

interface Hover {
  id: string;
  at: Pt;
}

export interface EdgeInspect {
  onHover(id: string | null, at: DOMPoint): void;
  onClick(id: string): void;
  /** The popover element; render it anywhere (it is positioned in viewport coordinates). */
  popover: React.ReactNode;
}

const fallbackPoint = (id: string): Pt => {
  const el = document.querySelector(`[data-edge="${CSS.escape(id)}"]`);
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.bottom } : { x: 16, y: 16 };
};

/**
 * Hover shows the active value of a wire; a click, Enter on a focused wire label, or a tap pins it
 * (Esc or a click outside unpins). Wire the two callbacks into `DiagramPane` and render `popover`.
 */
export function useEdgeInspect(): EdgeInspect {
  const model = useStore((s) => s.model);
  const log = useStore((s) => s.log);
  const step = useStore((s) => s.step);
  const selection = useStore((s) => s.selection);
  const [hover, setHover] = useState<Hover | null>(null);
  const [pinAt, setPinAt] = useState<Pt | null>(null);
  const lastHover = useRef<Hover | null>(null);
  const pinnedId = selection.pinned && selection.edge ? selection.edge : null;

  const onHover = useCallback((id: string | null, at: DOMPoint) => {
    const h = id ? { id, at: { x: at.x, y: at.y } } : null;
    if (h) lastHover.current = h;
    setHover(h);
  }, []);
  const onClick = useCallback((id: string) => {
    const h = lastHover.current;
    setPinAt(h && h.id === id ? h.at : fallbackPoint(id));
  }, []);
  const unpin = useCallback(() => {
    if (useStore.getState().selection.edge) useStore.setState({ selection: {} });
    setPinAt(null);
  }, []);

  // Esc and a click elsewhere unpin.
  useEffect(() => {
    if (!pinnedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      unpin();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Element && (t.closest('.pv-popover') || t.closest('[data-edge]'))) return;
      unpin();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [pinnedId, unpin]);

  const state = useMemo(
    () => (model && log ? stateAt(model, log, clampStep(step, model.steps.length)) : null),
    [model, log, step],
  );
  const shownId = pinnedId ?? hover?.id ?? null;
  const at = pinnedId ? (pinAt ?? hover?.at ?? null) : (hover?.at ?? null);
  const token = model && shownId ? edgeToken(model, state, shownId) : null;
  const value = token !== null && log ? log.values[token] : undefined;

  const popover =
    shownId && at && token !== null ? (
      <Popover
        key={pinnedId ? 'pinned' : 'hover'}
        at={at}
        pinned={pinnedId !== null}
        onClose={unpin}
      >
        <ValueBody value={value} />
      </Popover>
    ) : null;
  return { onHover, onClick, popover };
}

function Popover({
  at,
  pinned,
  onClose,
  children,
}: {
  at: Pt;
  pinned: boolean;
  onClose(): void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pt | null>(null);
  // Measure after render, then place inside the viewport; re-place when the content or the window changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      const vp = {
        w: document.documentElement.clientWidth,
        h: document.documentElement.clientHeight,
      };
      setPos(placePopover(at, { w: r.width, h: r.height }, vp));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [at]);
  return (
    <div
      ref={ref}
      className={`pv-popover${pinned ? ' pinned' : ''}`}
      role="region"
      aria-label={pinned ? 'Pinned value preview' : 'Value preview'}
      aria-live="polite"
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {pinned && (
        <button type="button" className="pv-close" onClick={onClose} aria-label="Unpin preview">
          <span aria-hidden="true">×</span> Esc
        </button>
      )}
      {children}
      {!pinned && <p className="pv-hint">Click or press Enter to pin</p>}
    </div>
  );
}
