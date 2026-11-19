import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  GutterMarker,
  gutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { chipTarget, railCell, type RailCell } from '../timeline/rail';
import { clampStep, stepForKey } from '../timeline/steps';
import { siteAt, siteRange, sitesValid, type SpanSite } from './spans';

/** What the timeline rail shows: per 1-based line the steps run there, and the current step. */
export interface RailData {
  lines: ReadonlyMap<number, readonly number[]>;
  cur: number;
  max: number;
}

/** The editor's imperative API (the "small controller"): the diagram/timeline sync drives it. */
export interface EditorController {
  /** Highlight the exact span of a site (the current event); null clears it. Scrolls it into view. */
  highlightSite(site: SpanSite | null): void;
  /** Show the timeline rail in the gutter (null clears it). Ignored when the code was edited since the run. */
  setRail(rail: RailData | null): void;
  /** Mark a 1-based line as the error line; null clears it. */
  markErrorLine(line: number | null): void;
  /** Move the cursor to the start of a site and focus the editor. */
  revealSite(site: SpanSite): void;
  /** Move the cursor to the start of a 1-based line, mark it as the error line and focus the editor. */
  revealLine(line: number): void;
}

export interface EditorProps {
  /** Call sites of the last run, used to map the cursor to a site. Positions refer to `runSource`. */
  sites?: readonly SpanSite[];
  /**
   * The source text at Run time. Sites are valid only while the document equals it. After any edit
   * `onSiteAtCursor` reports null and `highlightSite`/`revealSite` do nothing (a missing link is
   * fine, a wrong one is not).
   */
  runSource?: string;
  /** Debounced report of the innermost call site under the cursor (null when none). */
  onSiteAtCursor?(site: SpanSite | null): void;
  /** Receives the controller once the view exists. */
  controllerRef?: { current: EditorController | null };
}

const CURSOR_DEBOUNCE_MS = 120;

const setSiteHighlight = StateEffect.define<{ from: number; to: number } | null>();
const setErrorLine = StateEffect.define<number | null>();

const siteMark = Decoration.mark({ class: 'cm-site-highlight' });
const errorLineDeco = Decoration.line({ class: 'cm-error-line' });

const stepLineDeco = Decoration.line({ class: 'cm-step-line' });

class StepMarker extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement('span');
    el.textContent = '▶';
    el.className = 'cm-step-marker';
    return el;
  }
}
const stepMarker = new StepMarker();

const siteHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    // A highlight refers to the run's source: drop it on any edit rather than let it drift.
    deco = tr.docChanged ? Decoration.none : deco;
    for (const e of tr.effects) {
      if (e.is(setSiteHighlight)) {
        const v = e.value;
        deco =
          v && v.to > v.from
            ? Decoration.set([
                stepLineDeco.range(tr.state.doc.lineAt(v.from).from),
                siteMark.range(v.from, v.to),
              ])
            : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Gutter marker (a triangle, so not colour alone) on the current step's first line. */
const stepGutter = gutter({
  class: 'cm-step-gutter',
  lineMarker(view, line) {
    let hit = false;
    view.state.field(siteHighlightField).between(line.from, line.from, (from, _to, value) => {
      if (from === line.from && value === stepLineDeco) hit = true;
    });
    return hit ? stepMarker : null;
  },
  lineMarkerChange: (u) =>
    u.startState.field(siteHighlightField) !== u.state.field(siteHighlightField),
  initialSpacer: () => stepMarker,
});

const setRail = StateEffect.define<RailData | null>();

/** Rail data refers to the run's source: it clears on any edit, like the highlight. */
const railField = StateField.define<RailData | null>({
  create: () => null,
  update(v, tr) {
    if (tr.docChanged) v = null;
    for (const e of tr.effects) if (e.is(setRail)) v = e.value;
    return v;
  },
});

/**
 * One line's dots. Shapes differ, not just colours: ran is filled, current is a larger ring with a
 * centre, not yet reached is hollow. The chip shows "xn", or "k of n" while one of them is current.
 */
class RailMarker extends GutterMarker {
  constructor(readonly cell: RailCell) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof RailMarker && JSON.stringify(other.cell) === JSON.stringify(this.cell);
  }
  override toDOM(): Node {
    const el = document.createElement('span');
    el.className = 'cm-rail-cell';
    const c = this.cell;
    if (c.mode === 'chip') {
      const chip = document.createElement('span');
      chip.className = 'cm-rail-chip' + (c.k !== null ? ' current' : '');
      chip.dataset['chip'] = '1';
      chip.textContent = c.k !== null ? `${c.k} of ${c.n}` : `\u00d7${c.n}`;
      chip.title =
        c.k !== null
          ? `Execution ${c.k} of ${c.n}. Click for the next.`
          : `Ran ${c.n} times. Click to step into it.`;
      el.append(chip);
      return el;
    }
    for (const d of c.dots) {
      const dot = document.createElement('span');
      dot.className = `cm-rail-dot ${d.state}`;
      dot.dataset['step'] = String(d.step);
      dot.title = `Step ${d.step}` + (d.state === 'current' ? ' (current)' : '');
      el.append(dot);
    }
    return el;
  }
}

const railGutter = gutter({
  class: 'cm-rail-gutter',
  lineMarker(view, line) {
    const rail = view.state.field(railField);
    if (!rail) return null;
    const steps = rail.lines.get(view.state.doc.lineAt(line.from).number);
    return steps && steps.length ? new RailMarker(railCell(steps, rail.cur)) : null;
  },
  lineMarkerChange: (u) => u.startState.field(railField) !== u.state.field(railField),
  domEventHandlers: {
    mousedown(view, line, event) {
      const rail = view.state.field(railField);
      const target = event.target as HTMLElement | null;
      if (!rail || !target) return false;
      const dot = target.closest<HTMLElement>('[data-step]');
      let to: number | null = null;
      if (dot) to = Number(dot.dataset['step']);
      else if (target.closest('[data-chip]')) {
        const steps = rail.lines.get(view.state.doc.lineAt(line.from).number);
        to = steps ? chipTarget(steps, rail.cur) : null;
      }
      if (to === null) return false;
      event.preventDefault();
      (view.dom.querySelector('.cm-rail-gutter') as HTMLElement | null)?.focus();
      useStore.getState().setStep(to);
      return true;
    },
  },
});

const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) {
        const n = e.value;
        deco =
          n !== null && n >= 1 && n <= tr.state.doc.lines
            ? Decoration.set([errorLineDeco.range(tr.state.doc.line(n).from)])
            : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Colours come from CSS variables, so one theme serves light and dark. */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    fontSize: '13px',
  },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused': { outline: '3px solid var(--focus)', outlineOffset: '-3px' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent', boxShadow: 'inset 0 -1px 0 var(--border)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text)',
    fontWeight: '600',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    {
      backgroundColor: 'var(--hl-site)',
    },
  '.cm-matchingBracket': { outline: '1px solid var(--muted)', backgroundColor: 'transparent' },
  // Not colour alone: the site gets a bottom border as well as a fill.
  '.cm-site-highlight': {
    backgroundColor: 'var(--hl-span)',
    borderBottom: '2px solid var(--accent)',
    boxShadow: '0 0 0 1px var(--accent)',
    borderRadius: '2px',
  },
  '.cm-step-line': {
    backgroundColor: 'var(--hl-line)',
    boxShadow: 'inset 3px 0 0 var(--accent)',
  },
  '.cm-step-gutter': { width: '1.2em', textAlign: 'center' },
  '.cm-step-marker': { color: 'var(--accent)', fontWeight: '700' },
  '.cm-rail-gutter': { padding: '0 4px' },
  '.cm-rail-gutter:focus-visible': { outline: '3px solid var(--focus)', outlineOffset: '-3px' },
  '.cm-rail-cell': { display: 'inline-flex', alignItems: 'center', gap: '2px', height: '100%' },
  '.cm-rail-dot': {
    boxSizing: 'border-box',
    width: '9px',
    height: '9px',
    borderRadius: '50%',
    border: '1.5px solid var(--accent)',
    cursor: 'pointer',
  },
  '.cm-rail-dot.ran': { backgroundColor: 'var(--accent)' },
  '.cm-rail-dot.pending': { backgroundColor: 'transparent', borderColor: 'var(--muted)' },
  '.cm-rail-dot.current': {
    width: '13px',
    height: '13px',
    backgroundColor: 'var(--accent)',
    boxShadow: 'inset 0 0 0 2px var(--surface)',
    borderWidth: '2px',
  },
  '.cm-rail-chip': {
    cursor: 'pointer',
    fontSize: '11px',
    lineHeight: '15px',
    padding: '0 5px',
    borderRadius: '8px',
    border: '1.5px solid var(--muted)',
    color: 'var(--muted)',
    whiteSpace: 'nowrap',
  },
  '.cm-rail-chip.current': {
    border: '2px solid var(--accent)',
    color: 'var(--text)',
    fontWeight: '700',
    boxShadow: 'inset 0 0 0 1px var(--accent)',
  },
  '.cm-error-line': {
    backgroundColor: 'var(--hl-error)',
    boxShadow: 'inset 3px 0 0 var(--bad)',
  },
});

const highlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.operatorKeyword],
    color: 'var(--syn-keyword)',
  },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)],
    color: 'var(--syn-func)',
  },
]);

export function Editor({ sites, runSource, onSiteAtCursor, controllerRef }: EditorProps = {}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyRef = useRef(new Compartment());
  const source = useStore((s) => s.source);
  const setSource = useStore((s) => s.setSource);
  const running = useStore((s) => s.running);

  // Latest props for callbacks created once.
  const latest = useRef({ sites, runSource, onSiteAtCursor });
  latest.current = { sites, runSource, onSiteAtCursor };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let devOverride: typeof latest.current | undefined; // set by the dev hook only

    const reportCursor = (view: EditorView) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { sites: ss, runSource: rs, onSiteAtCursor: cb } = devOverride ?? latest.current;
        if (!cb) return;
        const doc = view.state.doc.toString();
        cb(ss && sitesValid(rs, doc) ? siteAt(ss, view.state.selection.main.head, doc) : null);
      }, CURSOR_DEBOUNCE_MS);
    };

    let escaped = false;
    const tabOrLeave = (v: EditorView, indent: (v: EditorView) => boolean) => {
      if (escaped || v.state.readOnly) {
        escaped = false;
        return false; // let the browser move focus
      }
      return indent(v);
    };
    const runFromKeyboard = () => {
      const s = useStore.getState();
      if (!s.running) void s.run();
      return true;
    };
    const runKeys = keymap.of([
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: runFromKeyboard,
      },
      // Ctrl+Enter also runs on macOS, where Mod is Cmd.
      { key: 'Ctrl-Enter', preventDefault: true, run: runFromKeyboard },
    ]);

    const extensions: Extension[] = [
      runKeys,
      stepGutter,
      lineNumbers(),
      railField,
      railGutter,
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      python(),
      syntaxHighlighting(highlightStyle),
      // Esc then Tab leaves the editor (WCAG 2.1.2); Tab alone indents. Read-only: Tab always leaves.
      EditorView.domEventHandlers({
        keydown(e) {
          if (e.key === 'Escape') escaped = true;
          else if (e.key !== 'Tab') escaped = false;
          return false;
        },
      }),
      keymap.of([
        { key: 'Tab', run: (v) => tabOrLeave(v, indentMore) },
        { key: 'Shift-Tab', run: (v) => tabOrLeave(v, indentLess) },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      theme,
      siteHighlightField,
      errorLineField,
      readOnlyRef.current.of(EditorState.readOnly.of(useStore.getState().running)),
      EditorView.contentAttributes.of({
        'aria-label': 'Python code',
        'aria-describedby': 'editor-tab-hint',
        spellcheck: 'false',
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const el = u.view.dom.querySelector('.cm-rail-gutter');
          el?.removeAttribute('tabindex');
          el?.removeAttribute('role');
          const text = u.state.doc.toString();
          if (text !== useStore.getState().source) setSource(text);
        }
        if (u.selectionSet || u.docChanged) reportCursor(u.view);
      }),
    ];

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: useStore.getState().source, extensions }),
    });
    viewRef.current = view;

    const controller: EditorController = {
      highlightSite(site) {
        const doc = view.state.doc.toString();
        const valid = sitesValid((devOverride ?? latest.current).runSource, doc);
        if (site && !valid) return;
        const range = site ? siteRange(doc, site) : null;
        view.dispatch({
          effects: [
            setSiteHighlight.of(range),
            ...(range
              ? [EditorView.scrollIntoView(range.from, { y: 'nearest', yMargin: 24 })]
              : []),
          ],
        });
      },
      setRail(rail) {
        const valid = sitesValid(
          (devOverride ?? latest.current).runSource,
          view.state.doc.toString(),
        );
        const r = rail && valid && rail.lines.size > 0 ? rail : null;
        view.dispatch({ effects: setRail.of(r) });
        const el = view.dom.querySelector<HTMLElement>('.cm-rail-gutter');
        if (!el) return;
        if (!r) {
          el.removeAttribute('tabindex');
          el.removeAttribute('role');
          return;
        }
        el.tabIndex = 0;
        el.setAttribute('role', 'slider');
        el.setAttribute('aria-orientation', 'vertical');
        el.setAttribute(
          'aria-label',
          'Timeline rail: Down or j for the next step, Up or k for the previous',
        );
        el.setAttribute('aria-valuemin', '0');
        el.setAttribute('aria-valuemax', String(r.max));
        el.setAttribute('aria-valuenow', String(r.cur));
        el.setAttribute('aria-valuetext', `Step ${r.cur} of ${r.max}`);
      },
      markErrorLine(line) {
        view.dispatch({ effects: setErrorLine.of(line) });
      },
      revealSite(site) {
        const doc = view.state.doc.toString();
        if (!sitesValid((devOverride ?? latest.current).runSource, doc)) return;
        const range = siteRange(doc, site);
        if (!range) return;
        view.dispatch({ selection: { anchor: range.from }, scrollIntoView: true });
        view.focus();
      },
      revealLine(line) {
        if (line < 1 || line > view.state.doc.lines) return;
        const from = view.state.doc.line(line).from;
        view.dispatch({
          selection: { anchor: from },
          effects: setErrorLine.of(line),
          scrollIntoView: true,
        });
        view.focus();
      },
    };
    if (controllerRef) controllerRef.current = controller;
    const railEl = view.dom.querySelector<HTMLElement>('.cm-rail-gutter');
    const onRailKey = (e: KeyboardEvent) => {
      const { model, step } = useStore.getState();
      const max = model?.steps.length ?? 0;
      const cur = clampStep(step, max);
      const next = stepForKey(e, cur, max, { rail: true });
      if (next === null) return;
      e.preventDefault();
      useStore.getState().setStep(next);
    };
    railEl?.addEventListener('keydown', onRailKey);
    // The skip link focuses the pane (tabIndex -1); hand focus on to the editor.
    const pane = host.parentElement;
    const onPaneFocus = (e: FocusEvent) => {
      if (e.target === pane) view.focus();
    };
    pane?.addEventListener('focus', onPaneFocus);
    // Dev hook for manual checks: window.__machinesEditor.highlightSite({line, col, end_line, end_col}).
    if (import.meta.env.DEV) {
      type Dev = EditorController & {
        devSites(sites: SpanSite[], cb: (s: SpanSite | null) => void): void;
      };
      const dev: Dev = {
        ...controller,
        devSites(ss, cb) {
          devOverride = { sites: ss, runSource: view.state.doc.toString(), onSiteAtCursor: cb };
        },
      };
      (window as unknown as { __machinesEditor?: Dev }).__machinesEditor = dev;
    }

    return () => {
      clearTimeout(timer);
      pane?.removeEventListener('focus', onPaneFocus);
      railEl?.removeEventListener('keydown', onRailKey);
      if (controllerRef) controllerRef.current = null;
      if (import.meta.env.DEV)
        delete (window as unknown as { __machinesEditor?: EditorController }).__machinesEditor;
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; props flow through `latest`.
  }, []);

  // Source replaced from outside (upload, share link, starter): sync into the document.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    if (doc !== source) view.dispatch({ changes: { from: 0, to: doc.length, insert: source } });
  }, [source]);

  // Read-only while running: the run is of the source at Run time.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyRef.current.reconfigure(EditorState.readOnly.of(running)),
    });
  }, [running]);

  return (
    <>
      <div className="editor-host" ref={hostRef} />
      <span id="editor-tab-hint" className="visually-hidden">
        Tab indents. To leave the editor with the keyboard, press Escape, then Tab. Control or
        Command plus Enter runs the code.
      </span>
    </>
  );
}
