import { stateAt, type ValueSummary } from '@machines/log';
import { attrDocTarget } from '@machines/render';
import { useContext, useEffect, useMemo, useState } from 'react';
import { DocsOpenerContext } from '../docs/opener';
import { useStore } from '../store';
import { clampStep } from '../timeline/steps';
import './inspect.css';
import { attrRows, inspectTarget, valueLine, type AttrRow } from './model';
import { ValueBody } from './Preview';

/**
 * Side panel: the attributes of an instance before and after the selected method call. It shows for a
 * clicked instance box, and when the step is a method call on an instance. Changed attributes are bold,
 * carry a "●" and the word "changed" (never colour alone). Each value opens its preview.
 */
export function InstanceDiff() {
  const model = useStore((s) => s.model);
  const log = useStore((s) => s.log);
  const step = useStore((s) => s.step);
  const selected = useStore((s) => s.selection.node);
  // the two-pane stage already marks the owner's changed attributes: the panel opens on a click or Enter only
  const explicitOnly = useStore((s) => s.view) === 'two';
  const [open, setOpen] = useState<string | null>(null);
  const [dismissed, setDismissedKey] = useState<string | null>(null);
  const setDismissed = (k: string | null) => {
    setDismissedKey(k);
    // two-pane: the panel belongs to the clicked card, so closing it forgets the selection
    if (explicitOnly) useStore.setState({ selection: {} });
  };
  const openDocsFn = useContext(DocsOpenerContext);

  const state = useMemo(
    () => (model && log ? stateAt(model, log, clampStep(step, model.steps.length)) : null),
    [model, log, step],
  );
  const target = useMemo(
    () =>
      model && log && state && !(explicitOnly && !selected)
        ? inspectTarget(model, log, state, selected)
        : null,
    [model, log, state, selected, explicitOnly],
  );
  const key = target ? `${target.node.id}@${state?.current ?? ''}` : null;
  const visible = target !== null && dismissed !== key;
  // Esc closes the panel too (a pinned preview takes the first Esc)
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useStore.getState().selection.edge) return;
      setDismissed(key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, key]);
  if (!target || !log || !visible) return null;

  const rows = attrRows(target.before, target.after, log.values);
  const title = target.node.varName ?? target.node.className;
  const changedCount = rows.filter((r) => r.changed).length;
  const toggle = (id: string) => setOpen(open === id ? null : id);
  const openDocs = (name: string) => {
    if (model && openDocsFn) openDocsFn(attrDocTarget(model, target.node, name), target.node.id);
  };

  return (
    <aside className="inspect-panel" aria-label={`Attributes of ${title}`}>
      <header className="inspect-head">
        <h2>
          {title} <span className="inspect-class">{target.node.className}</span>
        </h2>
        <button type="button" onClick={() => setDismissed(key)} aria-label="Close attributes panel">
          ×
        </button>
      </header>
      <p className="inspect-sub" role="status">
        {target.call
          ? changedCount > 0
            ? `${changedCount} attribute${changedCount === 1 ? '' : 's'} changed by this call`
            : 'This call changed no attributes'
          : 'Attributes at this step'}
      </p>
      {rows.length === 0 ? (
        <p className="inspect-empty">No attributes yet.</p>
      ) : (
        <table className="inspect-table">
          <thead>
            <tr>
              <th scope="col">Attribute</th>
              {target.call && <th scope="col">Before</th>}
              <th scope="col">{target.call ? 'After' : 'Value'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <AttrRowView
                key={r.name}
                row={r}
                call={target.call}
                values={log.values}
                open={open}
                onToggle={toggle}
                onDocs={openDocsFn ? openDocs : undefined}
              />
            ))}
          </tbody>
        </table>
      )}
    </aside>
  );
}

/**
 * One attribute: its name (never broken mid-word: it is cut with an ellipsis and carries a title), the
 * before and after values as buttons, and the inline preview of the value that is open.
 */
/** `valueLine` shows a type (and shape) rather than a repr: draw it with the type signifier (svl-465). */
const isTypeLine = (v: ValueSummary | undefined): boolean =>
  v !== undefined && !(v.repr !== undefined && v.shape === undefined);

export function AttrRowView({
  row,
  call,
  values,
  open,
  onToggle,
  onDocs,
}: {
  row: AttrRow;
  call: boolean;
  values: Record<string, ValueSummary>;
  open: string | null;
  onToggle(id: string): void;
  /** Opens the docs of this attribute (the "?" button, or the "?" key on the row). */
  onDocs?(name: string): void;
}) {
  const cell = (side: 'before' | 'after', tok: string | null, changed: boolean) => {
    if (tok === null) return <span className="pv-none">not set</span>;
    const id = `${row.name}/${side}`;
    return (
      <button
        type="button"
        className={`pv-val${changed ? ' changed' : ''}`}
        aria-expanded={open === id}
        title="Show a preview of this value"
        onClick={() => onToggle(id)}
      >
        {isTypeLine(values[tok]) ? (
          <span className="md-type-tag">{valueLine(values[tok])}</span>
        ) : (
          valueLine(values[tok])
        )}
      </button>
    );
  };
  const openSide =
    open === `${row.name}/before`
      ? row.before
      : open === `${row.name}/after`
        ? row.after
        : undefined;
  return (
    <>
      <tr
        className={row.changed ? 'changed' : undefined}
        onKeyDown={(e) => {
          if (e.key === '?' && onDocs && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            onDocs(row.name);
          }
        }}
      >
        <th scope="row">
          {row.changed && (
            <span className="inspect-flag">
              <span aria-hidden="true">● </span>
              <span className="inspect-changed">changed</span>
            </span>
          )}
          <div className="inspect-namerow">
            <code className="inspect-name" title={row.name}>
              {row.name}
            </code>
            {onDocs && (
              <button
                type="button"
                className="inspect-docs"
                aria-label={`Documentation for ${row.name}`}
                aria-keyshortcuts="?"
                title="Show documentation"
                onClick={() => onDocs(row.name)}
              >
                ?
              </button>
            )}
          </div>
        </th>
        {call && <td>{cell('before', row.before, false)}</td>}
        <td>{cell('after', row.after, row.changed)}</td>
      </tr>
      {openSide !== undefined && (
        <tr className="inspect-preview">
          <td colSpan={call ? 3 : 2}>
            <ValueBody value={openSide === null ? undefined : values[openSide]} />
          </td>
        </tr>
      )}
    </>
  );
}
