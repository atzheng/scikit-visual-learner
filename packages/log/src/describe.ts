// Plain-English summary of one step (svl-dnj, CONTRACTS.md section 8 "Step summary"). Pure and deterministic:
// templates over the event, the graph model and `stateAt`, no wall-clock time, no network, no model.
//
// The rule is the same as no false wires: say only what the log supports, and when unsure say less. So a
// name is given only when a binding of that very object follows the event (never a guess from the box),
// "created" only for the event that first made the object, and a changed attribute only by the inspect
// panel's own rule (attrs.ts).
import { attrRows, reprTruncated } from './attrs';
import { keyOf } from './graph';
import type { CallNode, GraphModel, InstanceNode } from './graph';
import { findEvent, stateAt } from './timeline';
import type { Event, EventLog, ImportBinding, Site, Token, ValueSummary } from './types';

/** A run of text, or a name / piece of source code the UI shows as code. */
export type SummaryPart = { kind: 'text'; text: string } | { kind: 'code'; text: string };

const t = (text: string): SummaryPart => ({ kind: 'text', text });
const c = (text: string): SummaryPart => ({ kind: 'code', text });

/** The summary as plain text (for tests, `aria-label`s and tooltips). */
export function summaryText(parts: readonly SummaryPart[]): string {
  return parts.map((p) => p.text).join('');
}

const MAX_CODE = 60;
const MAX_LIST = 4;
const MAX_MESSAGE = 80;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
function clip(s: string, n: number): string {
  const points = Array.from(s);
  return points.length > n ? points.slice(0, n - 1).join('') + '…' : s;
}
const article = (word: string): string => (/^[aeiouAEIO]/.test(word) ? 'an' : 'a');

// ---- values

const COLLECTION = /^(list|dict|tuple|set)\[(\d+)\]$/;

/** The class as a student would say it, without the shape: DF is a DataFrame. */
function baseType(v: ValueSummary): string {
  if (v.type === 'DF') return 'DataFrame';
  if (v.type === 'sparse') return 'sparse matrix';
  const m = COLLECTION.exec(v.type);
  if (m) return `${m[1]} of ${m[2]} item${m[2] === '1' ? '' : 's'}`;
  return v.type;
}
/** `Series of bool`, `array of float64`: the type with the dtype when there is one. */
function typeName(v: ValueSummary): string {
  const base = baseType(v);
  return v.dtype && (v.type === 'Series' || v.type === 'array') ? `${base} of ${v.dtype}` : base;
}
const shapeText = (v: ValueSummary): string | null =>
  v.shape && v.shape.length > 0 ? v.shape.join(' × ') : null;

/** What a scalar token reads as, when its text is whole. */
function scalarText(tok: Token, v: ValueSummary): string | null {
  if (!tok.startsWith('s') || v.shape !== undefined || reprTruncated(v.repr)) return null;
  return v.repr ?? null;
}

/** "a Series of bool (95)", "an int (500)", "a value" when the summary is missing. */
function describeValue(tok: Token, log: EventLog): string {
  const v = log.values[tok];
  if (!v) return 'a value';
  const detail = shapeText(v) ?? scalarText(tok, v);
  const name = typeName(v);
  return `${article(name)} ${name}${detail ? ` (${detail})` : ''}`;
}
/** "DataFrame, 376 × 4", for an item in a list. */
function typeAndShape(tok: Token, log: EventLog): string {
  const v = log.values[tok];
  if (!v) return 'value';
  const detail = shapeText(v) ?? scalarText(tok, v);
  return detail ? `${typeName(v)}, ${detail}` : typeName(v);
}

// ---- names

interface Binding {
  at: number;
  name: string;
}
const bindingCache = new WeakMap<EventLog, Map<string, Binding[]>>();

