// Two-pane renderer (svl-61q.2, CONTRACTS.md section 8 "Two-pane view"): an object SHELF (a grid of cards in
// creation order, no wires) and a STAGE (the current line: its call box, the objects it uses and the wires
// between them). Framework-free. The layout of the stage is a pure function (`planStage`); `mountTwoPane`
// builds the DOM. Each object card is one stable element that moves between its shelf slot and the stage.
import { shelfAt, shelfOrder, stageAt, stateAt } from '@machines/log';
import type {
  EventLog,
  GNode,
  GraphModel,
  ShelfEntry,
  StageModel,
  StageParticipant,
  StepState,
  Token,
} from '@machines/log';
import type { ELK } from 'elkjs/lib/elk-api';
import { layout, typeText } from './layout';
import type { Laid, LaidNode, Measure } from './layout';
import { mount } from './mount';
import type { DiagramController, MountOptions } from './mount';
import { attrRowsFor, SVG_NS, wireTypeLabel, roundedPath } from './svg';
import type { MethodDocTarget } from './svg';

/** Room around a card's box inside its element: the "x3" badge above, a status message below. */
export const CARD_PAD = { l: 6, t: 22, r: 6, b: 30 };
export const STAGE = { margin: 16, colGap: 24, rowGap: 76, sideGap: 72, valuesGap: 24 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  w: number;
  h: number;
}
/** A box's size and where its ports sit (x from the box's left edge). */
export interface BoxSize extends Size {
  ports: Record<string, number>;
}

export interface PlanItem {
  /** Card key: `node`, or `node#object` for one object of a merged loop box, or `chip:<edge>`. */
  key: string;
  participant: StageParticipant;
  /** The box of the card (without the padding around it). */
  rect: Rect;
}
export interface PlanWire {
  /** The graph edge; null for the owner line. */
  edge: string | null;
  from: string;
  to: string;
  points: [number, number][];
  arrow: boolean;
  label: { x: number; y: number; type: string; name: string; anchor: 'start' | 'middle' } | null;
}
export interface StagePlan {
  width: number;
  height: number;
  box: Rect | null;
  items: PlanItem[];
  wires: PlanWire[];
  /** Inline scalars and literals, one text line each, beside the call box. */
  values: { x: number; y: number; w: number; lines: string[] } | null;
}

/** The key of a participant's card. */
export function cardKey(p: StageParticipant, merged: boolean): string {
  if (p.kind === 'chip') return `chip:${p.edge ?? p.node}`;
  return merged && p.object !== null ? `${p.node}#${p.object}` : p.node;
}

const rowWidth = (sizes: Size[]): number =>
  sizes.reduce((a, s) => a + s.w, 0) + Math.max(0, sizes.length - 1) * STAGE.colGap;

/** `in  test_size = 0.2`, `out score = 0.93 : float`: the word, not a colour, says which way it goes. */
export function valueLine(v: StageModel['values'][number]): string {
  const text = v.text ?? '?';
  return `${v.role === 'input' ? 'in ' : 'out'}  ${v.param} = ${text}${v.type ? ` : ${v.type}` : ''}`;
}

/**
 * The stage layout, in px, top to bottom: the objects the line uses (inputs) in a row, the call box below
 * them with the owner to its left and the inline values to its right, the objects it makes (outputs) in a
 * row under it. Wires run from each input down to its port on the box and from each output port down to its
 * object; the owner has a plain line to the box (no port, no arrow). Without a box (an import, an instance
 * made by an expression) the objects stand in one row and there are no wires. Deterministic.
 */
