import { stateAt } from '@machines/log';
import { Fragment, useMemo, useState } from 'react';
import { useStore } from '../store';
import { clampStep } from '../timeline/steps';
import './inspect.css';
import { attrRows, inspectTarget, valueLine } from './model';
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
  const [open, setOpen] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const state = useMemo(
    () => (model && log ? stateAt(model, log, clampStep(step, model.steps.length)) : null),
    [model, log, step],
  );
  const target = useMemo(
    () => (model && log && state ? inspectTarget(model, log, state, selected) : null),
    [model, log, state, selected],
  );
  if (!target || !log) return null;
  const key = `${target.node.id}@${state?.current ?? ''}`;
  if (dismissed === key) return null;

  const rows = attrRows(target.before, target.after, log.values);
  const title = target.node.varName ?? target.node.className;
  const changedCount = rows.filter((r) => r.changed).length;
  const toggle = (id: string) => setOpen(open === id ? null : id);

  const cell = (name: string, side: 'before' | 'after', tok: string | null, changed: boolean) => {
    if (tok === null) return <span className="pv-none">not set</span>;
    const id = `${name}/${side}`;
    return (
      <button
        type="button"
        className={`pv-val${changed ? ' changed' : ''}`}
        aria-expanded={open === id}
        title="Show a preview of this value"
        onClick={() => toggle(id)}
      >
        {valueLine(log.values[tok])}
      </button>
    );
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
              <Fragment key={r.name}>
                <tr className={r.changed ? 'changed' : undefined}>
                  <th scope="row">
                    {r.changed && (
                      <>
                        <span aria-hidden="true">● </span>
                        <span className="inspect-changed">changed</span>{' '}
                      </>
                    )}
                    <code>{r.name}</code>
                  </th>
                  {target.call && <td>{cell(r.name, 'before', r.before, false)}</td>}
                  <td>{cell(r.name, 'after', r.after, r.changed)}</td>
                </tr>
                {[`${r.name}/before`, `${r.name}/after`].includes(open ?? '') && (
                  <tr className="inspect-preview">
                    <td colSpan={target.call ? 3 : 2}>
                      <ValueBody
                        value={log.values[(open!.endsWith('/before') ? r.before : r.after) ?? '']}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </aside>
  );
}