/** Scope-0 bindings by object key; names the recorder cannot follow (volatile bind sites) are left out. */
function bindingsOf(log: EventLog): Map<string, Binding[]> {
  let m = bindingCache.get(log);
  if (m) return m;
  m = new Map();
  const volatile = new Set<string>();
  for (const s of log.sites)
    if (s.kind === 'bind' && s.volatile) for (const n of s.targets ?? []) volatile.add(n);
  const scope0 = log.scopes.find((s) => s.id === 0);
  for (const [at, name, token] of scope0?.bindings ?? []) {
    if (volatile.has(name)) continue;
    const k = keyOf(token);
    const l = m.get(k);
    if (l) l.push({ at, name });
    else m.set(k, [{ at, name }]);
  }
  bindingCache.set(log, m);
  return m;
}

/**
 * The name the statement bound this output to: a binding of the same object made right after the event
 * returned (no other event started in between). Null when there is none: a nameless value stays nameless.
 */
function outputName(log: EventLog, ev: Event, tok: Token): string | null {
  const l = bindingsOf(log).get(keyOf(tok));
  const hit = l?.find((b) => b.at >= ev.i && b.at <= ev.ret);
  return hit?.name ?? null;
}

/** `model` of `model.fit`: the name the call was written on, only when it is a plain (dotted) name. */
function ownerText(site: Site | undefined): string | null {
  const f = site?.func_text;
  if (f === undefined) return null;
  const dot = f.lastIndexOf('.');
  if (dot <= 0) return null;
  const head = f.slice(0, dot);
  return /^[A-Za-z_][\w.]*$/.test(head) ? head : null;
}

// ---- source text

/** The call as written, or `callee(...)` when it is long: never more than MAX_CODE characters of code. */
function callText(site: Site | undefined, ev: Event): string {
  if (!site) return `${ev.name}(...)`;
  const full = oneLine(site.text);
  if (Array.from(full).length <= MAX_CODE) return full;
  if (site.func_text !== undefined) return clip(`${oneLine(site.func_text)}(...)`, MAX_CODE);
  return clip(full, MAX_CODE);
}

// ---- the sentences

interface Ctx {
  model: GraphModel;
  log: EventLog;
  ev: Event;
  site: Site | undefined;
  state: ReturnType<typeof stateAt>;
  instances: Map<string, InstanceNode>;
}

type Sentence = SummaryPart[];

function importSentence(site: Site | undefined): Sentence | null {
  const imports: ImportBinding[] | undefined = site?.imports;
  if (!imports || imports.length === 0) return null;
  const shown = imports.slice(0, 6);
  const rest = imports.length - shown.length;
  const fromOne =
    imports.every((b) => b.attr !== null) && new Set(imports.map((b) => b.module)).size === 1;
  const item = (b: ImportBinding): SummaryPart[] => {
    if (b.dotted !== undefined) return [c(b.dotted)];
    if (b.attr !== null) return b.attr === b.name ? [c(b.name)] : [c(b.attr), t(' as '), c(b.name)];
    return b.module === b.name ? [c(b.name)] : [c(b.module), t(' as '), c(b.name)];
  };
  const parts: SummaryPart[] = [t('Imported ')];
  shown.forEach((b, k) => {
    if (k > 0) parts.push(t(k === shown.length - 1 && rest === 0 ? ' and ' : ', '));
    parts.push(...item(b));
    if (!fromOne && b.attr !== null) parts.push(t(' from '), c(b.module));
  });
  if (rest > 0) parts.push(t(`, and ${rest} more`));
  if (fromOne) parts.push(t(' from '), c(imports[0]!.module));
  parts.push(t('.'));
  return parts;
}

const firstSeenCache = new WeakMap<EventLog, Map<string, number>>();

