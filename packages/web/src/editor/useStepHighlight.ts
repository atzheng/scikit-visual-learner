import { stateAt } from '@machines/log';
import { useEffect, useMemo, type RefObject } from 'react';
import { useStore } from '../store';
import { stepsByLine } from '../timeline/rail';
import { clampStep, eventSiteId } from '../timeline/steps';
import type { EditorController } from './Editor';

/** Highlights the current step's call site in the editor and feeds the gutter timeline rail. */
export function useStepHighlight(editor: RefObject<EditorController | null>): void {
  const log = useStore((s) => s.log);
  const model = useStore((s) => s.model);
  const step = useStore((s) => s.step);
  const lines = useMemo(() => (log && model ? stepsByLine(model, log) : null), [log, model]);
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    const max = model?.steps.length ?? 0;
    ed.setRail(lines ? { lines, cur: clampStep(step, max), max } : null);
  }, [editor, lines, model, step]);
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    if (!log || !model) return ed.highlightSite(null);
    const { current } = stateAt(model, log, clampStep(step, model.steps.length));
    const siteId = current === null ? null : eventSiteId(log, current);
    ed.highlightSite(siteId === null ? null : (log.sites[siteId] ?? null));
  }, [editor, log, model, step]);
}
