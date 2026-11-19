// SVG renderer (CONTRACTS.md section 8, SPEC "Visual style"). `buildSvg` draws every node and wire once, hidden;
// `applyState` then only toggles classes and text for a timeline step. It never re-lays-out.
// The pure helpers (path building, label text, attribute rows, status) have no DOM dependency.
import type {
  CallNode,
  EventLog,
  Execution,
  GEdge,
  GNode,
  GraphModel,
  InstanceNode,
  StepState,
  Token,
  ValueSummary,
} from '@machines/log';
import { M, instanceTitle } from './layout';
import type { Laid, LaidNode } from './layout';

export const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------------------------
// Pure helpers

/** Orthogonal polyline as an SVG path with rounded corners (radius clipped to half the shorter segment). */
export function roundedPath(points: [number, number][], radius = 8): string {
  if (points.length === 0) return '';
  const f = (n: number): string => String(Math.round(n * 100) / 100);
  const p0 = points[0]!;
  let d = `M${f(p0[0])} ${f(p0[1])}`;
  for (let k = 1; k < points.length; k++) {
    const cur = points[k]!;
    const prev = points[k - 1]!;
    const next = points[k + 1];
    if (!next) {
      d += `L${f(cur[0])} ${f(cur[1])}`;
      break;
    }
    const l1 = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const l2 = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5 || l1 === 0 || l2 === 0) {
      d += `L${f(cur[0])} ${f(cur[1])}`;
      continue;
    }
    const ax = cur[0] - ((cur[0] - prev[0]) / l1) * r;
    const ay = cur[1] - ((cur[1] - prev[1]) / l1) * r;
    const bx = cur[0] + ((next[0] - cur[0]) / l2) * r;
    const by = cur[1] + ((next[1] - cur[1]) / l2) * r;
    d += `L${f(ax)} ${f(ay)}Q${f(cur[0])} ${f(cur[1])} ${f(bx)} ${f(by)}`;
  }
  return d;
}

export interface LabelAnchor {
  x: number;
  y: number;
  anchor: 'start' | 'middle';
}
/** Where a wire's label goes: beside the middle of its longest segment. */
export function labelAnchor(points: [number, number][]): LabelAnchor | null {
  let best = -1;
  let bestLen = -1;
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    if (len > bestLen) {
      bestLen = len;
      best = k;
    }
  }
  if (best < 0) return null;
  const a = points[best]!;
  const b = points[best + 1]!;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  if (a[0] === b[0]) {
    // long vertical run: hug the upper end (just under the producer, where ELK leaves the most room)
    const y = bestLen >= 60 ? Math.min(a[1], b[1]) + 22 : my + 4;
    return { x: mx + 7, y, anchor: 'start' };
  }
  return { x: mx, y: my - 6, anchor: 'middle' };
}

/** "DataFrame (120, 4)", "float 0.2". Empty when the value is unknown. */
export function summaryLabel(s: ValueSummary | undefined): string {
  if (!s) return '';
  if (s.shape && s.shape.length > 0) return `${s.type} (${s.shape.join(', ')})`;
  if (s.repr !== undefined && s.repr.length <= 14 && !s.machine) return `${s.type} ${s.repr}`;
  return s.type;
}