/** Per object key, the first event that touched it (as output, input, owner or mutated version), by i. */
function firstSeen(log: EventLog): Map<string, number> {
  let m = firstSeenCache.get(log);
  if (m) return m;
  m = new Map();
  const see = (tok: Token | undefined, i: number): void => {
    if (tok === undefined || !tok.startsWith('v')) return;
    const k = keyOf(tok);
    if (!m!.has(k)) m!.set(k, i);
  };
  for (const e of log.events) {
    for (const x of e.inputs) see(x.value, e.i);
    see(e.owner ?? undefined, e.i);
    for (const [b, a] of e.mutates) {
      see(b, e.i);
      see(a, e.i);
    }
    for (const o of e.outputs) see(o, e.i);
  }
  firstSeenCache.set(log, m);
  return m;
}

/**
 * Whether this event made the object: no earlier event touched it and no name was bound to it before.
 * An object that was already there (a method returning its own input, a value bound earlier) is not "new".
 */
function createdHere(ctx: Ctx, tok: Token): boolean {
  if (!tok.startsWith('v')) return false;
  const k = keyOf(tok);
  if (firstSeen(ctx.log).get(k) !== ctx.ev.i) return false;
  return !(bindingsOf(ctx.log).get(k) ?? []).some((b) => b.at < ctx.ev.i);
}

function nameParts(name: string | null, lead: string): SummaryPart[] {
  return name === null ? [] : [t(lead), c(name)];
}

/**
 * What the call returned (or the expression computed), as the tail of a sentence. `created` is true when
 * the tail starts with its own verb ("created a new ... object"); otherwise it follows "returned".
 */
function outputsTail(ctx: Ctx, call: boolean): { created: boolean; parts: SummaryPart[] } | null {
  const { ev, log } = ctx;
  if (ev.error || ev.returns_self || ev.outputs.length === 0) return null;
  const outs = ev.outputs;
  if (outs.length === 1) {
    const tok = outs[0]!;
    const name = outputName(log, ev, tok);
    const v = log.values[tok];
    const born = call && createdHere(ctx, tok);
    if (born && v) {
      const detail = shapeText(v);
      const what = `created a new ${baseType(v)} object${detail ? ` (${detail})` : ''}`;
      return { created: true, parts: [t(what), ...nameParts(name, ', ')] };
    }
    return { created: false, parts: [t(describeValue(tok, log)), ...nameParts(name, ', named ')] };
  }
  const allObjects = outs.every((o) => o.startsWith('v'));
  const parts: SummaryPart[] = [t(`${outs.length} ${allObjects ? 'objects' : 'values'}: `)];
  outs.slice(0, MAX_LIST).forEach((tok, k) => {
    if (k > 0) parts.push(t(', '));
    const name = outputName(log, ev, tok);
    if (name !== null) parts.push(c(name), t(` (${typeAndShape(tok, log)})`));
    else parts.push(t(describeValue(tok, log)));
  });
  if (outs.length > MAX_LIST) parts.push(t(`, and ${outs.length - MAX_LIST} more`));
  return { created: false, parts };
}

/** The attribute sentence of a method on a machine, by the inspect panel's own changed-attribute rule. */
function attrSentence(ctx: Ctx, owner: string | null): Sentence | null {
  const { ev, log, state } = ctx;
  if (ev.error || state.attrsAfter === undefined) return null;
  // A new object at this step (not a change of an earlier one): its attributes are not a change.
  let node = state.currentNode ? ctx.instances.get(state.currentNode) : undefined;
  if (!node && state.currentNode) {
    const par = ctx.model.nodes.find((n) => n.id === state.currentNode)?.parent;
    node = par ? ctx.instances.get(par) : undefined;
  }
  if (node?.versions.some((v) => v.i === state.current && v.kind === 'new')) return null;
  const changed = attrRows(state.attrsBefore, state.attrsAfter, log.values).filter(
    (r) => r.changed,
  );
  if (changed.length === 0) return null;
  const shown = changed.slice(0, MAX_LIST);
  const parts: SummaryPart[] = [
    t(`It changed ${changed.length} attribute${changed.length === 1 ? '' : 's'} of `),
    owner !== null ? c(owner) : t('the object'),
    t(': '),
  ];
  shown.forEach((r, k) => {
    if (k > 0) parts.push(t(', '));
    parts.push(c(r.name));
  });
  if (changed.length > shown.length) parts.push(t(` (and ${changed.length - shown.length} more)`));
  parts.push(t('.'));
  return parts;
}

