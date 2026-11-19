import type { Doc, DocSection, DocTarget, EventLog, GraphModel } from '@machines/log';
import { stateAt } from '@machines/log';
import { useEffect, useMemo, useRef, useState } from 'react';
import { currentRuntime } from '../runtime/instance';
import { clampStep } from '../timeline/steps';
import './docs.css';
import { entryNames, inlinePieces, paragraphs, passedParams, shortSignature } from './model';

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlinePieces(text).map((p, i) =>
        p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}
function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).map((p, i) => (
        <p key={i} className="doc-p">
          <Inline text={p} />
        </p>
      ))}
    </>
  );
}

const OPEN_BY_DEFAULT = new Set(['Parameters', 'Returns', 'Yields']);

function Section({ sec, passed }: { sec: DocSection; passed: Map<string, string> }) {
  const isParams = sec.title === 'Parameters';
  let body: React.ReactNode;
  switch (sec.kind) {
    case 'entries':
      body = (
        <dl className="doc-entries">
          {sec.entries.map((e, i) => {
            const val = isParams
              ? entryNames(e.name)
                  .map((n) => passed.get(n))
                  .find((v) => v !== undefined)
              : undefined;
            return (
              <div key={i} className={val !== undefined ? 'doc-entry passed' : 'doc-entry'}>
                <dt>
                  {e.name !== '' && <code>{e.name}</code>}
                  {e.type !== '' && <span className="doc-type"> <span className="md-type-tag">{e.type}</span></span>}
                  {val !== undefined && (
                    <span className="doc-passed">
                      {' '}
                      Passed here: <code>{val}</code>
                    </span>
                  )}
                </dt>
                {e.desc !== '' && (
                  <dd>
                    <Paragraphs text={e.desc} />
                  </dd>
                )}
              </div>
            );
          })}
        </dl>
      );
      break;
    case 'seealso':
      body = (
        <ul className="doc-seealso">
          {sec.items.map((it, i) => (
            <li key={i}>
              <code>{it.name}</code>
              {it.desc !== '' && <> {it.desc}</>}
            </li>
          ))}
        </ul>
      );
      break;
    case 'examples':
      body = (
        <>
          {sec.blocks.map((b, i) =>
            b.kind === 'code' ? (
              <pre key={i} className="doc-code" tabIndex={0}>
                {b.text}
              </pre>
            ) : (
              <Paragraphs key={i} text={b.text} />
            ),
          )}
        </>
      );
      break;
    case 'text':
      body = <Paragraphs text={sec.text} />;
      break;
  }
  return (
    <details className="doc-section" open={OPEN_BY_DEFAULT.has(sec.title)}>
      <summary>{sec.title}</summary>
      {body}
    </details>
  );
}

type Load =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; doc: Doc };

export interface DocsPanelProps {
  target: DocTarget;
  /** The box the docs were opened from: its call's passed parameters are highlighted. */
  nodeId: string;
  model: GraphModel | null;
  log: EventLog | null;
  step: number;
  onClose(): void;
}

export function DocsPanel({ target, nodeId, model, log, step, onClose }: DocsPanelProps) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    const rt = currentRuntime();
    if (!rt) {
      setLoad({ state: 'error', message: 'Python is not running yet.' });
      return;
    }
    rt.docs(target).then(
      (doc) => live && setLoad({ state: 'ready', doc }),
      (e: unknown) =>
        live && setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [target, attempt]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [target]);

  const passed = useMemo(() => {
    if (!model || !log) return new Map<string, string>();
    const st = stateAt(model, log, clampStep(step, model.steps.length));
    return passedParams(model, log, st, nodeId, target);
  }, [model, log, step, nodeId, target]);

  const doc = load.state === 'ready' ? load.doc : null;
  const sig = doc ? shortSignature(doc.signature) : null;
  return (
    <aside
      className="docs-panel"
      aria-label="Documentation"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="docs-head">
        <h2 ref={headingRef} tabIndex={-1}>
          {doc?.qualname ?? target.name}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close documentation"
          title="Close (Esc)"
        >
          Close
        </button>
      </header>
      {doc?.url && (
        <p className="doc-link">
          <a href={doc.url} target="_blank" rel="noopener noreferrer">
            Full documentation <span aria-hidden="true">↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}
      <div className="docs-body">
        {load.state === 'loading' && (
          <p className="muted" role="status">
            <span className="spinner" aria-hidden="true" /> Loading documentation…
          </p>
        )}
        {load.state === 'error' && (
          <div role="alert">
            <p>Could not load the documentation: {load.message}</p>
            <button type="button" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
          </div>
        )}
        {doc && (
          <>
            {sig && (
              <pre className="doc-sig" title={sig.cut ? (doc.signature ?? undefined) : undefined}>
                {sig.text}
              </pre>
            )}
            {doc.source === 'none' ? (
              <p className="muted">No documentation was found for {target.name}.</p>
            ) : (
              <>
                {doc.summary !== '' && (
                  <p className="doc-summary">
                    <Inline text={doc.summary} />
                  </p>
                )}
                {doc.description !== '' && <Paragraphs text={doc.description} />}
                {passed.size > 0 && (
                  <p className="muted doc-note">
                    Parameters this call passed are marked, with their values at the step shown.
                  </p>
                )}
                {doc.sections.map((sec, i) => (
                  <Section key={`${sec.title}${i}`} sec={sec} passed={passed} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