/** A wire's type text: scalars only. An object is a box that shows its own type and shape. */
export function wireTypeLabel(
  token: Token,
  values: Record<Token, ValueSummary> | undefined,
): string {
  return token.startsWith('v') ? '' : summaryLabel(values?.[token]);
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** "×30" at the end of the run, "3 of 30" while stepping. */
export function badgeText(k: number, n: number, atEnd: boolean): string {
  return atEnd ? `×${n}` : `${k} of ${n}`;
}

/** Names whose value differs between two attribute maps (or is new). */
export function changedAttrs(
  before: Record<string, Token> | undefined,
  after: Record<string, Token> | undefined,
  values?: Record<Token, ValueSummary>,
): Set<string> {
  const out = new Set<string>();
  if (!after) return out;
  for (const [k, v] of Object.entries(after)) {
    const b = before?.[k];
    if (b === v) continue;
    // Scalars get a fresh token at every snapshot: compare what they hold. References keep identity.
    if (b !== undefined && b.startsWith('s') && v.startsWith('s')) {
      const x = values?.[b];
      const y = values?.[v];
      if (x && y && x.type === y.type && x.repr !== undefined && x.repr === y.repr) continue;
    }
    out.add(k);
  }
  return out;
}

/** Splits text at spaces into lines of at most `max` characters (long words are cut). */
export function wrapText(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let word of text.split(' ')) {
    while (word.length > max) {
      if (cur) lines.push(cur);
      cur = '';
      lines.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (cur && cur.length + 1 + word.length > max) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

export interface AttrRow {
  name: string;
  /** Gray text after the name: the type for attributes, the value for constructor params. */
  detail: string;
  param: boolean;
  /** A data box's row (shape, dtype, columns): the value reads first, the label is muted. */
  data?: boolean;
}

/** Rows of an instance box at a version: constructor params first, then the version's attributes. */
export function instanceRowModels(
  node: InstanceNode,
  token: Token | undefined,
  values: Record<Token, ValueSummary> | undefined,
): AttrRow[] {
  const rows: AttrRow[] = node.params.map((p) => ({ name: p.name, detail: p.text, param: true }));
  const names = new Set(rows.map((r) => r.name));
  const attrs = token !== undefined ? values?.[token]?.attrs : undefined;
  if (attrs) {
    for (const [name, t] of Object.entries(attrs)) {
      if (names.has(name)) continue;
      rows.push({ name, detail: values?.[t]?.type ?? '', param: false });
    }
  } else if (token !== undefined) {
    rows.push(...dataRowModels(values?.[token]));
  }
  return rows;
}

const MAX_COLUMNS_TEXT = 26;
/**
 * Rows of a data box (DataFrame, Series, array, sparse), read from its summary only: `shape`, then `dtype`
 * (Series, array) or the first `columns` (DataFrame, cut at MAX_COLUMNS_TEXT characters, then "…").
 * Lists, dicts and models have none: the title carries the type and length.
 */
export function dataRowModels(s: ValueSummary | undefined): AttrRow[] {
  const rows: AttrRow[] = [];
  if (!s) return rows;
  if (s.shape && s.shape.length > 0)
    rows.push({ name: 'shape', detail: `(${s.shape.join(', ')})`, param: false, data: true });
  if (s.dtype) rows.push({ name: 'dtype', detail: s.dtype, param: false, data: true });
  else if (s.columns && s.columns.length > 0) {
    let text = '';
    let k = 0;
    for (; k < s.columns.length; k++) {
      const next = text ? `${text}, ${s.columns[k]}` : String(s.columns[k]);
      if (next.length > MAX_COLUMNS_TEXT && k > 0) break;
      text = next;
    }
    if (text.length > MAX_COLUMNS_TEXT) text = `${text.slice(0, MAX_COLUMNS_TEXT - 1)}…`;
    else if (k < s.columns.length) text += ', …';
    rows.push({ name: 'columns', detail: text, param: false, data: true });
  }
  return rows;
}

/** Row texts to reserve in `layout`: params plus the union of every version's attributes (box never resizes). */
export function attrRowsFor(model: GraphModel, log: EventLog): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of model.nodes) {
    if (n.kind !== 'instance') continue;
    const rows = new Map<string, string>();
    for (const r of instanceRowModels(n, undefined, log.values))
      rows.set(r.name, `${r.name} ${r.detail}`);
    for (const v of n.versions) {
      for (const r of instanceRowModels(n, v.token, log.values)) {
        const text = `${r.name} ${r.detail}`;
        if (!r.param && text.length >= (rows.get(r.name)?.length ?? 0)) rows.set(r.name, text);
      }
    }
    out[n.id] = [...rows.values()];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Method lists, ports of the active execution

export interface MethodEntry {
  name: string;
  doc: string;
}
/** What the docs panel needs to open the docs of a method listed under "more methods" (svl-3ms). */
export interface MethodDocTarget {
  module: string | null;
  /** `Class.method`, as an event of a method call names it. */
  name: string;
}

const objKey = (t: Token): string => {
  const k = t.indexOf('.');
  return k < 0 ? t : t.slice(0, k);
};
const lastName = (n: string): string => n.slice(n.lastIndexOf('.') + 1);

interface ModelIndex {
  instByObj: Map<string, InstanceNode>;
  kids: Map<string, CallNode[]>;
  outEdges: Map<string, GEdge[]>;
  ctors: Set<string>;
}
const modelIndexes = new WeakMap<GraphModel, ModelIndex>();
function modelIndex(model: GraphModel): ModelIndex {
  let ix = modelIndexes.get(model);
  if (ix) return ix;
  ix = { instByObj: new Map(), kids: new Map(), outEdges: new Map(), ctors: new Set() };
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const n of model.nodes) {
    if (n.kind === 'instance') {
      for (const v of n.versions)
        if (!ix.instByObj.has(objKey(v.token))) ix.instByObj.set(objKey(v.token), n);
      const by = n.createdBy !== null ? byId.get(n.createdBy) : undefined;
      if (by?.kind === 'call' && by.name === n.className) ix.ctors.add(by.id);
    } else if (n.kind === 'call' && n.parent !== null) {
      const l = ix.kids.get(n.parent);
      if (l) l.push(n);
      else ix.kids.set(n.parent, [n]);
    }
  }
  for (const e of model.edges) {
    if (e.from.port === null) continue;
    const k = `${e.from.node}|${e.from.port}`;
    const l = ix.outEdges.get(k);
    if (l) l.push(e);
    else ix.outEdges.set(k, [e]);
  }
  modelIndexes.set(model, ix);
  return ix;
}

/**
 * The public methods of an instance's class that its box does not draw: `values.methods` of the class
 * (written once per run on any value of that type), minus the method boxes the instance has.
 * Only machines get a list: a data class (DataFrame) lists its first 40 methods alphabetically, which is
 * not a meaningful "other methods" list.
 */
export function hiddenMethods(model: GraphModel, log: EventLog, inst: InstanceNode): MethodEntry[] {
  if (!inst.versions.some((v) => log.values[v.token]?.machine)) return [];
  let all: MethodEntry[] | undefined;
  for (const v of Object.values(log.values)) {
    if (v.type === inst.className && v.methods) {
      all = v.methods;
      break;
    }
  }
  if (!all) return [];
  const drawn = new Set((modelIndex(model).kids.get(inst.id) ?? []).map((c) => lastName(c.name)));
  return all.filter((m) => !drawn.has(m.name));
}

/** Instance id -> number of methods under "more methods" (only instances with at least one). Pass to `layout`. */
export function moreMethodsFor(model: GraphModel, log: EventLog): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of model.nodes) {
    if (n.kind !== 'instance') continue;
    const k = hiddenMethods(model, log, n).length;
    if (k > 0) out[n.id] = k;
  }
  return out;
}

