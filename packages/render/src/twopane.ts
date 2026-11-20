// Two-pane renderer (svl-61q.2, CONTRACTS.md section 8 "Two-pane view"): an object SHELF (a grid of cards in
// creation order, no wires) and a STAGE (the current line: its call box, the objects it uses and the wires
// between them). Framework-free. The layout of the stage is a pure function (`planStage`); `mountTwoPane`
// builds the DOM. Each object card is one stable element that moves between its shelf slot and the stage.
import {
  lineStageAt,
  reprTruncated,
  shelfAt,
  shelfOrder,
  stageAt,
  stateAt,
  valueNames,
} from '@machines/log';
import type {
  CallNode,
  EventLog,
  GEdge,
  GNode,
  GraphModel,
  LineStageModel,
  ShelfEntry,
  ValueCard,
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
import { attrRowsFor, moreMethodsFor, SVG_NS, wireTypeLabel, roundedPath } from './svg';
import type { MethodDocTarget } from './svg';

/** Room around a card's box inside its element: the "x3" badge above, a status message below. */
export const CARD_PAD = { l: 6, t: 22, r: 6, b: 30 };
/** Height of a shelf placeholder (px): one line, so its text is never cut. */
export const PH_MAX_H = 30;
export const STAGE = { margin: 16, colGap: 24, rowGap: 52, sideGap: 56, valuesGap: 24 };

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
  /**
   * svl-u3v: the box is the callee's own card (a function, a class or the module of the call): the stage draws it
   * where the call box would stand, wires the call's ports to its edges, and labels it with `label`.
   */
  callee?: true;
  label?: string;
}

export interface PlanItem {
  /** Card key: `node`, or `node#object` for one object of a merged loop box, or `chip:<edge>`. */
  key: string;
  participant: StageParticipant;
  /** The box of the card (without the padding around it). */
  rect: Rect;
  /** Line groups (svl-qol): the index of the call whose participant this card shows. */
  call?: number;
}
export interface PlanWire {
  /** The graph edge; null for the owner line. */
  edge: string | null;
  from: string;
  to: string;
  points: [number, number][];
  arrow: boolean;
  label: {
    x: number;
    y: number;
    type: string;
    name: string;
    anchor: 'start' | 'middle' | 'end';
  } | null;
}
export interface StagePlan {
  width: number;
  height: number;
  box: Rect | null;
  items: PlanItem[];
  wires: PlanWire[];
  /** Inline scalars and literals, one text line each, beside the call box (nested: under the owner). */
  values: { x: number; y: number; w: number; lines: string[]; call?: number } | null;
  /**
   * svl-a9e: true when the call is a method drawn inside its owner's card; `box` is then the method's box
   * inside that card (canvas coordinates) and there is no separate call box.
   */
  nested?: true;
  /** svl-u3v: the call box is the callee's own card (an item with role `callee`), not a card of its own. */
  calleeBox?: true;
  /** Text drawn beside a callee card: the call's name (`read_csv` on the `pd` card). Canvas coordinates. */
  callLabels?: { x: number; y: number; text: string }[];
  /** Nested layouts: the method boxes, one per call, in call order. */
  boxes?: Rect[];
  /** Line groups (svl-qol, `planLine`): every call drawn, in call order; `box` is the current one's. */
  calls?: PlanCall[];
  /** Line groups: the inline values of every call's layout (`values` is the last). */
  valuesAll?: NonNullable<StagePlan['values']>[];
}

/**
 * svl-17v: the part of a line group's stage to keep in view: the current call's box and the cards that belong to it
 * (null for a single call: its stage is shown from the top). Canvas coordinates.
 */
export function currentFocus(plan: StagePlan | null): Rect | null {
  const cur = plan?.calls?.find((c) => c.current);
  if (!plan || !cur) return null;
  const rs: Rect[] = [
    cur.rect,
    ...plan.items.filter((i) => i.call === cur.call).map((i) => i.rect),
  ];
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Where the current method's box sits inside its owner's card (svl-a9e): relative to the owner's box. */
export interface NestedBox {
  rect: Rect;
}

/** A value card's text, `name = repr`: the card shows it on one line (cut by CSS), the title and the label say it whole. */
export function valueCardText(v: ValueCard, names: string[] = v.names.map((n) => n.name)): string {
  const who = [...new Set(names)].join(', ');
  return v.text === null ? who : `${who} = ${v.text}`;
}
/** The size of a value card's box (svl-o6m): one line of its text, at most `VALUE_CARD_MAX_CHARS` characters wide. */
export const VALUE_CARD_MAX_CHARS = 26;
export function valueCardSize(v: ValueCard): Size {
  const chars = Math.min(VALUE_CARD_MAX_CHARS, Math.max(4, valueCardText(v).length));
  return { w: Math.ceil(chars * 7.4) + 28, h: 30 };
}

/** The key of a participant's card. */
export function cardKey(p: StageParticipant, merged: boolean): string {
  if (p.kind === 'chip') return `chip:${p.edge ?? p.node}`;
  return merged && p.object !== null ? `${p.node}#${p.object}` : p.node;
}

/** Inline values are cut at this many characters; they sit beside the call box unless that is wider than the other. */
const VALUE_MAX_CHARS = 22;
const VALUES_BESIDE_MAX = 400;

/** Does any (axis-aligned) segment of the polyline touch the rect, padded by 6 px? */
function wireHits(
  points: [number, number][],
  r: { x: number; y: number; w: number; h: number },
): boolean {
  const pad = 6;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    if (x1 >= r.x - pad && x0 <= r.x + r.w + pad && y1 >= r.y - pad && y0 <= r.y + r.h + pad)
      return true;
  }
  return false;
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
  nested?: NestedBox | null,
  skip?: ReadonlyMap<string, 'stub' | 'drop'>,
): StagePlan {
  if (nested && !box) {
    const own = stage.participants.find((p) => p.kind === 'instance' && p.role === 'owner');
    if (own) return planNested([{ stage, nested, tag: 'box' }], size, own, mergedOf, log);
  }
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
  // one card per key: an object two ports take (`np.add(a, a)`) is one card with a wire per port
  const firstOf = (ps: StageParticipant[]): StageParticipant[] => {
    const seen = new Set<string>();
    return ps.filter((p) => {
      const k = cardKey(p, mergedOf(p));
      return !seen.has(k) && seen.add(k);
    });
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

  // the callee (svl-jl3, a function or class block) stands where the owner does, left of the call box; a call
  // with a callee has no owner, so there is one participant on the left
  const calleeP = box.callee ? stage.participants.find((p) => p.role === 'callee') : undefined;
  const owner = stage.participants.find(
    (p) => p.role === 'owner' || (p.role === 'callee' && p !== calleeP),
  );
  const ins = stage.participants.filter((p) => p.role === 'input');
  const outs = stage.participants.filter((p) => p.role === 'output' || p.role === 'created');
  // svl-17v: an object drawn on another band (`skip`) takes no room here: its wire is a stub that `planLine` joins
  // to the card's home, or (`drop`) no wire at all
  const skipOf = (p: StageParticipant): 'stub' | 'drop' | undefined =>
    skip?.get(cardKey(p, mergedOf(p)));
  const insHere = ins.filter((p) => !skipOf(p));
  const outsHere = outs.filter((p) => !skipOf(p));
  const stubIn = ins.some((p) => skipOf(p) === 'stub');
  const stubOut = outs.some((p) => skipOf(p) === 'stub');
  const STUB = 30;
  const inCards = firstOf(insHere);
  const inH = Math.max(0, ...S(insHere).map((s) => s.h));
  const outH = Math.max(0, ...S(outsHere).map((s) => s.h));
  const ownerSpace = owner ? sz.get(owner)!.w + STAGE.sideGap : 0;
  const boxX = ownerSpace;
  const cx = boxX + box.w / 2;
  const boxY = insHere.length ? inH + STAGE.rowGap : stubIn ? STUB : 0;
  const boxRect: Rect = { x: boxX, y: boxY, w: box.w, h: box.h };
  // svl-u3v: the callee's card is the call box
  if (calleeP) place(calleeP, boxX, boxY);
  const labelW = calleeP && box.label ? Math.ceil(box.label.length * 7.2) + 12 : 0;

  // vertical gaps: the wires' horizontal runs sit in the gap, one level per wire
  const level = (k: number, n: number, y0: number, y1: number): number =>
    y0 + ((y1 - y0) * (k + 1)) / (n + 1);
  const portX = (p: StageParticipant, k: number, n: number): number =>
    boxX +
    (p.port !== null && box.ports[p.port] !== undefined
      ? box.ports[p.port]!
      : (box.w * (k + 1)) / (n + 1));
  const typeOf = (p: StageParticipant): string => {
    // an object is a card that shows its own type; only scalars get a type on the wire
    return p.kind !== 'chip' && p.token ? wireTypeLabel(p.token, log?.values) : '';
  };

  // a tall owner beside the box reaches into the rows above and below: those rows start to its right
  const ownerS = owner ? sz.get(owner)! : null;
  const ownerTop = ownerS ? boxY + box.h / 2 - ownerS.h / 2 : 0;
  const ownerBottom = ownerS ? ownerTop + ownerS.h : 0;
  const clearOwner = (x0: number, rowBottom: number, rowTop: number): number =>
    ownerS && ownerTop < rowBottom && ownerBottom > rowTop
      ? Math.max(x0, ownerS.w + STAGE.colGap)
      : x0;
  let x = clearOwner(cx - rowWidth(S(inCards)) / 2, inH + 0, 0);
  const placed = new Map<string, PlanItem>();
  ins.forEach((p, k) => {
    const s = sz.get(p)!;
    const key = cardKey(p, mergedOf(p));
    if (skipOf(p)) {
      const px = portX(p, k, ins.length);
      wires.push({
        edge: p.edge,
        from: key,
        to: 'box',
        points: [
          [px, boxY - STUB],
          [px, boxY],
        ],
        arrow: true,
        label: {
          x: px + 5,
          y: boxY - 8,
          type: typeText(typeOf(p)),
          name: p.kind === 'chip' ? '' : (p.param ?? ''),
          anchor: 'start',
        },
      });
      return;
    }
    let it = placed.get(key);
    if (!it) {
      it = place(p, x, inH - s.h);
      placed.set(key, it);
      x += s.w + STAGE.colGap;
    }
    const sx = it.rect.x + s.w / 2;
    const sy = it.rect.y + s.h;
    const px = portX(p, k, ins.length);
    const my = level(k, ins.length, inH, boxY);
    wires.push({
      edge: p.edge,
      from: it.key,
      to: 'box',
      points:
        sx === px
          ? [
              [sx, sy],
              [px, boxY],
            ]
          : [
              [sx, sy],
              [sx, my],
              [px, my],
              [px, boxY],
            ],
      arrow: true,
      label: {
        x: sx + 5,
        y: sy + 14,
        type: typeText(typeOf(p)),
        name: p.kind === 'chip' ? '' : (p.param ?? ''),
        anchor: 'start',
      },
    });
  });
  const outTop = boxY + box.h + (outsHere.length ? STAGE.rowGap : stubOut ? STUB : 0);
  x = clearOwner(cx - rowWidth(S(outsHere)) / 2, outTop + outH, outTop);
  outs.forEach((p, k) => {
    const sk = skipOf(p);
    if (sk) {
      if (sk === 'stub') {
        const px = portX(p, k, outs.length);
        wires.push({
          edge: p.edge,
          from: 'box',
          to: cardKey(p, mergedOf(p)),
          points: [
            [px, boxY + box.h],
            [px, boxY + box.h + STUB],
          ],
          arrow: true,
          label: {
            x: px + 5,
            y: boxY + box.h + 16,
            type: typeText(typeOf(p)),
            name: p.kind === 'chip' ? '' : (p.param ?? ''),
            anchor: 'start',
          },
        });
      }
      return;
    }
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
          ? [
              [px, boxY + box.h],
              [ex, outTop],
            ]
          : [
              [px, boxY + box.h],
              [px, my],
              [ex, my],
              [ex, outTop],
            ],
      arrow: true,
      label: {
        x: ex + 5,
        y: outTop - 8,
        type: typeText(typeOf(p)),
        name: p.kind === 'chip' ? '' : (p.param ?? ''),
        anchor: 'start',
      },
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
      points: [
        [s.w, cy],
        [boxX, cy],
      ],
      arrow: false,
      label: {
        x: s.w + STAGE.sideGap / 2,
        y: cy - 6,
        type: '',
        name: owner.role === 'callee' ? 'calls' : 'owner',
        anchor: 'middle',
      },
    });
  }

  let vals: StagePlan['values'] = null;
  if (stage.values.length) {
    const lines = stage.values.map(valueLine);
    // a long value is cut at VALUE_MAX_CHARS (the renderer ellipsizes it and keeps the full text as its title),
    // so one inline value cannot widen the canvas and shrink the stage's zoom
    const w =
      Math.ceil(Math.min(VALUE_MAX_CHARS, Math.max(...lines.map((l) => l.length))) * 7.2) + 16;
    const h = lines.length * 18;
    let x = boxX + box.w + STAGE.valuesGap + labelW;
    let y = boxY;
    // beside the box would make a wide canvas: put the values under the box's right edge instead when no
    // wire runs through that spot
    if (x + w > VALUES_BESIDE_MAX) {
      const below = { x: Math.max(boxX, boxX + box.w - w), y: boxY + box.h + 6, w, h };
      if (
        (!outsHere.length || h + 14 <= STAGE.rowGap - 8) &&
        !wires.some((wr) => wireHits(wr.points, below))
      ) {
        x = below.x;
        y = below.y;
      }
    }
    vals = { x, y, w, lines };
  }

  // shift everything so nothing is left of the margin, then size the canvas
  let maxX = boxRect.x + boxRect.w;
  let maxY = outsHere.length ? outTop + outH : boxY + box.h + (stubOut ? STUB : 0);
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
  if (labelW) maxX = Math.max(maxX, boxRect.x + boxRect.w + labelW);
  return {
    width: Math.ceil(maxX + dx + STAGE.margin),
    height: Math.ceil(maxY + dy + STAGE.margin),
    box: boxRect,
    items,
    wires,
    values: vals,
    ...(calleeP
      ? {
          calleeBox: true as const,
          callLabels: box.label
            ? [{ x: boxRect.x + boxRect.w + 6, y: boxRect.y + boxRect.h / 2, text: box.label }]
            : [],
        }
      : {}),
  };
}