export function planStage(
  stage: StageModel,
  size: (p: StageParticipant) => Size,
  box: BoxSize | null,
  mergedOf: (p: StageParticipant) => boolean,
  log?: EventLog,
): StagePlan {
  const items: PlanItem[] = [];
  const wires: PlanWire[] = [];
  const sz = new Map<StageParticipant, Size>();
  for (const p of stage.participants) sz.set(p, size(p));
  const S = (ps: StageParticipant[]): Size[] => ps.map((p) => sz.get(p)!);
  const place = (p: StageParticipant, x: number, y: number): PlanItem => {
    const s = sz.get(p)!;
    const it = { key: cardKey(p, mergedOf(p)), participant: p, rect: { x, y, w: s.w, h: s.h } };
    items.push(it);
    return it;
  };

  if (!box) {
    const row = stage.participants;
    const rh = Math.max(0, ...S(row).map((s) => s.h));
    let x = STAGE.margin;
    for (const p of row) {
      place(p, x, STAGE.margin + (rh - sz.get(p)!.h) / 2);
      x += sz.get(p)!.w + STAGE.colGap;
    }
    return {
      width: STAGE.margin * 2 + rowWidth(S(row)),
      height: STAGE.margin * 2 + rh,
      box: null,
      items,
      wires,
      values: null,
    };
  }

  const owner = stage.participants.find((p) => p.role === 'owner');
  const ins = stage.participants.filter((p) => p.role === 'input');
  const outs = stage.participants.filter((p) => p.role === 'output' || p.role === 'created');
  const inH = Math.max(0, ...S(ins).map((s) => s.h));
  const outH = Math.max(0, ...S(outs).map((s) => s.h));
  const ownerSpace = owner ? sz.get(owner)!.w + STAGE.sideGap : 0;
  const boxX = ownerSpace;
  const cx = boxX + box.w / 2;
  const boxY = ins.length ? inH + STAGE.rowGap : 0;
  const boxRect: Rect = { x: boxX, y: boxY, w: box.w, h: box.h };

  // vertical gaps: the wires' horizontal runs sit in the gap, one level per wire
  const level = (k: number, n: number, y0: number, y1: number): number =>
    y0 + ((y1 - y0) * (k + 1)) / (n + 1);
  const portX = (p: StageParticipant, k: number, n: number): number =>
    boxX + (p.port !== null && box.ports[p.port] !== undefined ? box.ports[p.port]! : (box.w * (k + 1)) / (n + 1));
  const typeOf = (p: StageParticipant): string => {
    // an object is a card that shows its own type; only scalars get a type on the wire
    return p.kind !== 'chip' && p.token ? wireTypeLabel(p.token, log?.values) : '';
  };

  // a tall owner beside the box reaches into the rows above and below: those rows start to its right
  const ownerS = owner ? sz.get(owner)! : null;
  const ownerTop = ownerS ? boxY + box.h / 2 - ownerS.h / 2 : 0;
  const ownerBottom = ownerS ? ownerTop + ownerS.h : 0;
  const clearOwner = (x0: number, rowBottom: number, rowTop: number): number =>
    ownerS && ownerTop < rowBottom && ownerBottom > rowTop ? Math.max(x0, ownerS.w + STAGE.colGap) : x0;
  let x = clearOwner(cx - rowWidth(S(ins)) / 2, inH + 0, 0);
  ins.forEach((p, k) => {
    const s = sz.get(p)!;
    const it = place(p, x, inH - s.h);
    x += s.w + STAGE.colGap;
    const sx = it.rect.x + s.w / 2;
    const sy = it.rect.y + s.h;
    const px = portX(p, k, ins.length);
    const my = level(k, ins.length, inH, boxY);
    wires.push({
      edge: p.edge,
      from: it.key,
      to: 'box',
      points: sx === px ? [[sx, sy], [px, boxY]] : [[sx, sy], [sx, my], [px, my], [px, boxY]],
      arrow: true,
      label: { x: sx + 5, y: sy + 14, type: typeText(typeOf(p)), name: p.kind === 'chip' ? '' : (p.param ?? ''), anchor: 'start' },
    });
  });
  const outTop = boxY + box.h + STAGE.rowGap;
  x = clearOwner(cx - rowWidth(S(outs)) / 2, outTop + outH, outTop);
  outs.forEach((p, k) => {
    const it = place(p, x, outTop);
    x += it.rect.w + STAGE.colGap;
    const ex = it.rect.x + it.rect.w / 2;
    const px = portX(p, k, outs.length);
    const my = level(k, outs.length, boxY + box.h, outTop);
    wires.push({
      edge: p.edge,
      from: 'box',
      to: it.key,
      points:
        ex === px
          ? [[px, boxY + box.h], [ex, outTop]]
          : [[px, boxY + box.h], [px, my], [ex, my], [ex, outTop]],
      arrow: true,
      label: { x: ex + 5, y: outTop - 8, type: typeText(typeOf(p)), name: p.kind === 'chip' ? '' : (p.param ?? ''), anchor: 'start' },
    });
  });
  if (owner) {
    const s = sz.get(owner)!;
    const it = place(owner, 0, boxY + box.h / 2 - s.h / 2);
    const cy = boxY + box.h / 2;
    wires.push({
      edge: null,
      from: it.key,
      to: 'box',
      points: [[s.w, cy], [boxX, cy]],
      arrow: false,
      label: { x: s.w + STAGE.sideGap / 2, y: cy - 6, type: '', name: 'owner', anchor: 'middle' },
    });
  }

  let vals: StagePlan['values'] = null;
  if (stage.values.length) {
    const lines = stage.values.map(valueLine);
    vals = {
      x: boxX + box.w + STAGE.valuesGap,
      y: boxY,
      w: Math.ceil(Math.max(...lines.map((l) => l.length)) * 7.2) + 16,
      lines,
    };
  }

  // shift everything so nothing is left of the margin, then size the canvas
  let maxX = boxRect.x + boxRect.w;
  let maxY = outs.length ? outTop + outH : boxY + box.h;
  for (const it of items) {
    maxX = Math.max(maxX, it.rect.x + it.rect.w);
    maxY = Math.max(maxY, it.rect.y + it.rect.h);
  }
  const minX = Math.min(0, ...items.map((it) => it.rect.x));
  if (vals) {
    maxX = Math.max(maxX, vals.x + vals.w);
    maxY = Math.max(maxY, vals.y + vals.lines.length * 18);
  }
  const dx = STAGE.margin - minX;
  const dy = STAGE.margin;
  for (const it of items) {
    it.rect.x += dx;
    it.rect.y += dy;
  }
  boxRect.x += dx;
  boxRect.y += dy;
  for (const w of wires) {
    w.points = w.points.map(([a, b]) => [a + dx, b + dy] as [number, number]);
    if (w.label) {
      w.label.x += dx;
      w.label.y += dy;
    }
  }
  if (vals) {
    vals.x += dx;
    vals.y += dy;
  }
  return {
    width: Math.ceil(maxX + dx + STAGE.margin),
    height: Math.ceil(maxY + dy + STAGE.margin),
    box: boxRect,
    items,
    wires,
    values: vals,
  };
}