/** Target for opening the docs of `method` of an instance's class. The module comes from the constructor box or a method box. */
export function methodDocTarget(
  model: GraphModel,
  inst: InstanceNode,
  method: string,
): MethodDocTarget {
  let module: string | null = null;
  const creator = model.nodes.find((n) => n.id === inst.createdBy);
  if (creator?.kind === 'call' && creator.name === inst.className) module = creator.module;
  if (module === null)
    module =
      modelIndex(model)
        .kids.get(inst.id)
        ?.find((c) => c.module)?.module ?? null;
  return { module, name: `${inst.className}.${method}` };
}

export interface PortView {
  /** False when the active execution did not use this port: it is drawn dimmed. */
  used: boolean;
  typeLabel: string;
  /** Gray name text (in-ports: the parameter, out-ports: the bound name). */
  name: string;
  /** Constant inputs: the whole `param = text` string. */
  constText?: string;
}

function eventAt(log: EventLog, i: number): EventLog['events'][number] | undefined {
  let lo = 0;
  let hi = log.events.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = log.events[mid]!;
    if (e.i === i) return e;
    if (e.i < i) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * What each port of a call box shows for one execution (CONTRACTS section 8): the const text, type and name
 * come from that execution, and ports it did not use are marked `used: false`. Without an execution or a
 * log (an uncalled box, or no log yet) every port shows the graph's own text and counts as used.
 */
export function portViews(
  model: GraphModel,
  node: CallNode,
  exec: Execution | undefined,
  log: EventLog | undefined,
): { in: Record<string, PortView>; out: Record<string, PortView> } {
  const inV: Record<string, PortView> = {};
  const outV: Record<string, PortView> = {};
  const ev = exec && log ? eventAt(log, exec.i) : undefined;
  const live = exec !== undefined && log !== undefined && ev !== undefined;
  for (const p of node.inPorts) {
    const base: PortView = { used: true, typeLabel: p.typeLabel, name: p.param };
    if (p.constText !== undefined) base.constText = p.constText;
    inV[p.id] = base;
    if (!live) continue;
    const tok = exec.inputs[p.id];
    if (tok !== undefined) {
      inV[p.id] = {
        used: true,
        typeLabel: tok.startsWith('v') ? '' : (log.values[tok]?.type ?? p.typeLabel),
        name: p.param,
      };
    } else if (p.constText !== undefined) {
      const x = ev.inputs.find(
        (i) => `in:${i.param}` === p.id && i.value === undefined && i.text !== undefined,
      );
      inV[p.id] = x
        ? { used: true, typeLabel: '', name: p.param, constText: `${x.param} = ${x.text}` }
        : { ...base, used: false };
    } else inV[p.id] = { ...base, used: false };
  }
  const ix = modelIndex(model);
  const lastExec = node.executions[node.executions.length - 1];
  for (const p of node.outPorts) {
    const base: PortView = { used: true, typeLabel: p.typeLabel, name: p.nameLabel ?? '' };
    outV[p.id] = base;
    if (!live) continue;
    const tok = exec.outputs[p.id];
    if (tok === undefined) {
      outV[p.id] = { ...base, used: false };
      continue;
    }
    if (tok.startsWith('v')) {
      outV[p.id] = {
        used: true,
        typeLabel: '',
        name: ix.instByObj.get(objKey(tok))?.varName ?? '',
      };
      continue;
    }
    const wire = (ix.outEdges.get(`${node.id}|${p.id}`) ?? []).find((e) =>
      e.uses.some((u) => u.token === tok),
    );
    outV[p.id] = {
      used: true,
      typeLabel: log.values[tok]?.type ?? p.typeLabel,
      name: wire ? (wire.nameLabel ?? '') : exec === lastExec ? (p.nameLabel ?? '') : '',
    };
  }
  return { in: inV, out: outV };
}

/** Type text to reserve for each wire label in `layout`: the longest `summaryLabel` over the edge's uses. */
export function edgeLabelsFor(model: GraphModel, log: EventLog): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of model.edges) {
    let best = '';
    for (const u of e.uses) {
      const t = wireTypeLabel(u.token, log.values);
      if (t.length > best.length) best = t;
    }
    out[e.id] = best;
  }
  return out;
}