/** A method call drawn in its owner's card (svl-a9e): its step, the method box's place, and the tag its wires use. */
interface NestedCall {
  stage: StageModel;
  nested: NestedBox;
  tag: string;
}

/**
 * The stage of one or more method calls on one owner (svl-a9e, svl-qol): the owner's card stands in the
 * middle with the method boxes inside it, as in the full diagram. The objects the calls use stand in a column
 * to its left, each wired to a lane on its call's method box's left edge; the objects they make stand in a
 * column to the right, wired from lanes on the right edge. The wires are horizontal where they cross the
 * owner's card, so they never run over the other method boxes, and the inline values sit under the card.
 * There is no call box and no owner line. An object two calls use is one card with a wire per call.
 */
function planNested(
  calls: NestedCall[],
  size: (p: StageParticipant) => Size,
  owner: StageParticipant,
  mergedOf: (p: StageParticipant) => boolean,
  log?: EventLog,
): StagePlan {
  const items: PlanItem[] = [];
  const wires: PlanWire[] = [];
  const sz = new Map<StageParticipant, Size>();
  for (const c of calls) for (const p of c.stage.participants) sz.set(p, size(p));
  const key = (p: StageParticipant): string => cardKey(p, mergedOf(p));
  interface Entry {
    call: number;
    p: StageParticipant;
    k: number;
    n: number;
  }
  const entriesOf = (pick: (p: StageParticipant) => boolean): Entry[] =>
    calls.flatMap((c, call) => {
      const ps = c.stage.participants.filter(pick);
      return ps.map((p, k) => ({ call, p, k, n: ps.length }));
    });
  const ins = entriesOf((p) => p.role === 'input');
  const outs = entriesOf((p) => p.role === 'output' || p.role === 'created');
  const cards = (es: Entry[]): Entry[] => {
    const seen = new Set<string>();
    return es.filter((e) => !seen.has(key(e.p)) && seen.add(key(e.p)));
  };
  const so = sz.get(owner)!;
  const colH = (es: Entry[]): number =>
    es.reduce((a, e) => a + sz.get(e.p)!.h, 0) + Math.max(0, es.length - 1) * STAGE.colGap;
  const inCards = cards(ins);
  const outCards = cards(outs);
  const leftW = Math.max(0, ...inCards.map((e) => sz.get(e.p)!.w));
  const ownerX = inCards.length ? leftW + STAGE.sideGap : 0;
  const rightX = ownerX + so.w + STAGE.sideGap;
  const ms: Rect[] = calls.map((c) => ({
    x: ownerX + c.nested.rect.x,
    y: c.nested.rect.y,
    w: c.nested.rect.w,
    h: c.nested.rect.h,
  }));
  const ym = (Math.min(...ms.map((m) => m.y)) + Math.max(...ms.map((m) => m.y + m.h))) / 2;
  const typeOf = (p: StageParticipant): string =>
    p.kind !== 'chip' && p.token ? wireTypeLabel(p.token, log?.values) : '';
  // lanes on a method box's edge, spread over its height
  const lane = (m: Rect, k: number, n: number): number =>
    n === 1 ? m.y + m.h / 2 : m.y + 4 + (k * (m.h - 8)) / (n - 1);

  items.push({
    key: key(owner),
    participant: owner,
    rect: { x: ownerX, y: 0, w: so.w, h: so.h },
    call: 0,
  });
  const place = (cs: Entry[], x: (w: number) => number): Map<string, Rect> => {
    const at = new Map<string, Rect>();
    let y = ym - colH(cs) / 2;
    for (const e of cs) {
      const s = sz.get(e.p)!;
      const r = { x: x(s.w), y, w: s.w, h: s.h };
      at.set(key(e.p), r);
      items.push({ key: key(e.p), participant: e.p, rect: r, call: e.call });
      y += s.h + STAGE.colGap;
    }
    return at;
  };
  const inAt = place(inCards, (w) => leftW - w);
  const outAt = place(outCards, () => rightX);
  ins.forEach((e, n) => {
    const r = inAt.get(key(e.p))!;
    const m = ms[e.call]!;
    const cy = r.y + r.h / 2;
    const xv = leftW + (STAGE.sideGap * (n + 1)) / (ins.length + 1);
    const ly = lane(m, e.k, e.n);
    wires.push({
      edge: e.p.edge,
      from: key(e.p),
      to: calls[e.call]!.tag,
      points:
        cy === ly
          ? [
              [leftW, cy],
              [m.x, ly],
            ]
          : [
              [leftW, cy],
              [xv, cy],
              [xv, ly],
              [m.x, ly],
            ],
      arrow: true,
      label: {
        x: leftW + 5,
        y: cy - 5,
        type: typeText(typeOf(e.p)),
        name: e.p.kind === 'chip' ? '' : (e.p.param ?? ''),
        anchor: 'start',
      },
    });
  });
  outs.forEach((e, n) => {
    const r = outAt.get(key(e.p))!;
    const m = ms[e.call]!;
    const cy = r.y + r.h / 2;
    const xv = ownerX + so.w + (STAGE.sideGap * (n + 1)) / (outs.length + 1);
    const ly = lane(m, e.k, e.n);
    const mr = m.x + m.w;
    wires.push({
      edge: e.p.edge,
      from: calls[e.call]!.tag,
      to: key(e.p),
      points:
        cy === ly
          ? [
              [mr, ly],
              [rightX, cy],
            ]
          : [
              [mr, ly],
              [xv, ly],
              [xv, cy],
              [rightX, cy],
            ],
      arrow: true,
      label: {
        x: rightX - 5,
        y: cy - 5,
        type: typeText(typeOf(e.p)),
        name: e.p.kind === 'chip' ? '' : (e.p.param ?? ''),
        anchor: 'end',
      },
    });
  });

  let vals: StagePlan['values'] = null;
  const valueRows = calls.flatMap((c) => c.stage.values);
  if (valueRows.length) {
    const lines = valueRows.map(valueLine);
    const w =
      Math.ceil(Math.min(VALUE_MAX_CHARS, Math.max(...lines.map((l) => l.length))) * 7.2) + 16;
    vals = { x: ownerX, y: so.h + 8, w, lines };
  }

  // shift so nothing is above or left of the margin, then size the canvas
  let minY = 0;
  let maxX = ownerX + so.w;
  let maxY = so.h;
  for (const it of items) {
    minY = Math.min(minY, it.rect.y);
    maxX = Math.max(maxX, it.rect.x + it.rect.w);
    maxY = Math.max(maxY, it.rect.y + it.rect.h);
  }
  if (vals) {
    maxX = Math.max(maxX, vals.x + vals.w);
    maxY = Math.max(maxY, vals.y + vals.lines.length * 18);
  }
  const dx = STAGE.margin;
  const dy = STAGE.margin - minY;
  for (const it of items) {
    it.rect.x += dx;
    it.rect.y += dy;
  }
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
  const boxes = ms.map((m) => ({ x: m.x + dx, y: m.y + dy, w: m.w, h: m.h }));
  return {
    width: Math.ceil(maxX + dx + STAGE.margin),
    height: Math.ceil(maxY + dy + STAGE.margin),
    box: boxes[boxes.length - 1]!,
    boxes,
    items,
    wires,
    values: vals,
    nested: true,
  };
}

/** One call of a line group on the stage (svl-qol). */
export interface PlanCall {
  /** Index into the group's calls. */
  call: number;
  node: string;
  /** The call's box: its own card, or for a method the box inside its owner's card. */
  rect: Rect;
  nested: boolean;
  current: boolean;
  /** svl-u3v: the box is the callee's card (an item of the plan), so no card is made for `node`. */
  calleeBox?: true;
}

/** Vertical space between the layouts of two calls that do not share a card (px); wires jog across it. */
const BAND_GAP = 40;
/** About the room the stage has at 1440 x 900 (px): a line group goes into two columns when that gives a bigger zoom. */
const STAGE_PANE = { w: 600, h: 700 };

/**
 * The stage of a line group (svl-qol): every call of the line that has run so far. Each call is laid out as
 * `planStage` lays out a single call (a call box with its objects above and below, or a method inside its
 * owner's card; consecutive methods of one owner share that card) and the layouts are stacked top to bottom in
 * call order. An object that two calls use is drawn once, where it first appears (an owner that hosts method
 * boxes: in its own layout, wired from the call that made it); every other use is wired to that one card by a
 * wire that drops through the gap between the layouts, so one call's output reaches the next call's port. A
 * wire exists only for an edge a call's own stage reported. Null when the line cannot be drawn this way (an
 * owner that an earlier call already uses as an input cannot also host a method later): the caller then
 * draws the current call alone.
 */