function errorSentence(ev: Event): Sentence | null {
  const e = ev.error;
  if (!e) return null;
  const msg = clip(oneLine(e.message), MAX_MESSAGE);
  const what = msg ? `${e.type}: ${msg}` : e.type;
  if (e.propagated)
    return [
      t('The error '),
      c(e.type),
      t(' passed through this call'),
      t(e.handled ? ' (handled).' : '.'),
    ];
  return [t('It raised '), c(what), t(e.handled ? ' (handled).' : '.')];
}

const STORE_KEY = /^\s*([A-Za-z_]\w*)\[\s*(['"])([^'"\\\n]+)\2\s*\]\s*=(?!=)/;
const STORE_ATTR = /^\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=(?!=)/;

function storeSentence(ctx: Ctx): Sentence {
  const { ev, site, log } = ctx;
  const root = site?.root;
  if (root === undefined) return [t('Changed an object in place.')];
  const text = site ? oneLine(site.text) : '';
  const after = ev.outputs[0] ?? ev.mutates[0]?.[1];
  const type = after ? log.values[after]?.type : undefined;
  const key = STORE_KEY.exec(text);
  if (key && key[1] === root) {
    if (type === 'DF') return [t('Set column '), c(key[3]!), t(' of '), c(root), t('.')];
    if (type !== undefined && type.startsWith('dict['))
      return [t('Set key '), c(key[3]!), t(' of '), c(root), t('.')];
  }
  const attr = STORE_ATTR.exec(text);
  if (attr && attr[1] === root && !['loc', 'iloc', 'at', 'iat'].includes(attr[2]!))
    return [t('Set attribute '), c(attr[2]!), t(' of '), c(root), t('.')];
  return [t('Changed '), c(root), t(' in place.')];
}

function callSentences(ctx: Ctx): Sentence[] {
  const { ev, site, model, state } = ctx;
  const out: Sentence[] = [];
  const text = callText(site, ev);
  const node = model.nodes.find(
    (n): n is CallNode => n.kind === 'call' && n.id === state.currentNode,
  );
  const from = node?.importedFrom;
  const owner = ev.kind === 'method' ? ownerText(site) : null;
  const who = ev.kind === 'student_function' ? 'Called your function ' : 'Called ';
  out.push([t(who), c(text), ...(from ? [t(' from '), c(from)] : []), t('.')]);
  const err = errorSentence(ev);
  if (err) {
    out.push(err);
    return out;
  }
  const attrs = attrSentence(ctx, owner);
  if (attrs) out.push(attrs);
  if (ev.returns_self)
    out.push(
      owner ? [t('It returned '), c(owner), t(' itself.')] : [t('It returned the object itself.')],
    );
  const ret = outputsTail(ctx, true);
  if (ret) out.push([t(ret.created ? 'It ' : 'It returned '), ...ret.parts, t('.')]);
  // A call that changed objects in place without returning them: data methods (`df.dropna(inplace=True)`).
  if (ev.mutates.length > 0 && ctx.state.attrsAfter === undefined) {
    const ownerKey = ev.owner ? keyOf(ev.owner) : null;
    const ownerChanged = ownerKey !== null && ev.mutates.some(([b]) => keyOf(b) === ownerKey);
    const others = ev.mutates.filter(([b]) => keyOf(b) !== ownerKey).length;
    if (ownerChanged && owner) out.push([t('It changed '), c(owner), t(' in place.')]);
    else if (ownerChanged) out.push([t('It changed the object in place.')]);
    if (others > 0)
      out.push([
        t(
          `It changed ${others} ${ownerChanged ? 'other ' : ''}object${others === 1 ? '' : 's'} in place.`,
        ),
      ]);
  }
  return out;
}

/** "pass 2 of 3" when the current box is one of several runs of the same site, or holds several objects. */
function passNote(ctx: Ctx): string | null {
  const { state, ev, model, log } = ctx;
  const id = state.currentNode;
  if (id !== null) {
    const b = state.badge.get(id);
    if (b) {
      const node = model.nodes.find((n) => n.id === id);
      const execs = node && 'executions' in node ? node.executions : [];
      const sameSite = execs.every((x) => findEvent(log.events, x.i)?.site === ev.site);
      return `${sameSite ? 'pass' : 'call'} ${b.k} of ${b.n}`;
    }
  }
  for (const n of ctx.instances.values()) {
    const ob = state.objectBadge.get(n.id);
    if (ob && n.createdAt === ev.i) return `pass ${ob.k} of ${ob.n}`;
  }
  return null;
}

/**
 * The plain-English summary of `step` (0 = before the program runs, else 1-based as `stateAt` takes it),
 * as text and code runs. Empty when there is nothing to say (no steps, or a step that is not one).
 * `short` is for a list row that already shows the code: it drops the leading "Called ..." sentence when
 * more follow.
 */
export function describeStep(
  model: GraphModel,
  log: EventLog,
  step: number,
  opts: { short?: boolean } = {},
): SummaryPart[] {
  if (model.steps.length === 0) return [];
  if (step === 0) return [t('Before the program runs.')];
  if (!(step >= 1) || step > model.steps.length || !Number.isInteger(step)) return [];
  const state = stateAt(model, log, step);
  if (state.current === null) return [t('Before the program runs.')];
  const ev = findEvent(log.events, state.current);
  if (!ev) return [];
  const site = log.sites[ev.site];
  const instances = new Map<string, InstanceNode>();
  for (const n of model.nodes) if (n.kind === 'instance') instances.set(n.id, n);
  const ctx: Ctx = { model, log, ev, site, state, instances };

  let sentences: Sentence[];
  switch (ev.kind) {
    case 'import': {
      const s = importSentence(site);
      sentences = s ? [s] : [];
      break;
    }
    case 'store':
      sentences = [storeSentence(ctx)];
      break;
    case 'expr': {
      const text = clip(oneLine(ev.name), MAX_CODE);
      const err = errorSentence(ev);
      const outs = outputsTail(ctx, false);
      sentences = err
        ? [[t('Computed '), c(text), t('.')], err]
        : outs
          ? [[t('Computed '), c(text), t(', '), ...outs.parts, t('.')]]
          : [[t('Computed '), c(text), t('.')]];
      break;
    }
    default:
      sentences = callSentences(ctx);
  }
  if (ev.interrupted) sentences.push([t('The run was stopped during this step.')]);
  const pass = passNote(ctx);
  if (pass && sentences.length > 0) {
    const last = sentences[sentences.length - 1]!;
    const end = last[last.length - 1];
    if (end && end.kind === 'text' && end.text.endsWith('.')) {
      last[last.length - 1] = t(end.text.slice(0, -1));
      last.push(t(` (${pass}).`));
    } else last.push(t(` (${pass}).`));
  }
  if (
    opts.short &&
    sentences.length > 1 &&
    (ev.kind === 'method' ||
      ev.kind === 'function' ||
      ev.kind === 'constructor' ||
      ev.kind === 'student_function')
  )
    sentences = sentences.slice(1);
  const parts: SummaryPart[] = [];
  const push = (p: SummaryPart): void => {
    const last = parts[parts.length - 1];
    if (last && last.kind === 'text' && p.kind === 'text') last.text += p.text;
    else parts.push({ ...p });
  };
  sentences.forEach((s, k) => {
    if (k > 0) push(t(' '));
    s.forEach(push);
  });
  return parts;
}