export type StatusKind = 'error' | 'handled' | 'stopped';
export interface Status {
  kind: StatusKind;
  text: string;
}
/** Error, handled-error and interrupted markers come from the active execution. */
export function statusOf(exec: Execution | undefined): Status | null {
  if (!exec) return null;
  if (exec.interrupted) return { kind: 'stopped', text: '⏹ stopped here' };
  if (exec.error) {
    const msg = truncate(`${exec.error.type}: ${exec.error.message}`, 72);
    return exec.error.handled
      ? { kind: 'handled', text: `⚠ handled ${msg}` }
      : { kind: 'error', text: `⚠ ${msg}` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// DOM construction

type Attrs = Record<string, string | number | undefined>;
function s<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  cls?: string,
  text?: string,
): SVGElementTagNameMap[K] {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  if (cls) el.setAttribute('class', cls);
  if (text !== undefined) el.textContent = text;
  return el;
}
/** Multi-line text under a box: one tspan per line, rewritten only when the text changes. */
const lastLines = new WeakMap<Element, string>();
const setLines = (el: Element, text: string, max: number): void => {
  if (lastLines.get(el) === text) return;
  lastLines.set(el, text);
  const lines = wrapText(text, max);
  if (lines.length <= 1) {
    el.textContent = text;
    return;
  }
  el.textContent = '';
  const x = el.getAttribute('x') ?? '0';
  lines.forEach((line, k) => {
    const t = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    t.setAttribute('x', x);
    t.setAttribute('dy', k === 0 ? '0' : '13');
    t.textContent = line;
    el.append(t);
  });
};
const setText = (el: Element, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};
/** Writes an attribute only when it changes. */
const setAttr = (el: Element, k: string, v: string): void => {
  if (el.getAttribute(k) !== v) el.setAttribute(k, v);
};
const toggle = (el: Element, cls: string, on: boolean): void => {
  el.classList.toggle(cls, on);
};

interface AttrRowDom {
  g: SVGGElement;
  flash: SVGRectElement;
  bullet: SVGTextElement;
  text: SVGTextElement;
  name: SVGTSpanElement;
  detail: SVGTSpanElement;
}

export interface NodeHandle {
  id: string;
  node: GNode;
  laid: LaidNode;
  g: SVGGElement;
  /** Elements that carry the state classes (the group, plus an instance's background box). */
  stateEls: Element[];
  badge?: { g: SVGGElement; bg: SVGRectElement; text: SVGTextElement };
  msg?: SVGTextElement;
  /** Characters per line of the message under the box (its width). */
  msgChars?: number;
  rows?: AttrRowDom[];
  /** Call boxes: one group per port, so a port can be re-texted and dimmed per execution. */
  ports?: Map<string, PortDom>;
  /** Instances with a "more methods" list. */
  more?: MoreDom;
  /** Label base for aria-label. */
  label: string;
}
export interface PortDom {
  g: SVGGElement;
  /** In-ports: the const text, or the type line. Out-ports: the type line. */
  top: SVGTextElement;
  /** The gray name line (not for const ports). */
  name?: SVGTextElement;
  isConst: boolean;
  /** Out-ports: the box's bottom edge; the type line sits lower when there is no name line. */
  bottom?: number;
}
export interface MoreDom {
  /** Control and list, in one group so the list follows its control in tab order. */
  wrap: SVGGElement;
  ctl: SVGGElement;
  label: SVGTextElement;
  panel: SVGGElement | null;
  /** The log the open list was built from. */
  panelFor?: EventLog;
  open: boolean;
  n: number;
}
export interface EdgeHandle {
  id: string;
  edge: GEdge;
  g: SVGGElement;
  label: SVGGElement;
  typeEl: SVGTSpanElement;
  nameEl: SVGTSpanElement;
  anchor: LabelAnchor | null;
}
export interface SvgDom {
  svg: SVGSVGElement;
  nodes: Map<string, NodeHandle>;
  edges: Map<string, EdgeHandle>;
  /** Layer above everything: the "more methods" controls and their lists. */
  moreLayer: SVGGElement;
  model: GraphModel;
  /** The log of the last `applyState`, for lists built on demand. */
  log?: EventLog;
  /** True when the host handles `onOpenDocs`: list entries are then buttons. */
  docs: boolean;
}

function nodeLabel(n: GNode, ctors: Set<string>): string {
  switch (n.kind) {
    case 'call':
      if (ctors.has(n.id)) return `constructor ${n.name}`;
      return n.parent ? `method ${n.name}` : `function ${n.name}`;
    case 'instance':
      return `object ${instanceTitle(n)}`;
    case 'expr':
      return `expression ${n.text}`;
    case 'store':
      return `store ${n.text}`;
    case 'source':
      return `value ${n.label}`;
  }
}

function buildCall(
  doc: Document,
  n: Extract<GNode, { kind: 'call' }>,
  ln: LaidNode,
  g: SVGGElement,
): Map<string, PortDom> {
  const ports = new Map<string, PortDom>();
  g.append(s(doc, 'rect', { x: ln.x, y: ln.y, width: ln.w, height: ln.h, rx: 9 }, 'md-box'));
  const top = n.inPorts.length ? M.portLabelH : M.emptyPortH;
  g.append(s(doc, 'text', { x: ln.x + ln.w / 2, y: ln.y + top + 16 }, 'md-name', n.name));
  for (const p of n.inPorts) {
    const lp = ln.ports[p.id];
    if (!lp) continue;
    const pg = s(doc, 'g', { 'data-port': p.id }, 'md-port-g');
    if (p.constText !== undefined) {
      const t = s(doc, 'text', { x: lp.x, y: ln.y + 18 }, 'md-ptype', p.constText);
      pg.append(t);
      ports.set(p.id, { g: pg, top: t, isConst: true });
    } else {
      pg.append(s(doc, 'circle', { cx: lp.x, cy: lp.y, r: 3 }, 'md-port'));
      const t = s(doc, 'text', { x: lp.x, y: ln.y + 13 }, 'md-ptype', p.typeLabel);
      const nm = s(doc, 'text', { x: lp.x, y: ln.y + 25 }, 'md-pname', p.param);
      pg.append(t, nm);
      ports.set(p.id, { g: pg, top: t, name: nm, isConst: false });
    }
    g.append(pg);
  }
  for (const p of n.outPorts) {
    const lp = ln.ports[p.id];
    if (!lp) continue;
    const pg = s(doc, 'g', { 'data-port': p.id }, 'md-port-g');
    pg.append(s(doc, 'circle', { cx: lp.x, cy: lp.y, r: 3 }, 'md-port'));
    const bottom = ln.y + ln.h;
    // both lines exist so a port can gain or lose its name; the type line sits above the name line
    const t = s(
      doc,
      'text',
      { x: lp.x, y: bottom - (p.nameLabel ? 17 : 11) },
      'md-ptype',
      p.typeLabel,
    );
    const nm = s(doc, 'text', { x: lp.x, y: bottom - 5 }, 'md-pname', p.nameLabel ?? '');
    pg.append(t, nm);
    g.append(pg);
    ports.set(p.id, { g: pg, top: t, name: nm, isConst: false, bottom });
  }
  return ports;
}

/** `uid` makes the arrow marker id unique per diagram (several can share a page). */
export function buildSvg(
  doc: Document,
  model: GraphModel,
  laid: Laid,
  uid = '0',
  opts: { docs?: boolean } = {},
): SvgDom {
  const ARROW_ID = `md-arrow-${uid}`;
  const svg = s(
    doc,
    'svg',
    {
      width: Math.ceil(laid.width),
      height: Math.ceil(laid.height),
      viewBox: `0 0 ${Math.ceil(laid.width)} ${Math.ceil(laid.height)}`,
      role: 'group',
      'aria-label': 'Diagram of the program',
    },
    'md-diagram',
  );
  const defs = s(doc, 'defs');
  const marker = s(doc, 'marker', {
    id: ARROW_ID,
    viewBox: '0 0 10 10',
    refX: 9,
    refY: 5,
    markerWidth: 8,
    markerHeight: 8,
    orient: 'auto',
    markerUnits: 'userSpaceOnUse',
  });
  marker.append(s(doc, 'path', { d: 'M0 1L10 5L0 9z' }, 'md-arrow'));
  defs.append(marker);
  svg.append(defs);

  const bgLayer = s(doc, 'g', {}, 'md-layer-bg');
  const edgeLayer = s(doc, 'g', {}, 'md-layer-edges');
  const nodeLayer = s(doc, 'g', {}, 'md-layer-nodes');
  const labelLayer = s(doc, 'g', {}, 'md-layer-labels');
  const moreLayer = s(doc, 'g', {}, 'md-layer-more');
  svg.append(bgLayer, edgeLayer, nodeLayer, labelLayer, moreLayer);
  const ctors = modelIndex(model).ctors;

  const nodes = new Map<string, NodeHandle>();
  const edges = new Map<string, EdgeHandle>();
  const sorted = [...model.nodes].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

  for (const n of sorted) {
    const ln = laid.nodes[n.id];
    if (!ln) continue;
    const g = s(
      doc,
      'g',
      { 'data-node': n.id, 'data-kind': n.kind },
      `md-node md-${n.kind} md-hidden`,
    );
    const label = nodeLabel(n, ctors);
    if (n.kind !== 'source') {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
    }
    g.setAttribute('aria-label', label);
    const h: NodeHandle = { id: n.id, node: n, laid: ln, g, stateEls: [g], label };

    switch (n.kind) {
      case 'call':
        h.ports = buildCall(doc, n, ln, g);
        if (ctors.has(n.id)) g.classList.add('md-ctor');
        break;
      case 'instance': {
        const bg = s(
          doc,
          'rect',
          { x: ln.x, y: ln.y, width: ln.w, height: ln.h, rx: 10, 'data-node': n.id },
          'md-inst-box md-hidden',
        );
        bgLayer.append(bg);
        h.stateEls.push(bg);
        g.append(
          s(
            doc,
            'rect',
            { x: ln.x + 6, y: ln.y + 4, width: ln.w - 12, height: 22, rx: 11 },
            'md-pill',
          ),
          s(
            doc,
            'text',
            { x: ln.x + ln.w / 2, y: ln.y + 19, 'text-anchor': 'middle' },
            'md-pill-text',
            instanceTitle(n),
          ),
        );
        const cap = Math.round((ln.attrsH ?? 0) / M.instRowH);
        h.rows = [];
        for (let k = 0; k < cap; k++) {
          const ry = ln.y + (ln.headerH ?? M.instHeaderH) + k * M.instRowH;
          const rg = s(doc, 'g', {}, 'md-attr md-hidden');
          const flash = s(
            doc,
            'rect',
            { x: ln.x + 3, y: ry, width: ln.w - 6, height: M.instRowH, rx: 4 },
            'md-flash-bg',
          );
          const bullet = s(doc, 'text', { x: ln.x + 4, y: ry + 13 }, 'md-bullet', '●');
          bullet.classList.add('md-hidden');
          const text = s(doc, 'text', { x: ln.x + M.instPad, y: ry + 13 });
          const name = s(doc, 'tspan', {}, 'md-aname');
          const detail = s(doc, 'tspan', { dx: 6 }, 'md-atype');
          text.append(name, detail);
          rg.append(flash, bullet, text);
          g.append(rg);
          h.rows.push({ g: rg, flash, bullet, text, name, detail });
        }
        if (ln.moreN) h.more = buildMore(doc, n, ln, moreLayer);
        break;
      }
      case 'expr':
        g.append(
          s(doc, 'rect', { x: ln.x, y: ln.y, width: ln.w, height: ln.h }, 'md-hit'),
          s(doc, 'text', { x: ln.x + ln.w / 2, y: ln.y + ln.h / 2 + 4 }, 'md-expr-text', n.text),
        );
        break;
      case 'store':
        g.append(
          s(doc, 'rect', { x: ln.x, y: ln.y, width: ln.w, height: ln.h, rx: 6 }, 'md-box'),
          s(doc, 'text', { x: ln.x + ln.w / 2, y: ln.y + ln.h / 2 + 4 }, 'md-store-text', n.text),
        );
        break;
      case 'source':
        g.append(
          s(doc, 'rect', { x: ln.x, y: ln.y, width: ln.w, height: ln.h }, 'md-hit'),
          s(doc, 'text', { x: ln.x + ln.w / 2, y: ln.y + ln.h / 2 + 4 }, 'md-source-text', n.label),
        );
        break;
    }

    // ×n badge above the top-right corner (merged boxes only)
    if (n.kind === 'call' || n.kind === 'expr' || n.kind === 'store') {
      const bg = s(
        doc,
        'rect',
        { x: ln.x + ln.w - 30, y: ln.y - 19, width: 30, height: 16, rx: 8 },
        'md-badge-bg',
      );
      const text = s(doc, 'text', { x: ln.x + ln.w - 15, y: ln.y - 7 }, 'md-badge-text');
      const bg0 = s(doc, 'g', {}, 'md-badge md-hidden');
      bg0.append(bg, text);
      g.append(bg0);
      h.badge = { g: bg0, bg, text };
    }
    if (n.kind !== 'source') {
      const msg = s(
        doc,
        'text',
        { x: ln.x + ln.w / 2, y: ln.y + ln.h + 15 },
        'md-msg md-halo md-hidden',
      );
      g.append(msg);
      h.msg = msg;
      h.msgChars = Math.max(24, Math.floor(ln.w / 6.5));
    }
    g.append(
      s(
        doc,
        'rect',
        { x: ln.x - 3, y: ln.y - 3, width: ln.w + 6, height: ln.h + 6, rx: 11 },
        'md-focus-ring',
      ),
    );
    nodeLayer.append(g);
    nodes.set(n.id, h);
  }

  for (const e of model.edges) {
    const pts = laid.edges[e.id]?.points;
    if (!pts || pts.length < 2) continue;
    const d = roundedPath(pts);
    const g = s(doc, 'g', { 'data-edge': e.id }, 'md-edge md-hidden');
    g.append(
      s(
        doc,
        'path',
        { d, 'marker-end': `url(#${ARROW_ID})` },
        e.dashed ? 'md-wire md-dashed' : 'md-wire',
      ),
      s(doc, 'path', { d }, 'md-wire-hit'),
    );
    edgeLayer.append(g);

    const lr = laid.labels?.[e.id];
    const anchor: LabelAnchor | null = lr
      ? { x: lr.x + 3, y: lr.y + 13, anchor: 'start' }
      : labelAnchor(pts);
    const label = s(
      doc,
      'g',
      { 'data-edge': e.id, tabindex: 0, role: 'button' },
      'md-edge-label md-hidden',
    );
    const text = s(
      doc,
      'text',
      anchor ? { x: anchor.x, y: anchor.y, 'text-anchor': anchor.anchor } : {},
      'md-halo',
    );
    const typeEl = s(doc, 'tspan', {}, 'md-wtype');
    const nameEl = s(doc, 'tspan', { dx: 4, dy: 3 }, 'md-wname');
    text.append(typeEl, nameEl);
    label.append(text, s(doc, 'rect', { x: 0, y: 0, width: 0, height: 0, rx: 4 }, 'md-focus-ring'));
    if (lr?.leader) {
      const [x1, y1, x2, y2] = lr.leader;
      label.prepend(s(doc, 'line', { x1, y1, x2, y2 }, 'md-leader'));
    }
    labelLayer.append(label);
    edges.set(e.id, { id: e.id, edge: e, g, label, typeEl, nameEl, anchor });
  }
  return { svg, nodes, edges, moreLayer, model, docs: opts.docs === true };
}

// ---------------------------------------------------------------------------------------------
// "More methods": a control row at the bottom of an instance, and a list under the box when open.

const MORE_ROWS = 14; // rows per column of the list
const MORE_ROW_H = 20;
const MORE_DOC_CHARS = 46;

function buildMore(doc: Document, n: InstanceNode, ln: LaidNode, layer: SVGGElement): MoreDom {
  const count = ln.moreN ?? 0;
  const wrap = s(doc, 'g', { 'data-more-for': n.id }, 'md-more md-hidden');
  const y = ln.y + ln.h - M.moreH;
  const ctl = s(
    doc,
    'g',
    {
      'data-more': n.id,
      tabindex: 0,
      role: 'button',
      'aria-expanded': 'false',
      'aria-label': `${instanceTitle(n)}: more methods (${count}), collapsed`,
    },
    'md-more-ctl',
  );
  ctl.append(
    s(
      doc,
      'rect',
      { x: ln.x + 6, y: y - 1, width: ln.w - 12, height: M.moreH - 3, rx: 5 },
      'md-more-bg',
    ),
    s(doc, 'text', { x: ln.x + M.instPad, y: y + 12 }, 'md-more-text', `▸ more methods (${count})`),
    s(
      doc,
      'rect',
      { x: ln.x + 3, y: y - 3, width: ln.w - 6, height: M.moreH, rx: 6 },
      'md-focus-ring',
    ),
  );
  const label = ctl.querySelector('.md-more-text') as SVGTextElement;
  wrap.append(ctl);
  layer.append(wrap);
  return { wrap, ctl, label, panel: null, open: false, n: count };
}

function buildMorePanel(dom: SvgDom, h: NodeHandle): SVGGElement | null {
  const inst = h.node;
  if (inst.kind !== 'instance' || !h.more) return null;
  const doc = h.g.ownerDocument;
  const list = dom.log ? hiddenMethods(dom.model, dom.log, inst) : [];
  const ln = h.laid;
  const cols = Math.max(1, Math.ceil(list.length / MORE_ROWS));
  const per = Math.min(MORE_ROWS, Math.max(list.length, 1));
  const nameW = Math.max(6, ...list.map((m) => m.name.length)) * 7.5 + 14;
  const colW = Math.ceil(nameW + MORE_DOC_CHARS * 6.2 + 12);
  const w = cols * colW + 12;
  const panel = s(
    doc,
    'g',
    { role: 'list', 'aria-label': `Other methods of ${inst.className}` },
    'md-more-panel',
  );
  const x0 = ln.x;
  const y0 = ln.y + ln.h + 4;
  panel.append(
    s(
      doc,
      'rect',
      { x: x0, y: y0, width: w, height: per * MORE_ROW_H + 12, rx: 8 },
      'md-more-panel-bg',
    ),
  );
  list.forEach((m, k) => {
    const col = Math.floor(k / MORE_ROWS);
    const row = k % MORE_ROWS;
    const x = x0 + 6 + col * colW;
    const y = y0 + 6 + row * MORE_ROW_H;
    const target = methodDocTarget(dom.model, inst, m.name);
    const attrs: Attrs = {
      'data-doc-name': target.name,
      'data-doc-method': m.name,
      'data-doc-node': inst.id,
      role: dom.docs ? 'button' : 'listitem',
      'aria-label': m.doc ? `${m.name}: ${m.doc}` : m.name,
    };
    if (target.module !== null) attrs['data-doc-module'] = target.module;
    if (dom.docs) attrs.tabindex = 0;
    const it = s(doc, 'g', attrs, dom.docs ? 'md-more-item md-more-doc' : 'md-more-item');
    const doctext =
      m.doc.length > MORE_DOC_CHARS ? `${m.doc.slice(0, MORE_DOC_CHARS - 1)}…` : m.doc;
    const title = s(doc, 'title');
    title.textContent = m.doc ? `${m.name}: ${m.doc}` : m.name;
    it.append(
      title,
      s(doc, 'rect', { x, y, width: colW - 6, height: MORE_ROW_H, rx: 4 }, 'md-more-hit'),
      s(doc, 'text', { x: x + 6, y: y + 14 }, 'md-more-name', m.name),
      s(doc, 'text', { x: x + nameW, y: y + 14 }, 'md-more-doc-text', doctext),
      s(
        doc,
        'rect',
        { x: x - 1, y: y - 1, width: colW - 4, height: MORE_ROW_H + 2, rx: 5 },
        'md-focus-ring',
      ),
    );
    panel.append(it);
  });
  return panel;
}

/** Opens or closes the list of an instance's "more methods". Returns whether it changed. */
export function setMoreOpen(dom: SvgDom, id: string, open: boolean): boolean {
  const h = dom.nodes.get(id);
  const m = h?.more;
  if (!h || !m || m.open === open) return false;
  m.open = open;
  m.ctl.setAttribute('aria-expanded', String(open));
  const title = h.node.kind === 'instance' ? instanceTitle(h.node) : id;
  m.ctl.setAttribute(
    'aria-label',
    `${title}: more methods (${m.n}), ${open ? 'expanded' : 'collapsed'}`,
  );
  m.label.textContent = `${open ? '▾' : '▸'} more methods (${m.n})`;
  if (open) {
    // rebuilt each time so it reflects the latest log; brought to the front of the layer
    m.panel?.remove();
    m.panel = buildMorePanel(dom, h);
    m.panelFor = dom.log;
    if (m.panel) m.wrap.append(m.panel);
    dom.moreLayer.append(m.wrap);
  } else {
    m.panel?.remove();
    m.panel = null;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// State

export interface ApplyContext {
  model: GraphModel;
  /** Event i of the last drawn step; the badge shows "×n" there. */
  lastStep: number | null;
  /** Previously applied `state.current`, to flash changed attributes only when stepping onto an event. */
  prevCurrent: number | null | undefined;
  reducedMotion: boolean;
  schedule: (fn: () => void) => void;
}

/** Position the focus ring of a wire label around its text once it is visible. */
function fitLabelRing(h: EdgeHandle): void {
  const ring = h.label.querySelector('.md-focus-ring');
  const text = h.label.querySelector('text');
  if (!ring || !text || !h.anchor) return;
  const w = Math.max(
    20,
    (h.typeEl.textContent?.length ?? 0) * 6.6 + (h.nameEl.textContent?.length ?? 0) * 6 + 8,
  );
  const x = h.anchor.anchor === 'start' ? h.anchor.x - 3 : h.anchor.x - w / 2;
  setAttr(ring, 'x', String(x));
  setAttr(ring, 'y', String(h.anchor.y - 12));
  setAttr(ring, 'width', String(w));
  setAttr(ring, 'height', '18');
}

/**
 * The version of an instance to draw. At the step of its constructor the box shows the object that call
 * returned: a constructor in a loop gives one box for many objects, and the latest version would still be
 * the previous pass's fitted one.
 */
function displayVersion(inst: InstanceNode, state: StepState, ix: ModelIndex): Token | undefined {
  const active = state.activeVersion.get(inst.id);
  if (
    inst.createdBy === null ||
    state.currentNode !== inst.createdBy ||
    !ix.ctors.has(inst.createdBy)
  )
    return active;
  const exec = state.activeExecution.get(inst.createdBy);
  const out = exec?.outputs['out:0'];
  if (!exec || out === undefined) return active;
  let pick: Token | undefined;
  for (const v of inst.versions)
    if (objKey(v.token) === objKey(out) && v.i <= exec.ret) pick = v.token;
  return pick ?? active;
}

export function applyState(
  dom: SvgDom,
  state: StepState,
  log: EventLog | undefined,
  ctx: ApplyContext,
): void {
  dom.log = log;
  const stepping = state.current !== ctx.prevCurrent;
  const mi = modelIndex(ctx.model);
  const atEnd = ctx.lastStep === null || (state.current !== null && state.current >= ctx.lastStep);
  const changed =
    state.currentNode !== null
      ? changedAttrs(state.attrsBefore, state.attrsAfter, log?.values)
      : new Set<string>();

  for (const h of dom.nodes.values()) {
    const visible = state.visibleNodes.has(h.id);
    const exec = state.activeExecution.get(h.id);
    const status = statusOf(exec);
    const isCurrent = visible && state.currentNode === h.id;
    // the instance whose method is the current event: only its attributes can be marked as changed
    const ownsCurrent =
      visible &&
      state.currentNode !== null &&
      dom.nodes.get(state.currentNode)?.node.parent === h.id;
    const uncalled = visible && state.uncalled.has(h.id);
    toggle(h.g, 'md-uncalled', uncalled);
    for (const el of h.stateEls) {
      toggle(el, 'md-hidden', !visible);
      toggle(el, 'md-current', isCurrent);
      toggle(el, 'md-error', status?.kind === 'error');
      toggle(el, 'md-handled', status?.kind === 'handled');
      toggle(el, 'md-stopped', status?.kind === 'stopped');
    }
    if (isCurrent) setAttr(h.g, 'aria-current', 'step');
    else if (h.g.hasAttribute('aria-current')) h.g.removeAttribute('aria-current');
    if (h.msg) {
      setLines(h.msg, status?.text ?? '', h.msgChars ?? 40);
      toggle(h.msg, 'md-hidden', !status);
      // the stopped marker is neutral (no red/amber): style by the group class only
    }
    const b = state.badge.get(h.id);
    if (h.badge) {
      toggle(h.badge.g, 'md-hidden', !visible || !b);
      if (b) {
        const t = badgeText(b.k, b.n, atEnd);
        setText(h.badge.text, t);
        const w = Math.max(30, t.length * 6.8 + 12);
        setAttr(h.badge.bg, 'width', String(w));
        setAttr(h.badge.bg, 'x', String(h.laid.x + h.laid.w - w));
        setAttr(h.badge.text, 'x', String(h.laid.x + h.laid.w - w / 2));
      }
    }
    if (h.ports && h.node.kind === 'call') {
      const pv = portViews(ctx.model, h.node, exec, log);
      for (const [pid, pd] of h.ports) {
        const v = pv.in[pid] ?? pv.out[pid];
        if (!v) continue;
        toggle(pd.g, 'md-port-unused', !v.used);
        setText(pd.top, pd.isConst ? (v.constText ?? '') : v.typeLabel);
        if (pd.name) setText(pd.name, v.name);
        if (pd.bottom !== undefined) setAttr(pd.top, 'y', String(pd.bottom - (v.name ? 17 : 11)));
      }
    }
    if (h.more) {
      toggle(h.more.wrap, 'md-hidden', !visible);
      if (h.more.open && h.more.panelFor !== log) {
        h.more.panel?.remove();
        h.more.panelFor = log;
        h.more.panel = buildMorePanel(dom, h);
        if (h.more.panel) h.more.wrap.append(h.more.panel);
      }
    }
    let aria =
      h.label +
      (uncalled ? ', not called yet' : '') +
      (b ? `, run ${b.k} of ${b.n}` : '') +
      (status ? `, ${status.text.replace(/^(⚠|⏹) /, '')}` : '') +
      (isCurrent ? ', current step' : '');

    if (h.rows && h.node.kind === 'instance') {
      const token = displayVersion(h.node, state, mi);
      const rows = instanceRowModels(h.node, token, log?.values);
      const cap = h.rows.length;
      const overflow = rows.length > cap;
      const shown = overflow ? rows.slice(0, Math.max(cap - 1, 0)) : rows;
      const flashing = ownsCurrent && stepping && !ctx.reducedMotion;
      h.rows.forEach((r, k) => {
        const row = shown[k];
        const more = overflow && k === cap - 1;
        toggle(r.g, 'md-hidden', !visible || (!row && !more));
        if (more) {
          setText(r.name, `… ${rows.length - shown.length} more`);
          setText(r.detail, '');
          toggle(r.g, 'md-changed', false);
          toggle(r.bullet, 'md-hidden', true);
          return;
        }
        if (!row) {
          toggle(r.g, 'md-changed', false);
          toggle(r.bullet, 'md-hidden', true);
          return;
        }
        setText(r.name, row.name);
        setText(r.detail, row.detail);
        toggle(r.g, 'md-data', row.data === true);
        const isChanged = ownsCurrent && !row.param && changed.has(row.name);
        toggle(r.g, 'md-changed', isChanged);
        toggle(r.bullet, 'md-hidden', !isChanged);
        if (isChanged && flashing) {
          r.g.classList.add('md-flash');
          ctx.schedule(() => r.g.classList.remove('md-flash'));
        } else if (!isChanged) r.g.classList.remove('md-flash');
      });
      const attrLine = rows
        .filter((r) => ownsCurrent && !r.param && changed.has(r.name))
        .map((r) => r.name);
      if (attrLine.length > 0) {
        aria = `${aria}, changed: ${attrLine.join(', ')}`;
      }
    }
    setAttr(h.g, 'aria-label', aria);
  }

  for (const h of dom.edges.values()) {
    const visible = state.visibleEdges.has(h.id);
    // a shared method box switches wires per execution: wires of other executions stay as faint history
    const active = state.activeEdges.has(h.id);
    toggle(h.g, 'md-hidden', !visible);
    toggle(h.g, 'md-inactive', visible && !active);
    const token = state.activeToken.get(h.id);
    const type = visible && active && token !== undefined ? wireTypeLabel(token, log?.values) : '';
    const name = visible && active ? (h.edge.nameLabel ?? '') : '';
    setText(h.typeEl, type);
    setText(h.nameEl, name);
    setAttr(h.nameEl, 'dx', type && name ? '4' : '0');
    const hasText = visible && (type !== '' || name !== '') && h.anchor !== null;
    toggle(h.label, 'md-hidden', !hasText);
    if (hasText) {
      const desc = [type, name && `named ${name}`].filter(Boolean).join(', ');
      setAttr(h.label, 'aria-label', `wire: ${desc}`);
      fitLabelRing(h);
    }
  }
  ctx.prevCurrent = state.current;
}
