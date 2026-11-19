import type { DocTarget } from '@machines/log';
import type { MethodDocTarget } from '@machines/render';
import { useCallback, useRef, useState } from 'react';
import { DocsPanel } from '../docs/DocsPanel';
import { docRequest } from '../docs/model';
import { useStore } from '../store';

/** The 'View' switch between the two-pane view and the full diagram (persisted in the store). */
export function ViewToggle() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const switchTo = (v: 'two' | 'full') => {
    setView(v);
    // the other view mounts its own toggle: keep keyboard focus on the same button
    setTimeout(() => document.querySelector<HTMLElement>(`.view-toggle .view-${v}`)?.focus(), 0);
  };
  return (
    <div className="view-toggle" role="group" aria-label="View">
      <button
        type="button"
        className="view-two"
        aria-pressed={view === 'two'}
        onClick={() => switchTo('two')}
        title="Show the objects on a shelf and the current line on a stage"
      >
        Shelf and stage
      </button>
      <button
        type="button"
        className="view-full"
        aria-pressed={view === 'full'}
        onClick={() => switchTo('full')}
        title="Show the whole run as one diagram"
      >
        Full diagram
      </button>
    </div>
  );
}

/** The docs "?" panel: `openDocs` goes to a renderer, `docsPanel` is drawn next to the diagram. */
export function useDocs() {
  const model = useStore((s) => s.model);
  const log = useStore((s) => s.log);
  const step = useStore((s) => s.step);
  const [docs, setDocs] = useState<{ target: DocTarget; nodeId: string } | null>(null);
  const docsOpener = useRef<Element | null>(null);
  const closeDocs = useCallback(() => {
    setDocs(null);
    const o = docsOpener.current;
    docsOpener.current = null;
    if (o instanceof HTMLElement || o instanceof SVGElement) o.focus();
  }, []);
  const openDocs = useCallback((t: MethodDocTarget, nodeId: string) => {
    docsOpener.current ??= document.activeElement;
    setDocs({ target: docRequest(t, useStore.getState().runSource), nodeId });
  }, []);
  const docsPanel = docs ? (
    <DocsPanel
      target={docs.target}
      nodeId={docs.nodeId}
      model={model}
      log={log}
      step={step}
      onClose={closeDocs}
    />
  ) : null;
  return { openDocs, docsPanel };
}