export function planLine(
  line: LineStageModel,
  size: (p: StageParticipant) => Size,
  boxOf: (stage: StageModel, calleeOk?: boolean) => BoxSize | null,
  nestedOf: (stage: StageModel) => NestedBox | null,
  mergedOf: (p: StageParticipant) => boolean,
  log?: EventLog,
): StagePlan | null {
  interface Band {
    nested: boolean;
    calls: number[];
    plan: StagePlan;
    top: number;
  }
  const bands: Band[] = [];
  const ownerOf = (st: StageModel): StageParticipant | undefined =>
    st.participants.find((p) => p.kind === 'instance' && p.role === 'owner');
  // 1. group the calls into bands. A method is drawn inside its owner's card only where that card is
  // drawn for it: when the owner is not yet on the stage, or only as the product of an earlier call, or the
  // previous band is the same owner's. An owner that an earlier call already uses as an input keeps its card
  // there, and the method gets a call box of its own with the owner wired to it.
  const used = new Set<string>(); // objects an earlier call used other than as its product
  const cardOf = (p: StageParticipant): string => cardKey(p, mergedOf(p));
  const groups: { nested: boolean; calls: number[] }[] = [];
  line.calls.forEach((c, k) => {
    const n = nestedOf(c.stage);
    const own = n ? ownerOf(c.stage) : undefined;
    const last = groups[groups.length - 1];
    const lastOwner = last?.nested ? ownerOf(line.calls[last.calls[0]!]!.stage) : undefined;
    if (n && own && last?.nested && lastOwner && cardOf(lastOwner) === cardOf(own))
      last.calls.push(k);
    else
      groups.push({
        nested: n !== null && own !== undefined && !used.has(cardOf(own)),
        calls: [k],
      });
    for (const p of c.stage.participants)
      if (p.role !== 'output' && p.role !== 'created') used.add(cardOf(p));
  });
  // svl-17v: where each object is drawn (its home: the band of the owner that hosts method boxes, else the first
  // band that has it). A plain band takes no room for an input or output that is drawn on another band: the wire
  // becomes a stub, and the step below joins it to the home card.
  const bandsOf = new Map<string, number[]>();
  const hostOf = new Map<string, number>();
  groups.forEach((g, gi) => {
    for (const k of g.calls)
      for (const p of line.calls[k]!.stage.participants) {
        const key = cardOf(p);
        const l = bandsOf.get(key);
        if (!l) bandsOf.set(key, [gi]);
        else if (!l.includes(gi)) l.push(gi);
        if (g.nested && p.role === 'owner' && p.kind === 'instance' && !hostOf.has(key))
          hostOf.set(key, gi);
      }
  });
  const skipsOf = (gi: number): Map<string, 'stub' | 'drop'> => {
    const skip = new Map<string, 'stub' | 'drop'>();
    const g = groups[gi]!;
    if (g.nested) return skip;
    const ps = line.calls[g.calls[0]!]!.stage.participants;
    for (const p of ps) {
      if (p.role !== 'input' && p.role !== 'output' && p.role !== 'created') continue;
      const key = cardOf(p);
      const home = hostOf.get(key) ?? bandsOf.get(key)![0]!;
      if (home === gi) continue;
      const roles = new Set(ps.filter((q) => cardOf(q) === key).map((q) => q.role === 'input'));
      if (roles.size > 1) continue; // used and made by the same call: drawn in place as before
      const isInput = p.role === 'input';
      if (isInput && home > gi) continue; // cannot be drawn: planLine gives up below
      skip.set(key, isInput || home > gi ? 'stub' : 'drop');
    }
    return skip;
  };
  // 2. lay each band out
  const calleesUsed = new Set<string>();
  for (const [gi, g] of groups.entries()) {
    const stages = g.calls.map((k) => line.calls[k]!.stage);
    let plan: StagePlan;
    if (g.nested) {
      plan = planNested(
        stages.map((stage, j) => ({
          stage,
          nested: nestedOf(stage)!,
          tag: `box#${g.calls[j]}`,
        })),
        size,
        ownerOf(stages[0]!)!,
        mergedOf,
        log,
      );
      for (const it of plan.items) it.call = g.calls[it.call ?? 0];
    } else {
      const stage = stages[0]!;
      // a callee card can be the call box once in a line (a second call of the same block gets a plain box)
      const cp = stage.participants.find((p) => p.role === 'callee');
      const ok = cp === undefined || !calleesUsed.has(cp.node);
      if (cp && ok) calleesUsed.add(cp.node);
      plan = planStage(stage, size, boxOf(stage, ok), mergedOf, log, undefined, skipsOf(gi));
      const tag = `box#${g.calls[0]}`;
      for (const w of plan.wires) {
        if (w.from === 'box') w.from = tag;
        if (w.to === 'box') w.to = tag;
      }
      for (const it of plan.items) it.call = g.calls[0];
    }
    bands.push({ nested: g.nested, calls: g.calls, plan, top: 0 });
  }
  // 3. arrange them: one column, or two side by side when that is much shorter (svl-17v). A column stacks its
  // bands top to bottom in call order; the second column starts where the first leaves off (reading order).
  const M = STAGE.margin;
  const bandH = (b: Band): number => b.plan.height - 2 * M;
  const colHeight = (bs: Band[]): number =>
    bs.reduce((a, b) => a + bandH(b), 0) + Math.max(0, bs.length - 1) * BAND_GAP;
  const bandW = (bs: Band[]): number => Math.max(0, ...bs.map((b) => b.plan.width));
  let split = bands.length; // bands before the index are in column 0
  {
    // the zoom the stage would get in a pane of about `STAGE_PANE` (a 1440 x 900 window): width- or height-limited
    const zoom = (w: number, h: number): number => Math.min(1, STAGE_PANE.w / w, STAGE_PANE.h / h);
    let best = zoom(bandW(bands), colHeight(bands) + 2 * M);
    const one = best;
    for (let m = 1; m < bands.length; m++) {
      const a = bands.slice(0, m);
      const c = bands.slice(m);
      const z = zoom(bandW(a) + bandW(c) + 24, Math.max(colHeight(a), colHeight(c)) + 2 * M);
      if (z > best && z > one * 1.1) {
        best = z;
        split = m;
      }
    }
  }
  const col = (bi: number): 0 | 1 => (bi < split ? 0 : 1);
  const colsN = split < bands.length ? 2 : 1;
  {
    const tops = [0, BAND_GAP / 2];
    bands.forEach((b, bi) => {
      const c = col(bi);
      b.top = tops[c]!;
      tops[c] = b.top + bandH(b) + BAND_GAP;
    });
  }
  const shiftPlan = (p: StagePlan, dx: number, dy: number): void => {
    for (const it of p.items) {
      it.rect.x += dx;
      it.rect.y += dy;
    }
    for (const w of p.wires) {
      w.points = w.points.map(([a, c]) => [a + dx, c + dy] as [number, number]);
      if (w.label) {
        w.label.x += dx;
        w.label.y += dy;
      }
    }
    if (p.values) {
      p.values.x += dx;
      p.values.y += dy;
    }
    for (const l of p.callLabels ?? []) {
      l.x += dx;
      l.y += dy;
    }
    if (p.box) p.box = { ...p.box, x: p.box.x + dx, y: p.box.y + dy };
    if (p.boxes) p.boxes = p.boxes.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  };
  for (const b of bands) shiftPlan(b.plan, 0, b.top);
  const gapAbove = (band: number): number => bands[band]!.top + M - BAND_GAP / 2;
  const gapBelow = (band: number): number =>
    bands[band]!.top + bands[band]!.plan.height - M + BAND_GAP / 2;
  // 4. one card per object
  const occ = new Map<string, { band: number; item: PlanItem }[]>();
  bands.forEach((b, bi) => {
    for (const it of b.plan.items) {
      const l = occ.get(it.key);
      if (l) l.push({ band: bi, item: it });
      else occ.set(it.key, [{ band: bi, item: it }]);
    }
  });
  const jogs = new Map<number, number>();
  const nextJog = (y: number, band: number): number => {
    const n = jogs.get(band) ?? 0;
    jogs.set(band, n + 1);
    return y - 14 + n * 6;
  };
  // A wire to a card that is drawn elsewhere runs through a gutter beside the columns, never over a card:
  // out of the home card's side, along a lane to the gap above (or below) the layout, and in.
  interface Job {
    kind: 'in' | 'out';
    wire: PlanWire;
    home: PlanItem;
    homeBand: number;
    band: number;
    gap: number; // y of the horizontal run in the gap
    side: 'L' | 'R';
    ey: number;
    lane: 'FL' | 'M' | 'FR';
  }
  const jobs: Job[] = [];
  for (const list of occ.values()) {
    if (list.length < 2) continue;
    const hosts = list.filter(
      (o) =>
        bands[o.band]!.nested &&
        o.item.participant.role === 'owner' &&
        o.item.participant.kind === 'instance',
    );
    if (new Set(hosts.map((h) => h.band)).size > 1) return null;
    const home = hosts[0] ?? list[0]!;
    for (const o of list) {
      if (o === home) continue;
      const p = o.item.participant;
      if (o.band < home.band && p.role !== 'output' && p.role !== 'created') return null;
      const band = bands[o.band]!.plan;
      band.items.splice(band.items.indexOf(o.item), 1);
      const below = home.band > o.band;
      const gap = below
        ? nextJog(gapBelow(o.band), -o.band - 1)
        : nextJog(gapAbove(o.band), o.band);
      band.wires = band.wires.filter((w) => {
        // a wire the later call has to an object drawn above (or the earlier call from one drawn below) is not drawn
        if (below ? w.from === o.item.key : w.to === o.item.key) return false;
        if (below ? w.to === o.item.key : w.from === o.item.key)
          jobs.push({
            kind: below ? 'out' : 'in',
            wire: w,
            home: home.item,
            homeBand: home.band,
            band: o.band,
            gap,
            side: 'L',
            ey: 0,
            lane: 'FL',
          });
        return true;
      });
    }
  }
  // a stub (svl-17v): the wire of an object that another band draws, joined to that card the same way
  const itemOf = (key: string): { band: number; item: PlanItem } | undefined => {
    for (const [bi, b] of bands.entries()) {
      const item = b.plan.items.find((i) => i.key === key);
      if (item) return { band: bi, item };
    }
    return undefined;
  };
  for (const [bi, b] of bands.entries()) {
    const here = new Set(b.plan.items.map((i) => i.key));
    for (const w of b.plan.wires) {
      if (jobs.some((j) => j.wire === w)) continue; // already joined to its home above
      const stubIn = !w.from.startsWith('box') && !here.has(w.from);
      const stubOut = !w.to.startsWith('box') && !here.has(w.to);
      if (!stubIn && !stubOut) continue;
      const home = itemOf(stubIn ? w.from : w.to);
      if (!home) return null;
      jobs.push({
        kind: stubIn ? 'in' : 'out',
        wire: w,
        home: home.item,
        homeBand: home.band,
        band: bi,
        gap: stubIn ? nextJog(gapAbove(bi), bi) : nextJog(gapBelow(bi), -bi - 1),
        side: 'L',
        ey: 0,
        lane: 'FL',
      });
    }
  }
  // the cards and boxes a wire must not cross, by column
  const obsOf = (c: 0 | 1): Rect[] =>
    bands.flatMap((b, bi) =>
      col(bi) !== c
        ? []
        : [...b.plan.items.map((i) => i.rect), ...(b.nested || !b.plan.box ? [] : [b.plan.box])],
    );
  const obs = [obsOf(0), obsOf(1)];
  const clear = (side: 'L' | 'R', y: number, home: Rect, c: 0 | 1): boolean =>
    !obs[c]!.some(
      (r) =>
        r !== home &&
        r.y - 4 < y &&
        y < r.y + r.h + 4 &&
        (side === 'L' ? r.x < home.x : r.x + r.w > home.x + home.w),
    );
  for (const j of jobs) {
    const hr = j.home.rect;
    const hc = col(j.homeBand);
    if (col(j.band) !== hc) {
      // between the columns: out of the side of the home card that faces the other column
      j.side = hc === 0 ? 'R' : 'L';
      j.ey = hr.y + hr.h / 2;
      j.lane = 'M';
      continue;
    }
    const tries: ['L' | 'R', number][] = [];
    for (const y of [hr.y + hr.h / 2, hr.y + 10, hr.y + hr.h - 10]) tries.push(['L', y], ['R', y]);
    const pick = tries.find(([sd, y]) => clear(sd, y, hr, hc)) ?? tries[0]!;
    j.side = pick[0];
    j.ey = pick[1];
    j.lane =
      colsN === 1
        ? j.side === 'L'
          ? 'FL'
          : 'FR'
        : j.side === 'L'
          ? hc === 0
            ? 'FL'
            : 'M'
          : hc === 0
            ? 'M'
            : 'FR';
  }
  const laneStep = 8;
  const count = (l: Job['lane']): number => jobs.filter((j) => j.lane === l).length;
  const nL = count('FL');
  const nM = count('M');
  const nR = count('FR');
  const gl = nL ? 12 + laneStep * nL : 0;
  const c0 = bands.filter((_, bi) => col(bi) === 0);
  const c1 = bands.filter((_, bi) => col(bi) === 1);
  const w0 = bandW(c0);
  const w1 = bandW(c1);
  // make room for the gutters: column 0 moves right by the left one, column 1 beyond column 0 and the middle one
  const gm = colsN === 2 ? Math.max(24, 12 + laneStep * nM) : 0;
  const shift1 = gl + w0 + gm - 2 * M;
  bands.forEach((b, bi) => shiftPlan(b.plan, col(bi) === 0 ? gl : shift1, 0));
  const midLeft = gl + w0 - M;
  const right = colsN === 2 ? shift1 + w1 : gl + w0;
  const lanes = { FL: 0, M: 0, FR: 0 };
  for (const j of jobs) {
    const hr = j.home.rect;
    const k = lanes[j.lane]++;
    const lx =
      j.lane === 'FL'
        ? 6 + laneStep * k
        : j.lane === 'M'
          ? midLeft + 10 + laneStep * k
          : right + 10 + laneStep * k;
    const hx = j.side === 'L' ? hr.x : hr.x + hr.w;
    const w = j.wire;
    if (j.kind === 'in') {
      // drop beside the slot's first segment, in the empty space the moved card left
      const p0 = w.points[0]!;
      const p1 = w.points[1] ?? p0;
      const dx = p0[1] === p1[1] && p0[0] !== p1[0] ? (p0[0] + p1[0]) / 2 : p0[0];
      w.points = [
        [hx, j.ey],
        [lx, j.ey],
        [lx, j.gap],
        [dx, j.gap],
        [dx, p0[1]],
        ...w.points.slice(1),
      ];
    } else {
      const pl = w.points[w.points.length - 1]!;
      w.points = [...w.points, [pl[0], j.gap], [lx, j.gap], [lx, j.ey], [hx, j.ey]];
    }
    if (w.from !== j.home.key && j.kind === 'in') w.from = j.home.key;
    if (j.kind === 'out') w.to = j.home.key;
  }
  const gr = nR ? 12 + laneStep * nR : 0;
  const contentH = Math.max(...bands.map((b) => b.top + bandH(b)));
  // 5. the result
  const items = bands.flatMap((b) => b.plan.items);
  const wires = bands.flatMap((b) => b.plan.wires);
  const planCalls: PlanCall[] = [];
  const last = line.calls.length - 1;
  for (const b of bands)
    b.calls.forEach((k, j) => {
      const rect = b.nested ? b.plan.boxes?.[j] : b.plan.box;
      if (rect)
        planCalls.push({
          call: k,
          node: line.calls[k]!.stage.node,
          rect,
          nested: b.nested,
          current: k === last,
          ...(b.plan.calleeBox ? { calleeBox: true as const } : {}),
        });
    });
  const valuesAll = bands.flatMap((b) =>
    b.plan.values ? [{ ...b.plan.values, call: b.calls[0] }] : [],
  );
  const cur = planCalls.find((c) => c.current) ?? null;
  const p: StagePlan = {
    width: right + gr,
    height: contentH + 2 * M,
    box: cur ? cur.rect : null,
    items,
    wires,
    values: valuesAll[valuesAll.length - 1] ?? null,
    valuesAll,
    calls: planCalls,
    callLabels: bands.flatMap((b) => b.plan.callLabels ?? []),
  };
  if (bands.some((b) => b.plan.calleeBox)) p.calleeBox = true;
  if (cur?.nested) p.nested = true;
  return p;
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

export interface SetStepOptions {
  /**
   * Animate the cards from where they were to where they are now (FLIP, ~250ms, ease-out, transforms only).
   * Default false: snap. The caller decides: a single step (arrow keys, buttons) animates; slider drags,
   * jumps, event-list clicks and re-runs snap. `prefers-reduced-motion: reduce` always snaps.
   */
  animate?: boolean;
  /**
   * Called once the new step's cards are placed and before the animation measures where they land. The host
   * sets the stage zoom here, so the cards fly to their final, already zoomed places and nothing is re-fitted
   * mid-flight. Called for snapping steps too.
   */
  fit?: () => void;
}

/** Animation length in ms. */
export const MOVE_MS = 325;
/** z-index of a card in flight: above the stage, the shelf, other cards and the wires. */
export const FLY_Z = 1000;
/** Length of the wire and value fades that frame the two phases, in ms. */
const FADE_MS = 150;

export interface CardMove {
  key: string;
  /**
   * `move`: the card was visible and still is (shelf to stage and back); `enter`: it was not visible before;
   * `leave` (stepping back only): it was an output of the step being left and is not visible after it.
   */
  kind: 'move' | 'enter' | 'leave';
  /** Where the card was, relative to where it is now (the start of the transform). Zero for `enter`. */
  dx: number;
  dy: number;
  /**
   * Which phase of the step animation plays it (svl-aut). 1: cards that go back to the shelf and cards that stay
   * on the stage and take their new places. 2: cards that come onto the stage, from the shelf or from nowhere.
   * Stepping back needs no special case: what the later step used leaves in phase 1, what the earlier step used
   * returns in phase 2.
   * Phase 3 (svl-8rx, forward): the step's outputs and created objects, which come onto the stage after the inputs
   * have landed. Phase 0 (stepping back): the outputs of the step being left go first, before phase 1.
   */
  phase: 0 | 1 | 2 | 3;
}

export interface PlanMovesOptions {
  /** Each card's rectangle relative to the shelf (null for a card not in it), before and after. */
  before: ReadonlyMap<string, Rect | null>;
  after: ReadonlyMap<string, Rect | null>;
}

/**
 * Pure FLIP plan: from each card's rectangle before a step change and after it (null = not visible), which
 * cards move and from where. One function serves both directions: stepping back swaps before and after, so a
 * card that went shelf -> stage now goes stage -> shelf. Cards that disappear are not animated. `rel` holds
 * the rectangles relative to the shelf (null for a card not in it): a card whose place in the shelf did not
 * change is not animated, so a resizing stage does not slide the whole shelf.
 */
export function planMoves(
  before: ReadonlyMap<string, Rect | null>,
  after: ReadonlyMap<string, Rect | null>,
  rel?: PlanMovesOptions,
  /**
   * svl-8rx: the keys of the cards that are outputs or created objects of the later of the two steps, and the
   * direction. Forward, the ones that come onto the stage are phase 3 (after the inputs); in reverse, the ones
   * that leave it (to the shelf, or out of sight: kind `leave`) are phase 0 (before everything else).
   */
  outputs?: { keys: ReadonlySet<string>; reverse: boolean },
): CardMove[] {
  const out: CardMove[] = [];
  const outs = outputs?.keys;
  const rev = outputs?.reverse === true;
  if (rev && outs && rel)
    for (const [key, b] of before)
      if (b && outs.has(key) && !rel.before.get(key) && !after.get(key))
        out.push({ key, kind: 'leave', dx: 0, dy: 0, phase: 0 });
  for (const [key, a] of after) {
    if (!a) continue;
    const b = before.get(key);
    // a shelf card that kept its place within the shelf stays put, even if the shelf itself shifted
    const rb = rel?.before.get(key);
    const ra = rel?.after.get(key);
    if (b && rb && ra && Math.abs(rb.x - ra.x) < 1 && Math.abs(rb.y - ra.y) < 1) continue;
    // phase 2 only for a card that ends on the stage (not in the shelf) and was not on the stage before; without
    // `rel` a move is phase 1
    const toStage = !!rel && !ra;
    const fromStage = !!rel && !!b && !rb;
    const lateOut = !!outs && !rev && outs.has(key);
    const earlyOut = !!outs && rev && outs.has(key);
    if (!b) out.push({ key, kind: 'enter', dx: 0, dy: 0, phase: lateOut ? 3 : 2 });
    else if (
      Math.abs(b.x - a.x) >= 1 ||
      Math.abs(b.y - a.y) >= 1 ||
      Math.abs(b.w - a.w) >= 1 ||
      Math.abs(b.h - a.h) >= 1
    )
      out.push({
        key,
        kind: 'move',
        dx: b.x - a.x,
        dy: b.y - a.y,
        phase:
          toStage && !fromStage ? (lateOut ? 3 : 2) : earlyOut && fromStage && !toStage ? 0 : 1,
      });
  }
  return out;
}

/** Time the output wire takes to draw in the creation flourish, in ms (it starts a little before phase 3 ends). */
const DRAW_MS = 280;
/** How long the accent ring around a new card expands and fades, in ms. */
const RING_MS = 450;
/** How long the producing call box's press takes, in ms. */
const PRESS_MS = 220;

/**
 * svl-2db: which cards get the creation flourish (pop, ring, wire draw). Only cards that were not visible before
 * the step and arrive in phase 3 of a forward step: objects the step made. An output that was already on the shelf
 * (kind `move`) flies in plain, and stepping back has no flourish at all.
 */
export function planCreations(moves: readonly CardMove[], reverse: boolean): Set<string> {
  const keys = new Set<string>();
  if (reverse) return keys;
  for (const m of moves) if (m.kind === 'enter' && m.phase === 3) keys.add(m.key);
  return keys;
}

/** svl-jhe: a wire's identity across steps: its two cards and its graph edge (the owner line has none). */
export function wireId(w: Pick<PlanWire, 'from' | 'to' | 'edge'>, scope = ''): string {
  // a line's first call is `box` while it is alone on the stage and `box#0` once the group has more
  const k = (key: string): string => (key === 'box' ? 'box#0' : key);
  // the owner line has no edge: only the same line group (`scope`) can keep it
  return `${k(w.from)}>${k(w.to)}|${w.edge ?? `@${scope}`}`;
}

/**
 * svl-jhe: which wires of the step being left persist into the next one. `kept` wires stay drawn and steady,
 * `added` ones animate in, `removed` ones fade out. Order follows `next` (kept, added) and `prev` (removed).
 */
export function diffWires(
  prev: readonly PlanWire[],
  next: readonly PlanWire[],
  prevScope = '',
  nextScope = prevScope,
): { kept: PlanWire[]; added: PlanWire[]; removed: PlanWire[] } {
  const before = new Set(prev.map((w) => wireId(w, prevScope)));
  const after = new Set(next.map((w) => wireId(w, nextScope)));
  return {
    kept: next.filter((w) => before.has(wireId(w, nextScope))),
    added: next.filter((w) => !before.has(wireId(w, nextScope))),
    removed: prev.filter((w) => !after.has(wireId(w, prevScope))),
  };
}

export interface TwoPaneController {
  /** Show step `step` (clamped; NaN is 0). Snaps unless `opts.animate`. A running animation is finished first. */
  setStep(step: number, opts?: SetStepOptions): void;
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

/** Columns for an instance's method boxes: one while they are few, more so a card with many methods stays short. */
export function methodColumns(n: number): number {
  return n <= 4 ? 1 : Math.ceil(n / 4);
}
function pick<V>(rec: Record<string, V>, ids: ReadonlySet<string>): Record<string, V> {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => ids.has(k)));
}

