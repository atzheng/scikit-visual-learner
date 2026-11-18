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
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { siteAt, siteRange, sitesValid, type SpanSite } from './spans';

/** The editor's imperative API (the "small controller"): the diagram/timeline sync drives it. */
export interface EditorController {
  /** Highlight the exact span of a site (the current event); null clears it. Scrolls it into view. */
  highlightSite(site: SpanSite | null): void;
  /** Mark a 1-based line as the error line; null clears it. */
  markErrorLine(line: number | null): void;
  /** Move the cursor to the start of a site and focus the editor. */
  revealSite(site: SpanSite): void;
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

const siteHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    // A highlight refers to the run's source: drop it on any edit rather than let it drift.
    deco = tr.docChanged ? Decoration.none : deco;
    for (const e of tr.effects) {
      if (e.is(setSiteHighlight)) {
        const v = e.value;
        deco =
          v && v.to > v.from ? Decoration.set([siteMark.range(v.from, v.to)]) : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
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
    backgroundColor: 'var(--hl-site)',
    borderBottom: '2px solid var(--accent)',
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
      lineNumbers(),
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
    };
    if (controllerRef) controllerRef.current = controller;
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
