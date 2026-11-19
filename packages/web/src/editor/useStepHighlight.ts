import { stateAt } from '@machines/log';
import { useEffect, type RefObject } from 'react';
import { useStore } from '../store';
import { clampStep, eventSiteId } from '../timeline/steps';
import type { EditorController } from './Editor';

/** Highlights the current step's call site in the editor (the exact source span). */
export function useStepHighlight(editor: RefObject<EditorController | null>): void {
  const log = useStore((s) => s.log);
  const model = useStore((s) => s.model);
  const step = useStore((s) => s.step);
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    if (!log || !model) return ed.highlightSite(null);
    const { current } = stateAt(model, log, clampStep(step, model.steps.length));
    const siteId = current === null ? null : eventSiteId(log, current);
    ed.highlightSite(siteId === null ? null : (log.sites[siteId] ?? null));
  }, [editor, log, model, step]);
}