const STAGEABLE = new Set<GNode['kind']>(['instance', 'import', 'def', 'call', 'expr', 'store']);
let uid = 0;

/** An instance card on the stage and the shelf shows at most this many attribute rows (the last may be "… N more"). */
export const MAX_CARD_ROWS = 6;
/**
 * svl-17v: compact cards. A card keeps `MAX_CARD_ROWS` rows at most; the full list is in the inspect panel. The box is
 * as wide as the widest row it can show, so the longest of the cut rows stands in for them.
 */
export function capAttrRows(
  rows: Record<string, string[]>,
  max = MAX_CARD_ROWS,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(rows).map(([id, r]) => {
      if (r.length <= max) return [id, r];
      const rest = r.slice(max - 1);
      const widest = rest.reduce((a, b) => (b.length > a.length ? b : a), '');
      return [id, [...r.slice(0, max - 1), widest]];
    }),
  );
}

export async function mountTwoPane(
  host: HTMLElement,
  model: GraphModel,
  log: EventLog,
  opts: TwoPaneOptions = {},
): Promise<TwoPaneController> {
  const doc = host.ownerDocument;
  const entries = shelfOrder(model, log);
  const entryOf = new Map<string, ShelfEntry>(entries.map((e) => [e.node, e]));
  // plain named values (svl-o6m): cards with no box in the graph; they are drawn here, not by the diagram code
  const valueOf = new Map<string, ValueCard>(
    entries.flatMap((e) => (e.value ? [[e.node, e.value] as [string, ValueCard]] : [])),
  );

  // one ELK run for the size (and ports) of every box; the wires are drawn by `planStage`, not by ELK
  const attrRows = capAttrRows(attrRowsFor(model, log));
  const synth: GraphModel = {
    nodes: model.nodes
      .filter((n) => STAGEABLE.has(n.kind) && n.kind !== 'instance')
      .map((n) => ({ ...n, parent: null }) as GNode),
    edges: [],
    steps: [],
  };
  const laidBoxes: Laid = await layout(synth, { attrRows, measure: opts.measure, elk: opts.elk });
  // Instance cards (svl-faf) are the full diagram's compound box: the instance with its method boxes inside
  // and the "more methods" row, laid out by the same code (`layout`, compact spacing). The method boxes
  // are stripped of their ports (no wires on the shelf) and chained top to bottom so they stack.
  const instIds = new Set(model.nodes.filter((n) => n.kind === 'instance').map((n) => n.id));
  const methodsOf = new Map<string, CallNode[]>();
  for (const n of model.nodes)
    if (n.kind === 'call' && n.parent !== null && instIds.has(n.parent)) {
      const l = methodsOf.get(n.parent);
      if (l) l.push(n);
      else methodsOf.set(n.parent, [n]);
    }
  const cardNodes: GNode[] = [];
  const cardEdges: GEdge[] = [];
  for (const n of model.nodes) {
    if (n.kind === 'instance') cardNodes.push(n);
    else if (n.kind === 'call' && n.parent !== null && instIds.has(n.parent))
      cardNodes.push({ ...n, inPorts: [], outPorts: [] });
  }
  for (const [inst, kids] of methodsOf) {
    const cols = methodColumns(kids.length);
    kids.forEach((k, i) => {
      if (i >= cols)
        cardEdges.push({
          id: `${inst}:stack:${i}`,
          from: { node: kids[i - cols]!.id, port: null },
          to: { node: k.id, port: null },
          dashed: false,
          uses: [],
          nameLabel: null,
        });
    });
  }
  const cardModel: GraphModel = { nodes: cardNodes, edges: [], steps: model.steps };
  const laidCards: Laid = await layout(
    { ...cardModel, edges: cardEdges },
    {
      attrRows,
      moreMethods: moreMethodsFor(model, log),
      measure: opts.measure,
      elk: opts.elk,
      compact: true,
    },
  );
  const laid: Laid = {
    ...laidBoxes,
    nodes: { ...laidBoxes.nodes, ...pick(laidCards.nodes, instIds) },
  };
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const visualSize = (id: string): Size => {
    const v = valueOf.get(id);
    if (v) return valueCardSize(v);
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
  const wiresSvg = sv(
    doc,
    'svg',
    { 'aria-hidden': 'true', tabindex: -1 },
    'md-diagram md-stage-wires',
  );
  const valuesEl = el(doc, 'div', 'md-stage-values');
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

  /** The names a value card shows are those holding the value at the step: `a, b = 1.43` (event null: the end of the run). */
  function paintValue(box: HTMLElement, value: ValueCard, event: number | null): void {
    const names = valueNames(value, event);
    const shown = valueCardText(value, names.length ? names : [value.name]);
    box.firstElementChild!.textContent = shown;
    box.title = `${shown}${value.type ? ` (${value.type})` : ''}${
      value.text !== null && reprTruncated(value.text) ? ', shortened' : ''
    }`;
    const label = `value ${shown}${value.type ? `, ${value.type}` : ''}`.replace(
      /\.\.\.|…/g,
      ' and more',
    );
    box.setAttribute('aria-label', label);
    box.dataset.label = label;
  }
  const cards = new Map<string, Card>();
  const makeCard = (key: string, node: string, object: string | null): Card => {
    const existing = cards.get(key);
    if (existing) return existing;
    const ln = laid.nodes[node];
    const wrap = el(doc, 'div', 'md-card');
    const value = valueOf.get(node);
    wrap.dataset.card = key;
    wrap.dataset.node = node;
    if (object !== null) wrap.dataset.object = object;
    let ctl: DiagramController | null = null;
    const size = visualSize(node);
    wrap.style.width = `${size.w + CARD_PAD.l + CARD_PAD.r}px`;
    wrap.style.height = `${size.h + CARD_PAD.t + CARD_PAD.b}px`;
    if (value) {
      // a plain value: a light box with `name = value`, solid outline (an instance's is a full card; a chip's is dashed)
      const box = el(doc, 'div', 'md-vcard');
      box.append(el(doc, 'span', 'md-vcard-text'));
      box.dataset.node = node;
      box.style.left = `${CARD_PAD.l}px`;
      box.style.top = `${CARD_PAD.t}px`;
      box.style.width = `${size.w}px`;
      box.style.height = `${size.h}px`;
      box.setAttribute('role', 'group');
      paintValue(box, value, null);
      wrap.append(box);
    } else if (ln) {
      const dx = CARD_PAD.l - ln.x;
      const dy = CARD_PAD.t - ln.y;
      const shift = (l: LaidNode): LaidNode => ({
        ...l,
        x: l.x + dx,
        y: l.y + dy,
        ports: Object.fromEntries(
          Object.entries(l.ports).map(([k, p]) => [k, { ...p, x: p.x + dx, y: p.y + dy }]),
        ),
      });
      const nodes: Record<string, LaidNode> = { [node]: shift(ln) };
      // an instance's method boxes sit inside it (their layout is relative to the instance, like the full view)
      for (const k of methodsOf.get(node) ?? [])
        if (laidCards.nodes[k.id]) nodes[k.id] = shift(laidCards.nodes[k.id]!);
      ctl = mount(wrap, mountOpts);
      ctl.setGraph(instIds.has(node) ? cardModel : model, {
        width: size.w + CARD_PAD.l + CARD_PAD.r,
        height: size.h + CARD_PAD.t + CARD_PAD.b,
        nodes,
        edges: {},
        labels: {},
        dropped: 0,
      });
    }
    // the card's focus target is its box (labelled per step in `setStep`); the svg itself is no landmark
    ctl?.svg?.removeAttribute('aria-label');
    ctl?.svg?.setAttribute('role', 'presentation');
    ctl?.svg?.setAttribute('tabindex', '-1'); // some browsers put an svg root in the Tab order
    // roving: see `rove`. Method boxes and the "more methods" button inside the card are reached from the
    // card's box with the arrow keys (see `innerKey`), not by Tab.
    for (const g of wrap.querySelectorAll('.md-node, .md-more-ctl'))
      g.setAttribute('tabindex', '-1');
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
    // svl-17v: a compact chip of one line, not a blank box the size of the card: `name · on the stage`. The card's
    // own padding still becomes its margin, so the shelf keeps its flow; the chip is as wide as its text needs.
    const label = e.value ? e.value.name : byId.get(e.node) ? slotLabel(byId.get(e.node)!) : e.node;
    const text = `${label} · on the stage`;
    ph.style.width = `${Math.ceil(text.length * 7.4) + 28}px`;
    ph.style.height = `${PH_MAX_H}px`;
    ph.style.margin = `${CARD_PAD.t}px ${CARD_PAD.r}px ${CARD_PAD.b}px ${CARD_PAD.l}px`;
    ph.append(
      el(doc, 'span', 'md-slot-ph-name', label),
      el(doc, 'span', 'md-slot-ph-text', 'on the stage'),
    );
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
  // the call boxes drawn as cards of their own (not the methods inside an owner's card), by card, with their rect
  let boxCards = new Map<Card, Rect>();
  let lineNow: LineStageModel | null = null;
  let onStage = new Map<string, { card: Card | null; item: PlanItem }>();
  let destroyed = false;

  /**
   * svl-a9e: a method call whose owner is an instance on the stage is drawn inside the owner's card (the
   * method box is already there, as in the full diagram). Null for every other step: functions,
   * constructors, a method on a temporary (a chip owner: the method is a top-level box with a `self` port) or
   * on a scalar, and a call whose owner was cut from the graph. The method box keeps its shelf size and has no
   * ports in the card (a port would change the card's size and break the shelf/stage FLIP); the wires end on
   * its left and right edges and carry the parameter names.
   */
  const nestedFor = (stage: StageModel): NestedBox | null => {
    const n = byId.get(stage.node);
    if (stage.kind !== 'call' || !n || n.kind !== 'call' || n.parent === null) return null;
    if (!instIds.has(n.parent)) return null;
    const own = stage.participants.find(
      (p) => p.kind === 'instance' && p.role === 'owner' && p.node === n.parent,
    );
    const m = laidCards.nodes[n.id];
    const o = laidCards.nodes[n.parent];
    if (!own || !m || !o) return null;
    return { rect: { x: m.x - o.x, y: m.y - o.y, w: m.w, h: m.h } };
  };
  const stageCardOf = (p: StageParticipant): Card | null => {
    if (p.kind === 'chip') return null;
    const e = entryOf.get(p.node);
    if (!e) return null;
    if (e.objects > 1 && p.object !== null)
      return makeCard(`${p.node}#${p.object}`, p.node, p.object);
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
    const label = p.chip
      ? `${p.chip.type}${p.chip.shape ? ` (${p.chip.shape.join(', ')})` : ''}`
      : '';
    return { w: Math.ceil(`temporary: ${label}`.length * 7.2) + 20, h: 26 };
  };

  // FLIP: running animations are cancelled when the next step starts. The DOM already holds the final state
  // (an animation only offsets it), so cancelling "finishes it instantly".
  let running: Animation[] = [];
  const restores: (() => void)[] = [];
  let wireKeys = new Set<string>(); // the wires drawn by the last step
  let drawnWires: PlanWire[] = []; // svl-jhe: the plan wires drawn by the last step
  let drawnScope = ''; // ... and the line group they belonged to
  const wireScope = (): string => lineNow?.calls[0]?.stage.node ?? '';
  const finishAnimations = (): void => {
    for (const a of running) a.cancel();
    running = [];
    for (const r of restores.splice(0)) r();
  };
  const reducedMotion = (): boolean =>
    doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const allCards = (): [string, HTMLElement][] => [
    ...[...cards].map(([k, c]) => [k, c.wrap] as [string, HTMLElement]),
    ...chipEls,
  ];
  const measureCards = (): { abs: Map<string, Rect | null>; rel: Map<string, Rect | null> } => {
    const abs = new Map<string, Rect | null>();
    const rel = new Map<string, Rect | null>();
    const sh = shelf.getBoundingClientRect();
    for (const [k, w] of allCards()) {
      rel.set(k, null);
      if (!w.isConnected || w.closest('[hidden]')) abs.set(k, null);
      else {
        const r = w.getBoundingClientRect();
        abs.set(k, { x: r.left, y: r.top, w: r.width, h: r.height });
        if (shelf.contains(w))
          rel.set(k, { x: r.left - sh.left, y: r.top - sh.top, w: r.width, h: r.height });
      }
    }
    return { abs, rel };
  };
  /**
   * The host's CSS zoom on the stage: lengths of anything inside it, a fixed card's `left`/`top` and its
   * transforms too, are in zoomed units. Cards on the shelf are outside it.
   */
  const zoomOf = (w: HTMLElement): number => {
    if (!canvas.contains(w)) return 1;
    const z = Number.parseFloat(doc.defaultView?.getComputedStyle(canvas).zoom ?? '1');
    return Number.isFinite(z) && z > 0 ? z : 1;
  };
  const play = (
    target: Element,
    frames: Keyframe[],
    lifted?: Rect | null,
    timing: { delay?: number; duration?: number } = {},
  ): void => {
    if (typeof target.animate !== 'function') return;
    const delay = timing.delay ?? 0;
    // a delayed animation holds its first frame while it waits (the later phase's cards stay where they were)
    const anim = target.animate(frames, {
      duration: timing.duration ?? MOVE_MS,
      easing: 'ease-out',
      ...(delay > 0 ? { delay, fill: 'backwards' as const } : {}),
    });
    running.push(anim);
    if (lifted && target instanceof HTMLElement) {
      const restore = lift(target, lifted, zoomOf(target));
      anim.onfinish = restore;
      restores.push(restore);
    }
  };
  // While a card flies it is drawn above everything: `position: fixed` at its final place (the stage clips
  // its overflow, so a card flying out of or into it would be cut) with a top z-index. A placeholder of the
  // same size keeps its shelf slot from collapsing. The restore puts the inline styles back exactly.
  const lift = (w: HTMLElement, at: Rect, zoom: number): (() => void) => {
    const keep = ['position', 'left', 'top', 'zIndex'].map(
      (k) => [k, w.style.getPropertyValue(k === 'zIndex' ? 'z-index' : k)] as const,
    );
    let ph: HTMLElement | null = null;
    if (w.parentElement?.classList.contains('md-slot')) {
      ph = el(doc, 'div', 'md-fly-ph');
      ph.setAttribute('aria-hidden', 'true');
      ph.style.width = w.style.width;
      ph.style.height = w.style.height;
      w.before(ph);
    }
    w.style.position = 'fixed';
    w.style.left = `${at.x / zoom}px`;
    w.style.top = `${at.y / zoom}px`;
    w.style.zIndex = String(FLY_Z);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      ph?.remove();
      for (const [k, v] of keep) {
        const prop = k === 'zIndex' ? 'z-index' : k;
        if (v) w.style.setProperty(prop, v);
        else w.style.removeProperty(prop);
      }
    };
  };

  /** The stage of the current call: the line group's current call, else the step's. */
  const currentStage = (): StageModel | null => {
    const pc = plan?.calls?.find((c) => c.current);
    return pc && lineNow ? (lineNow.calls[pc.call]?.stage ?? null) : stageAt(model, log, current);
  };
  /**
   * svl-8rx: the cards that are outputs or created objects of the current call (a line group: only the current
   * call's; earlier calls' outputs are on the stage already), by card key.
   */
  const outputKeys = (): Set<string> => {
    const keys = new Set<string>();
    const cur = plan?.calls?.find((c) => c.current);
    for (const it of plan?.items ?? [])
      if (
        (it.participant.role === 'output' || it.participant.role === 'created') &&
        (cur === undefined || it.call === undefined || it.call === cur.call)
      )
        keys.add(it.key);
    return keys;
  };
  /** The element that is the call box now: the callee's card, the method's box inside its owner, or the call's own card. */
  const callBoxEl = (): Element | null => {
    const sg = currentStage();
    if (!plan || !sg) return null;
    const cur = plan.calls?.find((c) => c.current);
    const node = cur ? cur.node : sg.node;
    const callee = cur ? cur.calleeBox === true : plan.calleeBox === true;
    const nested = cur ? cur.nested : plan.nested === true;
    if (callee) {
      for (const [k, v] of onStage)
        if (
          v.item.participant.role === 'callee' &&
          (cur === undefined || v.item.call === undefined || v.item.call === cur.call)
        )
          return (v.card?.wrap ?? chipEls.get(k)) || null;
      return null;
    }
    if (nested) {
      for (const g of canvas.querySelectorAll('.md-node'))
        if (g.getAttribute('data-node') === node) return g;
      return null;
    }
    for (const bc of boxCards.keys()) if (bc.node === node) return bc.wrap;
    return null;
  };
  const rectOf = (e: Element | null): Rect | null => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return r.width > 0 || r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  };

  function setStep(step: number, sopts: SetStepOptions = {}): void {
    if (destroyed) return;
    finishAnimations();
    const flip = sopts.animate === true && !reducedMotion();
    const before = flip ? measureCards() : null;
    // stepping back: what the step being left made, and where it came from, is read before the DOM changes
    const reverse = Number.isNaN(step) ? false : step < current;
    const left =
      before && reverse
        ? {
            outputs: outputKeys(),
            box: rectOf(callBoxEl()),
            clones: new Map<string, HTMLElement>(),
          }
        : null;
    if (left)
      for (const key of left.outputs) {
        const w = onStage.get(key)?.card?.wrap ?? chipEls.get(key);
        if (w && w.isConnected && !w.hidden) left.clones.set(key, w.cloneNode(true) as HTMLElement);
      }
    const total = model.steps.length;
    current = Number.isNaN(step) ? 0 : Math.max(0, Math.min(total, Math.trunc(step)));
    const st = stateAt(model, log, current);
    const stage = stageAt(model, log, current);
    const line = lineStageAt(model, log, current);
    lineNow = line;
    const onShelf = new Map(shelfAt(model, current, log).map((s) => [s.node, s]));
    const active = doc.activeElement;
    const hadFocus = active !== null && root.contains(active);

    // 1. the plan
    plan = null;
    onStage = new Map();
    if (stage) {
      const merged = (p: StageParticipant): boolean =>
        p.kind !== 'chip' && (entryOf.get(p.node)?.objects ?? 0) > 1;
      const sizeOf = (p: StageParticipant): Size =>
        p.kind === 'chip' ? chipSize(p) : visualSize(p.node); // a value card's size is `valueCardSize`
      const boxOf = (sg: StageModel, calleeOk = true): BoxSize | null => {
        if (!(
          (sg.kind === 'call' || sg.kind === 'expr' || sg.kind === 'store') &&
          laid.nodes[sg.node]
        ))
          return null;
        // svl-u3v: a call whose callee block is certain is drawn as that block's card, with the call's ports
        // on its top and bottom edges (spread evenly, as the call box spreads them) and its name beside it
        const cp = sg.participants.find(
          (p) => p.role === 'callee' && (p.kind === 'import' || p.kind === 'def'),
        );
        const cn = byId.get(sg.node);
        if (calleeOk && cp && cn?.kind === 'call' && laid.nodes[cp.node]) {
          const sz = visualSize(cp.node);
          const spread = (ids: string[]): Record<string, number> =>
            Object.fromEntries(ids.map((id, k) => [id, (sz.w * (k + 1)) / (ids.length + 1)]));
          return {
            ...sz,
            ports: {
              ...spread(cn.inPorts.map((q) => q.id)),
              ...spread(cn.outPorts.map((q) => q.id)),
            },
            callee: true,
            // the call's name, unless the card already says it (`train_test_split`, `LinearRegression`)
            ...((byId.get(cp.node) as { name?: string } | undefined)?.name !== cn.name
              ? { label: cn.name }
              : {}),
          };
        }
        return boxSize(sg.node);
      };
      // svl-qol: every call of the line that has run stays; a line of one call is laid out as before
      if (line && line.calls.length > 1)
        plan = planLine(line, sizeOf, boxOf, (sg) => nestedFor(sg), merged, log);
      if (!plan) {
        const inner = nestedFor(stage);
        plan = planStage(stage, sizeOf, inner ? null : boxOf(stage), merged, log, inner);
      }
      for (const it of plan.items)
        onStage.set(it.key, { card: stageCardOf(it.participant), item: it });
    }
    // a method drawn inside its owner's card has no card of its own
    boxCards = new Map();
    if (plan && stage) {
      if (plan.calls) {
        for (const pc of plan.calls)
          if (!pc.nested && !pc.calleeBox) boxCards.set(makeCard(pc.node, pc.node, null), pc.rect);
      } else if (plan.box && !plan.nested && !plan.calleeBox)
        boxCards.set(makeCard(stage.node, stage.node, null), plan.box);
    }
    canvas.classList.toggle(
      'md-nested',
      plan?.nested === true || plan?.calls?.some((c) => c.nested) === true,
    );
    /** The call that made a nested method box show (for its accessible name): the group's, else the step's. */
    const callOf = new Map<string, { stage: StageModel; current: boolean }>();
    if (line && plan?.calls)
      for (const pc of plan.calls)
        if (pc.nested)
          callOf.set(pc.node, { stage: line.calls[pc.call]!.stage, current: pc.current });
    if (stage && plan?.nested && !plan.calls) callOf.set(stage.node, { stage, current: true });

    // 2. put every element where it belongs
    for (const slot of slots.values()) {
      const e = slot.entry;
      const shown = onShelf.get(e.node);
      const here = onStage.get(e.node); // a single-object card on the stage leaves its slot
      slot.el.hidden = !shown;
      slot.ph.hidden = !(shown && here);
      slot.el.dataset.state = shown ? (here ? 'stage' : 'shelf') : 'hidden';
      if (!here) {
        // back from the stage: drop the stage offset (`place`), or the card is drawn away from its slot
        const s = slot.card.wrap.style;
        s.removeProperty('position');
        s.removeProperty('left');
        s.removeProperty('top');
        slot.el.prepend(slot.card.wrap);
      } else if (slot.card.wrap.parentElement === slot.el) slot.card.wrap.remove();
      const n = byId.get(e.node);
      const inUse = [...onStage.values()].some(
        (s) => s.card?.node === e.node && s.card.object !== null,
      );
      if (shown && n?.kind === 'instance' && e.objects > 1) {
        slot.cap.hidden = false;
        slot.cap.textContent =
          (shown.filled >= e.objects
            ? `${e.objects} objects`
            : `${shown.filled} of ${e.objects} objects`) + (inUse ? ' (one is on the stage)' : '');
      } else slot.cap.hidden = true;
    }
    for (const c of cards.values()) c.wrap.classList.remove('md-on-stage', 'md-past');
    for (const [key, c] of chipEls) if (!onStage.has(key)) c.remove();
    // svl-17v: what an earlier call of the line made or used, and the current call does not, is de-emphasised
    const curCallNow = plan?.calls?.find((pc) => pc.current);
    const curKeys = new Set(
      (stage?.participants ?? []).map((p) =>
        cardKey(p, p.kind !== 'chip' && (entryOf.get(p.node)?.objects ?? 0) > 1),
      ),
    );
    for (const c of chipEls.values()) c.classList.remove('md-past');
    for (const [key, s] of onStage) {
      const wrap = s.card ? s.card.wrap : chipEl(key, s.item.participant);
      canvas.append(wrap);
      wrap.classList.add('md-on-stage');
      wrap.classList.toggle(
        'md-past',
        curCallNow !== undefined &&
          s.item.call !== undefined &&
          s.item.call < curCallNow.call &&
          !curKeys.has(key),
      );
      place(wrap, s.item.rect, s.card !== null);
    }
    for (const [bc, rect] of boxCards) {
      canvas.append(bc.wrap);
      bc.wrap.classList.add('md-on-stage');
      bc.wrap.classList.toggle(
        'md-past',
        plan?.calls?.some((pc) => pc.node === bc.node && !pc.current) === true,
      );
      place(bc.wrap, rect, true);
    }

    // 3. wires, values, notes
    // the wires of the step being left fade out (see `flyCards`); `drawWires` replaces them
    const oldWires = before ? [...wiresSvg.querySelectorAll('[data-wire]')] : [];
    const prevWires = drawnWires;
    const drawnScopeBefore = drawnScope;
    drawWires();
    // svl-jhe: wires on both stages stay visible and steady; only the others animate
    const keptIds = new Set(
      before
        ? diffWires(prevWires, plan?.wires ?? [], drawnScopeBefore, wireScope()).kept.map((w) =>
            wireId(w, wireScope()),
          )
        : [],
    );
    drawValues(stage);
    drawLabels();
    stageEmpty.hidden = stage !== null;
    canvas.hidden = stage === null;
    notes(stage);

    // 4. card state
    const curCall = plan?.calls?.find((pc) => pc.current);
    const currentCallee =
      plan?.calleeBox && (!plan.calls || curCall?.calleeBox)
        ? (stage?.participants.find((p) => p.role === 'callee')?.node ?? null)
        : null;
    const stageIds = new Set<string>();
    if (stage) {
      for (const s of onStage.values()) if (s.card) stageIds.add(s.card.node);
      for (const bc of boxCards.keys()) stageIds.add(bc.node);
    }
    const owns = new Set<string>();
    for (const p of stage?.participants ?? [])
      if (p.changed && p.kind === 'instance') owns.add(p.node);
    for (const c of cards.values()) {
      const stageCard = [...onStage.values()].find((s) => s.card === c);
      const isBox = boxCards.has(c) && !stageCard;
      const visible = new Set<string>();
      let objectBadge = new Map<string, { k: number; n: number }>();
      const versionOf = new Map<string, Token>();
      if (stageCard) {
        visible.add(c.node);
        // the version after the line's latest call that used the object
        let p = stageCard.item.participant;
        for (const lc of line?.calls ?? [])
          for (const q of lc.stage.participants)
            if (
              q.kind === 'instance' &&
              q.node === p.node &&
              q.object === p.object &&
              (q.after ?? q.token)
            )
              p = q;
        const tok = p.after ?? p.token;
        if (tok) versionOf.set(c.node, tok);
        if (p.objectOf) objectBadge = new Map([[c.node, p.objectOf]]);
      } else if (isBox) visible.add(c.node);
      else if (c.object === null && onShelf.has(c.node) && !onStage.has(c.node))
        visible.add(c.node);
      // the method boxes drawn in the instance, as in the full diagram: shown from its creation on, with the
      // "not called yet" cue until their first call (`visibleNodes` says which, at this step)
      if (visible.has(c.node))
        for (const k of methodsOf.get(c.node) ?? [])
          if (st.visibleNodes.has(k.id)) visible.add(k.id);
      const state: StepState = {
        ...st,
        visibleNodes: visible,
        objectBadge,
        // the callee's card is the call box: it carries the highlight of the current call
        ...(stageCard && c.node === currentCallee ? { currentNode: c.node } : {}),
      };
      c.ctl?.setState(state, log, { owns, versionOf });
      // a method drawn as a call box of its own (the fallback of a line, or a method whose owner is not on the
      // stage) is the current call there: its box inside the owner's card is shown as called, not current
      for (const bc of boxCards.keys()) {
        if (bc === c) continue;
        for (const g of c.wrap.querySelectorAll(`.md-node[data-node="${bc.node}"]`)) {
          g.classList.remove('md-current');
          g.removeAttribute('aria-current');
          for (const e of g.querySelectorAll('.md-current')) e.classList.remove('md-current');
          const l = g.getAttribute('aria-label');
          if (l) g.setAttribute('aria-label', l.replace(/, current step$/, ''));
        }
      }
      c.wrap.hidden = visible.size === 0;
      // unique accessible names: what the card is and what it does on this line (the wires are not read out)
      const g = focusOf(c.wrap);
      // a value card's name is fixed text, not redrawn by `setState`: start from it again, or the suffixes pile up
      const vc = valueOf.get(c.node);
      if (g && vc)
        paintValue(g, vc, current === 0 || current === total ? null : model.steps[current - 1]!);
      else if (g?.dataset.label !== undefined) g.setAttribute('aria-label', g.dataset.label);
      if (g && !c.wrap.hidden) {
        const suffix = stageCard ? suffixOf(stageCard.item) : isBox ? boxSuffix(c) : 'on the shelf';
        const base = g.getAttribute('aria-label') ?? '';
        g.setAttribute('aria-label', `${base}, ${suffix}`);
        // a method box names the instance it belongs to (two cards can both have a `fit`)
        for (const m of innerMethods(c.wrap)) {
          let label = m.getAttribute('aria-label') ?? '';
          const call = stageCard ? callOf.get(m.getAttribute('data-node') ?? '') : undefined;
          if (call) {
            // a method of this line: what it was given, as the call box used to say
            const given = [
              ...call.stage.participants.filter((q) => q.role === 'input').map((q) => q.param),
              ...call.stage.values.filter((v) => v.role === 'input').map((v) => v.param),
            ].filter((x): x is string => !!x);
            label =
              label.replace(/, current step$/, '') +
              (call.current ? ', current call' : ', earlier call on this line') +
              (given.length ? `, inputs ${given.join(', ')}` : '');
          }
          m.setAttribute('aria-label', `${label}, in ${base}`);
        }
        // I selects the card (the app opens the attribute panel); Enter still dives into its rows
        const keys = (g.getAttribute('aria-keyshortcuts') ?? '').split(' ').filter(Boolean);
        if (!keys.includes('I')) g.setAttribute('aria-keyshortcuts', [...keys, 'I'].join(' '));
      }
    }
    for (const [key, chip] of chipEls) {
      const it = onStage.get(key);
      if (it && !chip.hidden)
        chip.setAttribute(
          'aria-label',
          `${chip.getAttribute('aria-label') ?? ''}, ${suffixOf(it.item)}`,
        );
    }
    rove();
    // the host zooms the stage to this step's plan now, so the landing places measured below are final
    sopts.fit?.();
    if (before) flyCards(before, oldWires, left, keptIds);
    // a card that was re-parented loses focus: it keeps it, wherever it went
    if (
      hadFocus &&
      (active instanceof HTMLElement || active instanceof SVGElement) && // a card's box is an svg <g>
      active.isConnected &&
      doc.activeElement !== active
    )
      active.focus({ preventScroll: true });
    if (hadFocus && active instanceof HTMLElement && active.isConnected === false) {
      const again = root.querySelector('[tabindex="0"]');
      if (again instanceof HTMLElement && !root.contains(doc.activeElement)) again.focus();
    }
  }

  /**
   * The step animation, from the measured `before` to the DOM as it is now (already zoomed). Phases of MOVE_MS
   * each (svl-aut, svl-8rx), forward: 1) cards the step does not use go back to the shelf, the ones that stay on the
   * stage take their new places, and the old wires fade out; 2) the cards the step needs come onto the stage and
   * the input wires appear; 3) the step's outputs and created objects emerge from the call box (or fly in from the
   * shelf) and the output wires and values appear. Stepping back (`left`) mirrors it: 0) the outputs of the step
   * being left go back into the call box and off (or to the shelf), then phases 1 and 2 as before, and the wires
   * fade in last. A phase with nothing in it is skipped. Later phases are the same animation with a delay (it holds
   * its first frame while it waits), so cancelling any animation finishes everything: the DOM already holds the
   * final state.
   */
  function flyCards(
    before: { abs: Map<string, Rect | null>; rel: Map<string, Rect | null> },
    oldWires: Element[],
    left: { outputs: Set<string>; box: Rect | null; clones: Map<string, HTMLElement> } | null,
    keptIds: ReadonlySet<string>,
  ): void {
    const byKey = new Map(allCards());
    const after = measureCards();
    const reverse = left !== null;
    const outs = left ? left.outputs : outputKeys();
    const moves = planMoves(
      before.abs,
      after.abs,
      { before: before.rel, after: after.rel },
      { keys: outs, reverse },
    );
    const fresh = planCreations(moves, reverse);
    const present = [0, 1, 2, 3].map((n) => moves.some((m) => m.phase === n));
    // the delay of a phase: one MOVE_MS for every earlier phase that has something in it
    const slotOf = (n: number): number => present.slice(0, n).filter(Boolean).length * MOVE_MS;
    const callEl = left ? null : callBoxEl();
    const callBox = left ? left.box : rectOf(callEl);
    const centre = (r: Rect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];
    for (const mv of moves) {
      const timing = { delay: slotOf(mv.phase) };
      if (mv.kind === 'leave') {
        // an output of the step being left that is gone in the earlier one: its picture shrinks into the call box
        const b = before.abs.get(mv.key);
        const ghost = left?.clones.get(mv.key);
        if (!b || !ghost || canvas.hidden) continue;
        const k = zoomOf(canvas);
        ghost.removeAttribute('data-card');
        ghost.hidden = false;
        ghost.setAttribute('aria-hidden', 'true');
        ghost.setAttribute('inert', '');
        ghost.style.pointerEvents = 'none';
        canvas.append(ghost);
        const [bx, by] = centre(b);
        const [tx, ty] = callBox ? centre(callBox) : [bx, by + 8];
        const undo = lift(ghost, b, k);
        const remove = (): void => {
          undo();
          ghost.remove();
        };
        restores.push(remove);
        if (typeof ghost.animate === 'function') {
          const anim = ghost.animate(
            [
              { opacity: 1, transform: 'none' },
              {
                opacity: 0,
                transform: `translate(${(tx - bx) / k}px, ${(ty - by) / k}px) scale(0.3)`,
              },
            ],
            {
              duration: MOVE_MS,
              easing: 'ease-in',
              fill: 'forwards',
              ...(timing.delay > 0 ? { delay: timing.delay } : {}),
            },
          );
          running.push(anim);
          anim.onfinish = remove;
        } else remove();
        continue;
      }
      const w = byKey.get(mv.key);
      if (!w) continue;
      if (mv.kind === 'move') {
        const b = before.abs.get(mv.key)!;
        const a = after.abs.get(mv.key)!;
        // viewport px -> the card's own (zoomed) units; a card that changes size (the stage zoom changed)
        // grows or shrinks along the way instead of popping
        const k = zoomOf(w);
        const sx = a.w > 0 ? b.w / a.w : 1;
        const sy = a.h > 0 ? b.h / a.h : 1;
        const scaled = Math.abs(sx - 1) > 0.005 || Math.abs(sy - 1) > 0.005;
        const origin = scaled ? { transformOrigin: '0 0' } : {};
        play(
          w,
          [
            {
              transform: `translate(${mv.dx / k}px, ${mv.dy / k}px)${scaled ? ` scale(${sx}, ${sy})` : ''}`,
              ...origin,
            },
            { transform: 'none', ...origin },
          ],
          a,
          timing,
        );
      } else {
        const a = after.abs.get(mv.key);
        // an output (phase 3) emerges from the call box; any other card fades in from below
        let from = 'translateY(8px)';
        if (mv.phase === 3 && callBox && a) {
          const k = zoomOf(w);
          const [cx, cy] = centre(a);
          const [bx, by] = centre(callBox);
          from = `translate(${(bx - cx) / k}px, ${(by - cy) / k}px) scale(0.3)`;
        }
        const pop = fresh.has(mv.key);
        play(
          w,
          pop
            ? [
                { opacity: 0, transform: from, offset: 0 },
                { opacity: 1, transform: 'scale(1.06)', offset: 0.75 },
                { opacity: 1, transform: 'none', offset: 1 },
              ]
            : [
                { opacity: 0, transform: from },
                { opacity: 1, transform: 'none' },
              ],
          a,
          timing,
        );
        if (pop && typeof w.animate === 'function') {
          // a soft accent ring expands and fades once the card has landed (a box-shadow: it is not part of the
          // card's layout, and no state is left behind)
          // the ring follows the card's corner radius (its box's `rx`)
          const rx = Number.parseFloat(
            w.querySelector('rect.md-box[rx]')?.getAttribute('rx') ?? '',
          );
          const borderRadius = `${Number.isFinite(rx) ? rx * zoomOf(w) : 10}px`;
          running.push(
            w.animate(
              [
                {
                  borderRadius,
                  boxShadow: '0 0 0 0 color-mix(in srgb, var(--md-focus) 55%, transparent)',
                },
                {
                  borderRadius,
                  boxShadow: '0 0 0 9px color-mix(in srgb, var(--md-focus) 0%, transparent)',
                },
              ],
              {
                duration: RING_MS,
                easing: 'ease-out',
                delay: timing.delay + MOVE_MS,
                fill: 'backwards',
              },
            ),
          );
        }
      }
    }
    // the producing call box gives a short press as the outputs come out
    if (fresh.size > 0 && callEl && typeof callEl.animate === 'function') {
      // an SVG box scales about its own centre
      if (callEl instanceof SVGElement) {
        const box = callEl;
        const keepBox = box.style.transformBox;
        const keepOrigin = box.style.transformOrigin;
        box.style.transformBox = 'fill-box';
        box.style.transformOrigin = 'center';
        restores.push(() => {
          box.style.transformBox = keepBox;
          box.style.transformOrigin = keepOrigin;
          if (box.getAttribute('style') === '') box.removeAttribute('style');
        });
      }
      running.push(
        callEl.animate(
          [
            { transform: 'scale(1)' },
            { transform: 'scale(0.96)', offset: 0.4 },
            { transform: 'scale(1)' },
          ],
          { duration: PRESS_MS, easing: 'ease-out', delay: slotOf(3) },
        ),
      );
    }
    // the old wires fade out at the start (a ghost layer, so they are not hit-tested or read), the new wires and
    // values fade in once the cards have landed
    // a kept wire whose cards moved keeps its old drawing (opacity 1) until the cards have landed, then the new
    // drawing takes over with no dip; the new one is hidden meanwhile. One that did not move is left alone.
    const newById = new Map<string, Element[]>();
    for (const e of wiresSvg.querySelectorAll('[data-wid]')) {
      const id = e.getAttribute('data-wid') ?? '';
      newById.set(id, [...(newById.get(id) ?? []), e]);
    }
    const swapAt = slotOf(2);
    const drawing = (e: Element): string =>
      `${e.querySelector('path.md-wire')?.getAttribute('d') ?? ''}|${e.getAttribute('x') ?? ''}|${e.getAttribute('y') ?? ''}`;
    const steady = new Set<Element>(); // new drawings that must not fade in
    const oldKept: { e: Element; dx: number; dy: number; slide: boolean }[] = [];
    const nums = (d: string): number[] => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    const shape = (d: string): string => d.replace(/-?\d*\.?\d+/g, '#');
    /** How the new drawing differs from the old: a pure shift (the held drawing can slide along) or a reshape. */
    const offset = (a: Element, b: Element): { dx: number; dy: number; slide: boolean } => {
      const da = a.querySelector('path.md-wire')?.getAttribute('d');
      const db = b.querySelector('path.md-wire')?.getAttribute('d');
      if (da == null || db == null) {
        const dx = Number(b.getAttribute('x')) - Number(a.getAttribute('x'));
        const dy = Number(b.getAttribute('y')) - Number(a.getAttribute('y'));
        return { dx, dy, slide: true };
      }
      const na = nums(da);
      const nb = nums(db);
      if (shape(da) !== shape(db) || na.length !== nb.length) return { dx: 0, dy: 0, slide: false };
      const dx = nb[0]! - na[0]!;
      const dy = nb[1]! - na[1]!;
      const same = na.every((v, i) => Math.abs(nb[i]! - v - (i % 2 === 0 ? dx : dy)) < 0.5);
      return { dx, dy, slide: same };
    };
    const oldGone: Element[] = [];
    for (const e of oldWires) {
      const id = e.getAttribute('data-wid') ?? '';
      const twin = keptIds.has(id)
        ? (newById.get(id) ?? []).find((n) => n.tagName === e.tagName && !steady.has(n))
        : undefined;
      if (!twin) {
        oldGone.push(e);
        continue;
      }
      steady.add(twin);
      if (swapAt > 0 && drawing(e) !== drawing(twin)) {
        oldKept.push({ e, ...offset(e, twin) });
        if (typeof twin.animate === 'function')
          running.push(
            twin.animate([{ opacity: 0 }, { opacity: 0 }], {
              duration: swapAt,
              easing: 'step-end',
            }),
          );
      }
    }
    if (oldKept.length > 0) {
      const hold = sv(doc, 'g', { 'aria-hidden': 'true', 'pointer-events': 'none' });
      const moveAt = slotOf(1);
      for (const { e, dx, dy, slide } of oldKept) {
        e.removeAttribute('data-wire');
        e.removeAttribute('data-wid');
        e.removeAttribute('data-edge');
        // a shifted wire slides with its cards (same timing as a card's move); a reshaped one is hidden while
        // they move and the new drawing shows at the swap
        const wrap = sv(doc, 'g');
        wrap.append(e);
        hold.append(wrap);
        if (typeof wrap.animate !== 'function') continue;
        if (slide) {
          if (moveAt < swapAt)
            running.push(
              wrap.animate(
                [
                  { transform: 'translate(0px, 0px)' },
                  { transform: `translate(${dx}px, ${dy}px)` },
                ],
                { duration: swapAt - moveAt, delay: moveAt, easing: 'ease-out', fill: 'both' },
              ),
            );
        } else if (moveAt < swapAt)
          running.push(
            wrap.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: swapAt - moveAt,
              delay: moveAt,
              easing: 'step-start',
              fill: 'both',
            }),
          );
      }
      wiresSvg.append(hold);
      const gone = (): void => hold.remove();
      restores.push(gone);
      if (typeof hold.animate === 'function') {
        const anim = hold.animate([{ opacity: 1 }, { opacity: 1 }], { duration: swapAt });
        running.push(anim);
        anim.onfinish = gone;
      } else gone();
    }
    if (oldGone.length > 0) {
      const ghost = sv(doc, 'g', { 'aria-hidden': 'true', 'pointer-events': 'none' });
      for (const e of oldGone) {
        e.removeAttribute('data-wid');
        e.removeAttribute('data-wire');
        e.removeAttribute('data-edge');
        ghost.append(e);
      }
      wiresSvg.append(ghost);
      const gone = (): void => ghost.remove();
      restores.push(gone);
      if (typeof ghost.animate === 'function') {
        const anim = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: FADE_MS,
          easing: 'ease-out',
          fill: 'forwards',
        });
        running.push(anim);
        anim.onfinish = gone;
      } else gone();
    }
    // forward: the input wires appear when phase 2 ends, the output wires and values when phase 3 ends (the
    // call's inputs, then its outputs); stepping back: everything when the last phase ends
    const inputAt = slotOf(3);
    const outputAt = reverse ? inputAt : slotOf(4);
    const cs = currentStage();
    const outEdges = new Set<string>();
    for (const p of cs?.participants ?? [])
      if ((p.role === 'output' || p.role === 'created') && p.edge) outEdges.add(p.edge);
    for (const v of cs?.values ?? []) if (v.role === 'output' && v.edge) outEdges.add(v.edge);
    const edgeOf = new Map((plan?.wires ?? []).map((w) => [`${w.from}>${w.to}`, w.edge]));
    const targetOf = new Map((plan?.wires ?? []).map((w) => [`${w.from}>${w.to}`, w.to]));
    const appear = [{ opacity: 0 }, { opacity: 1 }];
    for (const e of wiresSvg.querySelectorAll('[data-wire]')) {
      if (steady.has(e)) continue;
      const edge = edgeOf.get(e.getAttribute('data-wire') ?? '');
      const isOut = edge !== undefined && edge !== null && outEdges.has(edge);
      const path = e.querySelector('path.md-wire');
      // only a wire into a card the step created draws; one into an output that flew in from the shelf fades
      const toFresh = fresh.has(targetOf.get(e.getAttribute('data-wire') ?? '') ?? '');
      if (
        toFresh &&
        isOut &&
        path &&
        !e.classList.contains('md-owner-line') &&
        typeof path.animate === 'function'
      ) {
        // the output wire draws from the call to the new card as the card settles; the group (with its
        // arrowhead) shows only near the end of the draw
        path.setAttribute('pathLength', '1');
        const at = Math.max(0, outputAt - 120);
        const draw = path.animate(
          [
            { strokeDasharray: '1 1', strokeDashoffset: 1 },
            { strokeDasharray: '1 1', strokeDashoffset: 0 },
          ],
          { duration: DRAW_MS, easing: 'ease-out', delay: at, fill: 'backwards' },
        );
        running.push(draw);
        const settle = (): void => path.removeAttribute('pathLength');
        draw.onfinish = settle;
        restores.push(settle);
        play(e, [{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], null, {
          delay: at,
          duration: DRAW_MS,
        });
        continue;
      }
      play(e, appear, null, { delay: isOut ? outputAt : inputAt, duration: FADE_MS });
    }
    // the inline values sit in one block: with the outputs when the call has any, else with the inputs
    const valuesAt = (cs?.values ?? []).some((v) => v.role === 'output') ? outputAt : inputAt;
    if (!valuesEl.hidden) play(valuesEl, appear, null, { delay: valuesAt, duration: FADE_MS });
  }

  // the card's own box: an instance card also holds its method boxes, which are separate `.md-node`s
  const focusOf = (wrap: HTMLElement): HTMLElement | null =>
    wrap.matches('.md-chipcard')
      ? wrap
      : wrap.dataset.node !== undefined && valueOf.has(wrap.dataset.node)
        ? wrap.querySelector<HTMLElement>('.md-vcard')
        : ([...wrap.querySelectorAll<HTMLElement>('.md-node')].find(
            (g) => g.getAttribute('data-node') === wrap.dataset.node,
          ) ?? null);
  const innerMethods = (wrap: HTMLElement): HTMLElement[] => {
    const own = wrap.dataset.node;
    return [...wrap.querySelectorAll<HTMLElement>('.md-node')].filter(
      (g) => g.getAttribute('data-node') !== own && !g.classList.contains('md-hidden'),
    );
  };
  /** What the arrow keys visit inside a card, in order: attribute rows, method boxes, the "more methods" button. */
  const innerItems = (wrap: HTMLElement): HTMLElement[] => {
    const box = focusOf(wrap);
    const rows = box
      ? [...box.querySelectorAll<HTMLElement>('[data-doc-attr]')].filter(
          (r) => !r.classList.contains('md-hidden'),
        )
      : [];
    const more = wrap.querySelector<HTMLElement>('.md-more:not(.md-hidden) .md-more-ctl');
    return [...rows, ...innerMethods(wrap), ...(more ? [more] : [])];
  };
  /** ArrowDown/Up walk the card's rows, methods and "more" button; Escape and I from inside. True if handled. */
  const innerKey = (k: KeyboardEvent, wrap: HTMLElement): boolean => {
    const box = focusOf(wrap);
    const t = k.target as HTMLElement;
    if (!box) return false;
    const items = innerItems(wrap);
    const cur = t === box ? -1 : items.indexOf(t);
    if (t !== box && cur < 0) return false; // somewhere else in the card (an open list): mount.ts handles it
    let to: HTMLElement | undefined;
    if (k.key === 'ArrowDown') to = items[Math.min(cur + 1, items.length - 1)];
    else if (k.key === 'ArrowUp') to = cur < 0 ? undefined : cur === 0 ? box : items[cur - 1];
    else if (k.key === 'Escape') to = cur >= 0 ? box : undefined;
    else if ((k.key === 'i' || k.key === 'I') && cur >= 0) {
      const node = t.closest('[data-node]')?.getAttribute('data-node');
      if (!node) return false;
      k.preventDefault();
      k.stopPropagation();
      opts.onSelectNode?.(node);
      return true;
    }
    if (!to) return false;
    k.preventDefault();
    k.stopPropagation();
    to.focus();
    return true;
  };

  /** The stage of the call whose participant a card shows (the current step's, for a single call). */
  function stageOf(it: PlanItem): StageModel | null {
    const c = it.call !== undefined ? lineNow?.calls[it.call] : undefined;
    return c ? c.stage : stageAt(model, log, current);
  }
  /** A call box's role: the line's current call, or an earlier call of the same line. */
  function boxSuffix(c: Card): string {
    const n = lineNow?.calls.length ?? 1;
    if (n < 2) return 'current line';
    const k = lineNow!.calls.findIndex((lc) => lc.stage.node === c.node);
    return k === n - 1 ? 'current call' : `earlier call ${k + 1} of ${n} on this line`;
  }
  /** A card's role on the stage; in a line of several calls also which call it belongs to (names must differ). */
  function suffixOf(it: PlanItem): string {
    const n = lineNow?.calls.length ?? 1;
    const base = roleSuffix(it.participant, stageOf(it));
    return n > 1 && it.call !== undefined ? `${base}, call ${it.call + 1} of ${n}` : base;
  }
  function roleSuffix(p: StageParticipant, stage: StageModel | null): string {
    const n = stage ? byId.get(stage.node) : undefined;
    const what =
      !n || n.kind === 'instance'
        ? null
        : n.kind === 'call'
          ? n.name
          : n.kind === 'import'
            ? `import ${n.name}`
            : n.kind === 'def'
              ? `${n.defKind === 'class' ? 'class' : 'def'} ${n.name}`
              : n.kind === 'expr' || n.kind === 'store'
                ? n.text
                : null;
    switch (p.role) {
      case 'input':
        return p.param ? `input to ${p.param}` : 'input';
      case 'owner':
        return what ? `owner of ${what}` : 'changed on this line';
      case 'callee':
        return what ? `the call of ${what}` : 'called on this line';
      case 'output':
        return what ? `output of ${what}` : 'output';
      case 'created':
        return what ? `created by ${what}` : 'created on this line';
    }
  }

  // Roving tabindex (one Tab stop for the shelf, one for the stage); arrows move between cards.
  const active: Record<'shelf' | 'stage', HTMLElement | null> = { shelf: null, stage: null };
  function members(region: 'shelf' | 'stage'): HTMLElement[] {
    const out: HTMLElement[] = [];
    const add = (w: HTMLElement | undefined): void => {
      const f = w && !w.hidden ? focusOf(w) : null;
      if (f) out.push(f);
    };
    if (region === 'shelf') {
      for (const slot of slots.values())
        if (!slot.el.hidden && slot.card.wrap.parentElement === slot.el) add(slot.card.wrap);
    } else if (plan) {
      const by = (r: (x: StageParticipant) => boolean): void => {
        for (const it of plan!.items)
          if (r(it.participant))
            add(it.participant.kind === 'chip' ? chipEls.get(it.key) : cards.get(it.key)?.wrap);
      };
      by((p) => p.role === 'input');
      by((p) => p.role === 'owner' || p.role === 'callee');
      for (const bc of boxCards.keys()) add(bc.wrap);
      by((p) => p.role === 'output' || p.role === 'created');
    }
    return out;
  }
  function rove(): void {
    for (const c of cards.values()) focusOf(c.wrap)?.setAttribute('tabindex', '-1');
    for (const c of chipEls.values()) c.setAttribute('tabindex', '-1');
    for (const region of ['shelf', 'stage'] as const) {
      const m = members(region);
      if (region === 'shelf')
        // two unnamed objects of one class would read the same: add the position
        m.forEach((f, k) =>
          f.setAttribute(
            'aria-label',
            `${f.getAttribute('aria-label') ?? ''}, ${k + 1} of ${m.length}`,
          ),
        );
      const keep = active[region];
      active[region] = keep && m.includes(keep) ? keep : (m[0] ?? null);
      active[region]?.setAttribute('tabindex', '0');
    }
  }
  const regionOf = (t: Element): 'shelf' | 'stage' | null =>
    t.closest('.md-shelf') ? 'shelf' : t.closest('.md-stage-canvas') ? 'stage' : null;
  const onFocusIn = (ev: Event): void => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const region = regionOf(t);
    const card = t.closest('.md-card, .md-chipcard');
    if (!region || !card) return;
    const f = focusOf(card as HTMLElement);
    if (!f || f === active[region]) return;
    active[region]?.setAttribute('tabindex', '-1');
    active[region] = f;
    f.setAttribute('tabindex', '0');
  };
  const onKey = (ev: Event): void => {
    const k = ev as KeyboardEvent;
    if (k.ctrlKey || k.metaKey || k.altKey || k.shiftKey || !(k.target instanceof Element)) return;
    const region = regionOf(k.target);
    if (!region) return;
    const own = k.target.closest('.md-card');
    if (own instanceof HTMLElement && innerKey(k, own)) return;
    const m = members(region);
    const at = m.indexOf(k.target as HTMLElement);
    if (at < 0) return; // inside a card: its own arrow keys and Escape (mount.ts)
    let to: HTMLElement | undefined;
    if (k.key === 'i' || k.key === 'I') {
      const node = (k.target as Element).closest('[data-node]')?.getAttribute('data-node');
      if (!node || valueOf.has(node)) return; // a value card has no attribute panel
      k.preventDefault();
      k.stopPropagation();
      opts.onSelectNode?.(node);
      return;
    }
    if (k.key === 'ArrowRight') to = m[Math.min(at + 1, m.length - 1)];
    else if (k.key === 'ArrowLeft') to = m[Math.max(at - 1, 0)];
    else if (k.key === 'Home') to = m[0];
    else if (k.key === 'End') to = m[m.length - 1];
    else if (k.key === 'Enter') {
      // dive into the card's rows; Escape comes back to the card
      to = k.target.querySelector<HTMLElement>('[data-doc-attr]:not(.md-hidden)') ?? undefined;
      if (!to) return;
    } else return;
    k.preventDefault();
    k.stopPropagation();
    to?.focus();
  };
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('keydown', onKey, true);

  function place(wrap: HTMLElement, r: Rect, padded: boolean): void {
    const l = padded ? CARD_PAD.l : 0;
    const t = padded ? CARD_PAD.t : 0;
    wrap.style.position = 'absolute';
    wrap.style.left = `${r.x - l}px`;
    wrap.style.top = `${r.y - t}px`;
  }

  function drawWires(): void {
    wiresSvg.replaceChildren();
    wireKeys = new Set();
    drawnWires = plan?.wires ?? [];
    drawnScope = wireScope();
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
      // an owner line has no graph edge and no arrow; a wire to a value card without an edge is still a wire
      const g = sv(doc, 'g', {}, w.edge === null && !w.arrow ? 'md-edge md-owner-line' : 'md-edge');
      if (w.edge !== null) g.dataset.edge = w.edge;
      const wk = `${w.from}>${w.to}`;
      g.dataset.wire = wk;
      g.dataset.wid = wireId(w, drawnScope);
      wireKeys.add(wk);
      g.append(
        sv(
          doc,
          'path',
          {
            d: roundedPath(w.points),
            ...(w.arrow ? { 'marker-end': `url(#${markerId})` } : {}),
          },
          'md-wire',
        ),
      );
      wiresSvg.append(g);
      if (w.label && (w.label.type || w.label.name)) {
        const t = sv(
          doc,
          'text',
          { x: w.label.x, y: w.label.y, 'text-anchor': w.label.anchor },
          'md-halo',
        );
        if (w.label.type) t.append(sv(doc, 'tspan', {}, 'md-wtype', w.label.type));
        if (w.label.name)
          t.append(sv(doc, 'tspan', { dx: w.label.type ? 4 : 0 }, 'md-wname', w.label.name));
        t.dataset.wire = wk;
        t.dataset.wid = wireId(w, drawnScope);
        wiresSvg.append(t);
      }
    }
  }

  /** The call's name beside a callee card (`read_csv` beside `pd (pandas)`); the card's own name says the same. */
  function drawLabels(): void {
    for (const e of canvas.querySelectorAll('.md-call-label')) e.remove();
    for (const l of plan?.callLabels ?? []) {
      const e = el(doc, 'div', 'md-call-label', `.${l.text}()`);
      e.setAttribute('aria-hidden', 'true');
      e.style.left = `${l.x}px`;
      e.style.top = `${l.y}px`;
      canvas.append(e);
    }
  }

  function drawValues(stage: StageModel | null): void {
    valuesEl.replaceChildren();
    const blocks = plan?.valuesAll ?? (plan?.values ? [plan.values] : []);
    valuesEl.hidden = !(blocks.length > 0 && stage);
    for (const b of blocks) {
      const blk = el(doc, 'div', 'md-stage-values-block');
      blk.setAttribute('role', 'list');
      blk.setAttribute(
        'aria-label',
        b.call !== undefined && lineNow
          ? `Values, call ${b.call + 1} of ${lineNow.calls.length}`
          : 'Values',
      );
      blk.style.left = `${b.x}px`;
      blk.style.top = `${b.y}px`;
      blk.style.width = `${b.w}px`;
      for (const l of b.lines) {
        const row = el(doc, 'div', 'md-stage-value', l);
        row.title = l;
        row.setAttribute('role', 'listitem');
        blk.append(row);
      }
      valuesEl.append(blk);
    }
  }

  function notes(stage: StageModel | null): void {
    stageNotes.replaceChildren();
    if (!stage) return;
    if (stage.line !== null)
      stageNotes.append(el(doc, 'span', 'md-stage-line', `Line ${stage.line}`));
    if (stage.failed && stage.participants.some((p) => p.changed))
      stageNotes.append(el(doc, 'span', 'md-stage-note', '⚠ changed before it failed'));
    if (stage.dropped > 0)
      stageNotes.append(
        el(
          doc,
          'span',
          'md-stage-note',
          `${stage.dropped} ${stage.dropped === 1 ? 'object' : 'objects'} not shown`,
        ),
      );
  }

  const layoutRect = (e: HTMLElement, base: HTMLElement): Rect => {
    const origin = (n: HTMLElement | null): { x: number; y: number } => {
      let x = 0;
      let y = 0;
      for (let c: HTMLElement | null = n; c; c = c.offsetParent as HTMLElement | null) {
        x += c.offsetLeft;
        y += c.offsetTop;
      }
      return { x, y };
    };
    const a = origin(e);
    const b = origin(base);
    return { x: a.x - b.x, y: a.y - b.y, w: e.offsetWidth, h: e.offsetHeight };
  };
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
        const boxRect = boxCards.get(c);
        const isBox = boxRect !== undefined && !st;
        const where: CardInfo['where'] =
          c.wrap.closest('[hidden]') || !c.wrap.isConnected
            ? 'hidden'
            : c.wrap.parentElement === canvas
              ? 'stage'
              : 'shelf';
        let shelfRect: Rect | null = null;
        if (entry && !entry.el.hidden) {
          const ref = entry.el.firstElementChild;
          const target = entry.ph.hidden ? (ref ?? entry.el) : entry.ph;
          // a card mid-animation is transformed: measure its layout box, not where it is drawn
          shelfRect =
            running.length > 0 && target instanceof HTMLElement
              ? layoutRect(target, host)
              : relTo(target.getBoundingClientRect(), base);
        }
        let stageRect: Rect | null = null;
        const r = st ? st.item.rect : isBox ? boxRect : null;
        if (r && where === 'stage')
          stageRect = {
            x: canvasAt.left - base.left + r.x - CARD_PAD.l,
            y: canvasAt.top - base.top + r.y - CARD_PAD.t,
            w: r.w + CARD_PAD.l + CARD_PAD.r,
            h: r.h + CARD_PAD.t + CARD_PAD.b,
          };
        out.push({
          key: c.key,
          node: c.node,
          object: c.object,
          where,
          shelf: shelfRect,
          stage: stageRect,
        });
      }
      return out;
    },
    destroy() {
      destroyed = true;
      finishAnimations();
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('keydown', onKey, true);
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
  if (n.kind === 'def') return `${n.defKind === 'class' ? 'class' : 'def'} ${n.name}`;
  return n.id;
}