// ---------------------------------------------------------------------------------------------
// DOM

export interface TwoPaneOptions {
  onSelectNode?(id: string): void;
  onOpenDocs?(target: MethodDocTarget, nodeId: string): void;
  /** Text width in px (tests pass a fixed one). */
  measure?: Measure;
  elk?: ELK;
}

export interface CardInfo {
  /** The element's `data-card`: `node`, or `node#object` for one object of a merged loop box. */
  key: string;
  node: string;
  object: string | null;
  /** `shelf`: in its slot; `stage`: at its stage position; `hidden`: not shown at this step. */
  where: 'shelf' | 'stage' | 'hidden';
  /** The card's rectangle in its shelf slot, relative to the host element (null while its slot is hidden). */
  shelf: Rect | null;
  /** The card's rectangle on the stage, relative to the host element (null while it is not on the stage). */
  stage: Rect | null;
}

export interface TwoPaneController {
  /** Show step `step` (clamped; NaN is 0). */
  setStep(step: number): void;
  readonly step: number;
  /** Every card that exists so far, with where it is and its two rectangles. */
  cards(): CardInfo[];
  /** The stable element of a card, by key. */
  card(key: string): HTMLElement | null;
  /** The stage layout of the current step (canvas coordinates), null when nothing is on the stage. */
  readonly plan: StagePlan | null;
  readonly shelfEl: HTMLElement;
  readonly stageEl: HTMLElement;
  destroy(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const sv = <K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string | number> = {},
  cls?: string,
  text?: string,
): SVGElementTagNameMap[K] => {
  const e = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute('class', cls);
  if (text !== undefined) e.textContent = text;
  return e;
};

interface Card {
  key: string;
  node: string;
  object: string | null;
  wrap: HTMLElement;
  ctl: DiagramController | null;
  size: Size;
}

const STAGEABLE = new Set<GNode['kind']>(['instance', 'import', 'call', 'expr', 'store']);
let uid = 0;

export async function mountTwoPane(
  host: HTMLElement,
  model: GraphModel,
  log: EventLog,
  opts: TwoPaneOptions = {},
): Promise<TwoPaneController> {
  const doc = host.ownerDocument;
  const entries = shelfOrder(model);
  const entryOf = new Map<string, ShelfEntry>(entries.map((e) => [e.node, e]));

  // one ELK run for the size (and ports) of every box; the wires are drawn by `planStage`, not by ELK
  const synth: GraphModel = {
    nodes: model.nodes
      .filter((n) => STAGEABLE.has(n.kind))
      .map((n) => ({ ...n, parent: null }) as GNode),
    edges: [],
    steps: [],
  };
  const laid: Laid = await layout(synth, {
    attrRows: attrRowsFor(model, log),
    measure: opts.measure,
    elk: opts.elk,
  });
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const visualSize = (id: string): Size => {
    const ln = laid.nodes[id];
    return ln ? { w: ln.w, h: ln.h } : { w: 60, h: 24 };
  };
  const boxSize = (id: string): BoxSize => {
    const ln = laid.nodes[id];
    const ports: Record<string, number> = {};
    if (ln) for (const [k, p] of Object.entries(ln.ports)) ports[k] = p.x - ln.x;
    return { ...visualSize(id), ports };
  };

  const root = el(doc, 'div', 'md-twopane');
  const stageSec = el(doc, 'section', 'md-stage');
  stageSec.setAttribute('aria-label', 'Current line');
  const stageNotes = el(doc, 'div', 'md-stage-notes');
  stageNotes.setAttribute('aria-live', 'polite');
  const canvas = el(doc, 'div', 'md-stage-canvas');
  const stageEmpty = el(doc, 'p', 'md-stage-empty', 'Step to a line to see what it does here.');
  const wiresSvg = sv(doc, 'svg', { 'aria-hidden': 'true' }, 'md-diagram md-stage-wires');
  const valuesEl = el(doc, 'div', 'md-stage-values');
  valuesEl.setAttribute('role', 'list');
  valuesEl.setAttribute('aria-label', 'Values');
  canvas.append(wiresSvg, valuesEl);
  stageSec.append(stageNotes, stageEmpty, canvas);
  const shelfSec = el(doc, 'section', 'md-shelf-sec');
  shelfSec.setAttribute('aria-label', 'Objects');
  const shelfHead = el(doc, 'h3', 'md-shelf-title', 'Objects');
  const shelf = el(doc, 'div', 'md-shelf');
  shelf.setAttribute('role', 'list');
  shelfSec.append(shelfHead, shelf);
  root.append(stageSec, shelfSec);
  host.append(root);

  const mountOpts: MountOptions = {
    onSelectNode: (id) => opts.onSelectNode?.(id),
    onHoverEdge: () => undefined,
    onClickEdge: () => undefined,
    onOpenDocs: opts.onOpenDocs,
  };

  const cards = new Map<string, Card>();
  const makeCard = (key: string, node: string, object: string | null): Card => {
    const existing = cards.get(key);
    if (existing) return existing;
    const ln = laid.nodes[node];
    const wrap = el(doc, 'div', 'md-card');
    wrap.dataset.card = key;
    wrap.dataset.node = node;
    if (object !== null) wrap.dataset.object = object;
    let ctl: DiagramController | null = null;
    const size = visualSize(node);
    wrap.style.width = `${size.w + CARD_PAD.l + CARD_PAD.r}px`;
    wrap.style.height = `${size.h + CARD_PAD.t + CARD_PAD.b}px`;
    if (ln) {
      const shifted: LaidNode = {
        ...ln,
        x: CARD_PAD.l,
        y: CARD_PAD.t,
        ports: Object.fromEntries(
          Object.entries(ln.ports).map(([k, p]) => [
            k,
            { ...p, x: p.x - ln.x + CARD_PAD.l, y: p.y - ln.y + CARD_PAD.t },
          ]),
        ),
      };
      ctl = mount(wrap, mountOpts);
      ctl.setGraph(model, {
        width: size.w + CARD_PAD.l + CARD_PAD.r,
        height: size.h + CARD_PAD.t + CARD_PAD.b,
        nodes: { [node]: shifted },
        edges: {},
        labels: {},
        dropped: 0,
      });
    }
    const c: Card = { key, node, object, wrap, ctl, size };
    cards.set(key, c);
    return c;
  };

  // shelf slots, in creation order; all hidden until their entry is on the shelf
  interface Slot {
    entry: ShelfEntry;
    el: HTMLElement;
    ph: HTMLElement;
    cap: HTMLElement;
    card: Card;
  }
  const slots = new Map<string, Slot>();
  for (const e of entries) {
    const card = makeCard(e.node, e.node, null);
    const slotEl = el(doc, 'div', 'md-slot');
    slotEl.setAttribute('role', 'listitem');
    slotEl.dataset.slot = e.node;
    slotEl.hidden = true;
    const ph = el(doc, 'div', 'md-slot-ph');
    ph.hidden = true;
    // the dashed outline is the card's box; the card's padding becomes its margin, so the slot keeps its size
    ph.style.width = `${card.size.w}px`;
    ph.style.height = `${card.size.h}px`;
    ph.style.margin = `${CARD_PAD.t}px ${CARD_PAD.r}px ${CARD_PAD.b}px ${CARD_PAD.l}px`;
    const label = byId.get(e.node) ? slotLabel(byId.get(e.node)!) : e.node;
    ph.setAttribute('aria-label', `${label}, on the stage`);
    ph.append(el(doc, 'span', 'md-slot-ph-name', label), el(doc, 'span', 'md-slot-ph-text', 'on the stage'));
    const cap = el(doc, 'div', 'md-slot-cap');
    cap.hidden = true;
    slotEl.append(card.wrap, ph, cap);
    shelf.append(slotEl);
    slots.set(e.node, { entry: e, el: slotEl, ph, cap, card });
  }

  const chipEls = new Map<string, HTMLElement>();
  const markerId = `md-arrow-tp-${uid++}`;
  let current = 0;
  let plan: StagePlan | null = null;
  let onStage = new Map<string, { card: Card | null; item: PlanItem }>();
  let destroyed = false;

  const stageCardOf = (p: StageParticipant): Card | null => {
    if (p.kind === 'chip') return null;
    const e = entryOf.get(p.node);
    if (!e) return null;
    if (e.objects > 1 && p.object !== null) return makeCard(`${p.node}#${p.object}`, p.node, p.object);
    return makeCard(p.node, p.node, null);
  };
  const chipEl = (key: string, p: StageParticipant): HTMLElement => {
    let c = chipEls.get(key);
    if (!c) {
      c = el(doc, 'div', 'md-chipcard');
      c.dataset.card = key;
      c.setAttribute('role', 'group');
      chipEls.set(key, c);
    }
    const label = p.chip
      ? `${p.chip.type}${p.chip.shape ? ` (${p.chip.shape.join(', ')})` : ''}`
      : 'temporary';
    c.textContent = `temporary: ${label}`;
    c.setAttribute('aria-label', `temporary ${label}, not named`);
    return c;
  };
  const chipSize = (p: StageParticipant): Size => {
    const label = p.chip ? `${p.chip.type}${p.chip.shape ? ` (${p.chip.shape.join(', ')})` : ''}` : '';
    return { w: Math.ceil(`temporary: ${label}`.length * 7.2) + 20, h: 26 };
  };

  function setStep(step: number): void {
    if (destroyed) return;
    const total = model.steps.length;
    current = Number.isNaN(step) ? 0 : Math.max(0, Math.min(total, Math.trunc(step)));
    const st = stateAt(model, log, current);
    const stage = stageAt(model, log, current);
    const onShelf = new Map(shelfAt(model, current).map((s) => [s.node, s]));
    const active = doc.activeElement;
    const hadFocus = active !== null && root.contains(active);

    // 1. the plan
    plan = null;
    onStage = new Map();
    if (stage) {
      const boxNode = stage.kind === 'call' || stage.kind === 'expr' || stage.kind === 'store';
      const merged = (p: StageParticipant): boolean =>
        p.kind !== 'chip' && (entryOf.get(p.node)?.objects ?? 0) > 1;
      plan = planStage(
        stage,
        (p) => (p.kind === 'chip' ? chipSize(p) : visualSize(p.node)),
        boxNode && laid.nodes[stage.node] ? boxSize(stage.node) : null,
        merged,
        log,
      );
      for (const it of plan.items) onStage.set(it.key, { card: stageCardOf(it.participant), item: it });
    }
    const boxCard = plan?.box && stage ? makeCard(stage.node, stage.node, null) : null;

    // 2. put every element where it belongs
    for (const slot of slots.values()) {
      const e = slot.entry;
      const shown = onShelf.get(e.node);
      const here = onStage.get(e.node); // a single-object card on the stage leaves its slot
      slot.el.hidden = !shown;
      slot.ph.hidden = !(shown && here);
      slot.el.dataset.state = shown ? (here ? 'stage' : 'shelf') : 'hidden';
      if (!here) slot.el.prepend(slot.card.wrap);
      else if (slot.card.wrap.parentElement === slot.el) slot.card.wrap.remove();
      const n = byId.get(e.node);
      const inUse = [...onStage.values()].some((s) => s.card?.node === e.node && s.card.object !== null);
      if (shown && n?.kind === 'instance' && e.objects > 1) {
        slot.cap.hidden = false;
        slot.cap.textContent =
          (shown.filled >= e.objects ? `${e.objects} objects` : `${shown.filled} of ${e.objects} objects`) +
          (inUse ? ' (one is on the stage)' : '');
      } else slot.cap.hidden = true;
    }
    for (const c of cards.values()) c.wrap.classList.remove('md-on-stage');
    for (const [key, c] of chipEls) if (!onStage.has(key)) c.remove();
    for (const [key, s] of onStage) {
      const wrap = s.card ? s.card.wrap : chipEl(key, s.item.participant);
      canvas.append(wrap);
      wrap.classList.add('md-on-stage');
      place(wrap, s.item.rect, s.card !== null);
    }
    if (boxCard) canvas.append(boxCard.wrap);
    if (boxCard && plan?.box) {
      boxCard.wrap.classList.add('md-on-stage');
      place(boxCard.wrap, plan.box, true);
    }

    // 3. wires, values, notes
    drawWires();
    drawValues(stage);
    stageEmpty.hidden = stage !== null;
    canvas.hidden = stage === null;
    notes(stage);

    // 4. card state
    const stageIds = new Set<string>();
    if (stage) {
      for (const s of onStage.values()) if (s.card) stageIds.add(s.card.node);
      if (boxCard) stageIds.add(stage.node);
    }
    const owns = new Set<string>();
    for (const p of stage?.participants ?? []) if (p.changed && p.kind === 'instance') owns.add(p.node);
    for (const c of cards.values()) {
      const stageCard = [...onStage.values()].find((s) => s.card === c);
      const isBox = c === boxCard && !stageCard;
      const visible = new Set<string>();
      let objectBadge = new Map<string, { k: number; n: number }>();
      const versionOf = new Map<string, Token>();
      if (stageCard) {
        visible.add(c.node);
        const p = stageCard.item.participant;
        const tok = p.after ?? p.token;
        if (tok) versionOf.set(c.node, tok);
        if (p.objectOf) objectBadge = new Map([[c.node, p.objectOf]]);
      } else if (isBox) visible.add(c.node);
      else if (c.object === null && onShelf.has(c.node) && !onStage.has(c.node)) visible.add(c.node);
      const state: StepState = { ...st, visibleNodes: visible, objectBadge };
      c.ctl?.setState(state, log, { owns, versionOf });
      c.wrap.hidden = visible.size === 0;
    }
    if (hadFocus && active instanceof HTMLElement && active.isConnected === false) {
      const again = root.querySelector('[tabindex="0"]');
      if (again instanceof HTMLElement && !root.contains(doc.activeElement)) again.focus();
    }
  }

  function place(wrap: HTMLElement, r: Rect, padded: boolean): void {
    const l = padded ? CARD_PAD.l : 0;
    const t = padded ? CARD_PAD.t : 0;
    wrap.style.position = 'absolute';
    wrap.style.left = `${r.x - l}px`;
    wrap.style.top = `${r.y - t}px`;
  }

  function drawWires(): void {
    wiresSvg.replaceChildren();
    if (!plan) return;
    wiresSvg.setAttribute('width', String(plan.width));
    wiresSvg.setAttribute('height', String(plan.height));
    wiresSvg.setAttribute('viewBox', `0 0 ${plan.width} ${plan.height}`);
    canvas.style.width = `${plan.width}px`;
    canvas.style.height = `${plan.height}px`;
    const defs = sv(doc, 'defs');
    const marker = sv(doc, 'marker', {
      id: markerId,
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 8,
      markerHeight: 8,
      orient: 'auto',
      markerUnits: 'userSpaceOnUse',
    });
    marker.append(sv(doc, 'path', { d: 'M0 1L10 5L0 9z' }, 'md-arrow'));
    defs.append(marker);
    wiresSvg.append(defs);
    for (const w of plan.wires) {
      const g = sv(doc, 'g', {}, w.edge === null ? 'md-edge md-owner-line' : 'md-edge');
      if (w.edge !== null) g.dataset.edge = w.edge;
      g.append(
        sv(doc, 'path', {
          d: roundedPath(w.points),
          ...(w.arrow ? { 'marker-end': `url(#${markerId})` } : {}),
        }, 'md-wire'),
      );
      wiresSvg.append(g);
      if (w.label && (w.label.type || w.label.name)) {
        const t = sv(doc, 'text', { x: w.label.x, y: w.label.y, 'text-anchor': w.label.anchor }, 'md-halo');
        if (w.label.type) t.append(sv(doc, 'tspan', {}, 'md-wtype', w.label.type));
        if (w.label.name)
          t.append(sv(doc, 'tspan', { dx: w.label.type ? 4 : 0 }, 'md-wname', w.label.name));
        wiresSvg.append(t);
      }
    }
  }

  function drawValues(stage: StageModel | null): void {
    valuesEl.replaceChildren();
    valuesEl.hidden = !(plan?.values && stage);
    if (!plan?.values) return;
    valuesEl.style.left = `${plan.values.x}px`;
    valuesEl.style.top = `${plan.values.y}px`;
    valuesEl.style.width = `${plan.values.w}px`;
    for (const l of plan.values.lines) {
      const row = el(doc, 'div', 'md-stage-value', l);
      row.setAttribute('role', 'listitem');
      valuesEl.append(row);
    }
  }

  function notes(stage: StageModel | null): void {
    stageNotes.replaceChildren();
    if (!stage) return;
    if (stage.line !== null) stageNotes.append(el(doc, 'span', 'md-stage-line', `Line ${stage.line}`));
    if (stage.failed && stage.participants.some((p) => p.changed))
      stageNotes.append(el(doc, 'span', 'md-stage-note', '⚠ changed before it failed'));
    if (stage.dropped > 0)
      stageNotes.append(
        el(doc, 'span', 'md-stage-note', `${stage.dropped} ${stage.dropped === 1 ? 'object' : 'objects'} not shown`),
      );
  }

  const relTo = (r: DOMRect, base: DOMRect): Rect => ({
    x: r.left - base.left,
    y: r.top - base.top,
    w: r.width,
    h: r.height,
  });

  const controller: TwoPaneController = {
    setStep,
    get step() {
      return current;
    },
    get plan() {
      return plan;
    },
    shelfEl: shelf,
    stageEl: canvas,
    card(key) {
      return cards.get(key)?.wrap ?? chipEls.get(key) ?? null;
    },
    cards() {
      const base = host.getBoundingClientRect();
      const canvasAt = canvas.getBoundingClientRect();
      const out: CardInfo[] = [];
      for (const c of cards.values()) {
        const entry = slots.get(c.node);
        const st = onStage.get(c.key);
        const isStageBox = plan?.box !== null && !st && c.wrap.parentElement === canvas;
        const where: CardInfo['where'] = st || isStageBox ? 'stage' : c.wrap.hidden || !c.wrap.isConnected ? 'hidden' : 'shelf';
        let shelfRect: Rect | null = null;
        if (entry && !entry.el.hidden) {
          const ref = entry.el.firstElementChild;
          shelfRect = relTo((entry.ph.hidden ? (ref ?? entry.el) : entry.ph).getBoundingClientRect(), base);
        }
        let stageRect: Rect | null = null;
        if (st)
          stageRect = {
            x: canvasAt.left - base.left + st.item.rect.x - CARD_PAD.l,
            y: canvasAt.top - base.top + st.item.rect.y - CARD_PAD.t,
            w: st.item.rect.w + CARD_PAD.l + CARD_PAD.r,
            h: st.item.rect.h + CARD_PAD.t + CARD_PAD.b,
          };
        out.push({ key: c.key, node: c.node, object: c.object, where, shelf: shelfRect, stage: stageRect });
      }
      return out;
    },
    destroy() {
      destroyed = true;
      for (const c of cards.values()) c.ctl?.destroy();
      cards.clear();
      root.remove();
    },
  };
  setStep(0);
  return controller;
}

function slotLabel(n: GNode): string {
  if (n.kind === 'instance') return n.varName ? `${n.varName}: ${n.className}` : n.className;
  if (n.kind === 'import') return `import ${n.name}`;
  return n.id;
}
