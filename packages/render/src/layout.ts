// GraphModel -> ELK -> Laid (CONTRACTS.md section 8, SPEC "Layout").
// `buildElkGraph` is a pure function (model + measure -> ELK input); `layout` runs ELK on it.
import type { CallNode, GEdge, GNode, GraphModel, InstanceNode } from '@machines/log';
import ELKApi from 'elkjs/lib/elk-api';
import type { ELK, ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';

export type Measure = (text: string, font: string) => number;

export interface LayoutOptions {
  /** Ignored until M4 (expand/collapse). */
  expanded?: Set<string>;
  /**
   * An ELK instance, e.g. from `createElk({ workerUrl })`. Browsers should pass one backed by the elkjs
   * worker build so layout stays off the main thread. Default: the in-thread bundled build, loaded lazily.
   */
  elk?: ELK;
  /** Text width in px. Default: canvas measureText in a browser, a character-count estimate elsewhere. */
  measure?: Measure;
  /**
   * Attribute rows (the `name type` texts) to reserve in each instance box, by instance id.
   * Default: one row per constructor param. Pass the union over all versions so the box never resizes.
   */
  attrRows?: Record<string, string[]>;
  /**
   * Number of methods in each instance's "more methods" list, by instance id (`moreMethodsFor`). An instance
   * with a count above 0 reserves one control row at the bottom of its box. Default: none.
   */
  moreMethods?: Record<string, number>;
  /**
   * The type text of each wire label (the part before the name), by edge id: `edgeLabelsFor` gives the
   * longest over the run. Default: a placeholder of the usual length. The edge's `nameLabel` follows it.
   */
  edgeLabels?: Record<string, string>;
  /**
   * Lowest quality tier to use (CONTRACTS section 8). A streaming caller passes the highest tier seen so far
   * in the run so the layout style does not flip back and forth as the graph grows.
   */
  minTier?: 0 | 1 | 2;
}

/** Where a wire label goes: the rectangle it occupies (absolute coordinates). */
export interface LaidLabel {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Set when no free spot lies within `LABEL_MAX_DIST` of the wire: a line from the label (x1,y1) to the wire (x2,y2). */
  leader?: [number, number, number, number];
}

export interface LaidPort {
  x: number;
  y: number;
  /** Width reserved for this port's labels, centred on x. */
  w: number;
}
export interface LaidNode {
  x: number;
  y: number;
  w: number;
  h: number;
  ports: Record<string, LaidPort>;
  /** Instances: height of the name pill, and of the attribute list under it (both inside the box, at the top). */
  headerH?: number;
  attrsH?: number;
  /** Instances with a "more methods" list: its method count, and the height of the control row at the bottom. */
  moreN?: number;
  moreH?: number;
}
export interface Laid {
  width: number;
  height: number;
  nodes: Record<string, LaidNode>;
  edges: Record<string, { points: [number, number][] }>;
  /** Wire label rectangles by edge id. They overlap no box, instance header or other label where room allows. */
  labels: Record<string, LaidLabel>;
  /** Edges left out because an endpoint (node or port) does not exist; they would be false wires. */
  dropped: number;
}

/** Fonts, shared with the SVG renderer so ELK and SVG agree on sizes. */
export const FONT_MONO = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
export const FONT_WTYPE = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
export const FONT_WNAME = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
export const FONT_NAME = 'bold 13px ui-monospace, SFMono-Regular, Menlo, monospace';

/** Metrics in px. A call box is: [port labels (top)] [name row] [port labels (bottom)]. */
export const M = {
  nameH: 24,
  portLabelH: 30, // type line + gray name line
  portGap: 14,
  boxPadX: 12,
  minBoxW: 56,
  instHeaderH: 28,
  instRowH: 18,
  instPad: 12,
  exprH: 22,
  storeH: 28,
  textPadX: 8,
  emptyPortH: 6,
  laneGap: 8, // spacing of wires entering an instance below its attribute rows
  moreH: 22, // the "more methods (N)" control row at the bottom of an instance
};

export function estimateMeasure(text: string, font: string): number {
  const size = /(\d+(?:\.\d+)?)px/.exec(font)?.[1];
  return text.length * (size ? Number(size) : 12) * 0.62;
}

let canvasCtx: CanvasRenderingContext2D | null | undefined;
export function defaultMeasure(text: string, font: string): number {
  if (canvasCtx === undefined) {
    try {
      canvasCtx =
        typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    } catch {
      canvasCtx = null;
    }
  }
  if (!canvasCtx) return estimateMeasure(text, font);
  canvasCtx.font = font;
  const w = canvasCtx.measureText(text).width;
  return w > 0 || text === '' ? w : estimateMeasure(text, font);
}

export const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.portConstraints': 'FIXED_ORDER',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.json.edgeCoords': 'ROOT',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.edgeNode': '16',
  'elk.spacing.edgeEdge': '12',
  'elk.padding': '[top=12,left=12,bottom=12,right=12]',
};

/**
 * Size-based degradation (CONTRACTS section 8). ELK's cost grows with the number of dummy nodes it inserts
 * for edges spanning several layers, so `longEdgeLoad` estimates that count and the load picks a tier.
 * Tier 0 is full quality. Tier 1 drops the model-order sort (the superlinear part) and the extra crossing
 * sweeps. Tier 2 also skips crossing minimisation and lays instances out per level.
 */
export const TIER1_LOAD = 4000;
export const TIER2_LOAD = 15000;
export const TIER_OPTIONS: Record<string, string>[] = [
  {},
  { 'elk.layered.considerModelOrder.strategy': 'NONE', 'elk.layered.thoroughness': '1' },
  {
    'elk.layered.considerModelOrder.strategy': 'NONE',
    'elk.layered.thoroughness': '1',
    'elk.layered.crossingMinimization.strategy': 'NONE',
    'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
  },
];

/** The tier for a `longEdgeLoad`. Callers that re-lay out one run repeatedly keep the max (`minTier`). */
export function tierFor(load: number): 0 | 1 | 2 {
  return load > TIER2_LOAD ? 2 : load > TIER1_LOAD ? 1 : 0;
}

/**
 * Estimated number of long-edge dummy nodes: edges' layer spans under longest-path layering of the model. */
export function longEdgeLoad(
  nodes: { id: string; order: number }[],
  edges: { fromNode: string; toNode: string }[],
): number {
  const pos = new Map<string, number>();
  [...nodes]
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .forEach((n, k) => pos.set(n.id, k));
  const fwd = edges
    .map((e) => [pos.get(e.fromNode)!, pos.get(e.toNode)!] as const)
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[1] - y[1]);
  const layer = new Array<number>(nodes.length).fill(0);
  // targets in position order: every source has a smaller position, so its layer is final
  for (const [a, b] of fwd) layer[b] = Math.max(layer[b]!, layer[a]! + 1);
  let load = 0;
  for (const [a, b] of fwd) load += Math.max(0, layer[b]! - layer[a]! - 1);
  return load;
}

const SPLIT_A = '~a';
const SPLIT_B = '~b';
const laneKey = (inst: string, edge: string): string => `${inst}#lane:${edge}`;
const portKey = (node: string, port: string): string => `${node}#${port}`;

export function instanceTitle(n: InstanceNode): string {
  return n.varName ? `${n.varName}: ${n.className}` : n.className;
}

export function instanceRows(n: InstanceNode, attrRows?: Record<string, string[]>): string[] {
  return attrRows?.[n.id] ?? n.params.map((p) => `${p.name} ${p.text}`);
}

interface PortSizes {
  in: number[];
  out: number[];
}
function callPortWidths(n: CallNode, measure: Measure): PortSizes {
  const w = (lines: string[]): number =>
    Math.max(...lines.map((l) => measure(l, FONT_MONO)), 0) + M.portGap;
  return {
    in: n.inPorts.map((p) => w(p.constText !== undefined ? [p.constText] : [p.typeLabel, p.param])),
    out: n.outPorts.map((p) => w([p.typeLabel, p.nameLabel ?? p.param])),
  };
}

/** Siblings are supplied to ELK by (order, id), so layout is deterministic. */
const byOrder = (a: GNode, b: GNode): number =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The module shown in parentheses after a call box's name (svl-1x4): where the imported name comes from,
 * `LinearRegression (sklearn.linear_model)`. Import nodes and callee edges stay in the model but are not drawn;
 * this reads the import behind each callee edge. A box with no import behind it (a method, a builtin) has none.
 * For `from m import Ridge as R` the import source is `m.Ridge`; the attribute is cut so the module remains.
 */
export function callModules(model: GraphModel): Map<string, string> {
  const imports = new Map<string, string>();
  for (const n of model.nodes) if (n.kind === 'import') imports.set(n.id, n.source ?? n.name);
  const calls = new Map<string, CallNode>();
  for (const n of model.nodes) if (n.kind === 'call') calls.set(n.id, n);
  const out = new Map<string, string>();
  for (const e of model.edges) {
    if (!e.callee) continue;
    const src = imports.get(e.from.node);
    const call = calls.get(e.to.node);
    if (src === undefined || call === undefined || out.has(call.id)) continue;
    const tail = `.${call.name}`;
    out.set(call.id, src.endsWith(tail) ? src.slice(0, -tail.length) : src);
  }
  return out;
}

/** The name line of a call box: the name, then `(module)` when the name was imported. */
export const callTitle = (name: string, module: string | undefined): string =>
  module === undefined ? name : `${name} (${module})`;

interface SizeOpts {
  attrRows?: Record<string, string[]>;
  moreMethods?: Record<string, number>;
  modules?: Map<string, string>;
}
const moreRow = (n: InstanceNode, o: SizeOpts): number =>
  (o.moreMethods?.[n.id] ?? 0) > 0 ? M.moreH : 0;

function leafSize(n: GNode, measure: Measure, o: SizeOpts): { w: number; h: number } {
  switch (n.kind) {
    case 'call': {
      const pw = callPortWidths(n, measure);
      // FIXED_ORDER spaces ports evenly: n ports split the width into n + 1 gaps.
      const sum = (a: number[]): number => (a.length ? (a.length + 1) * Math.max(...a) : 0);
      const w = Math.max(
        M.minBoxW,
        measure(callTitle(n.name, o.modules?.get(n.id)), FONT_NAME) + 2 * M.boxPadX,
        sum(pw.in),
        sum(pw.out),
      );
      const h =
        M.nameH +
        (n.inPorts.length ? M.portLabelH : M.emptyPortH) +
        (n.outPorts.length ? M.portLabelH : M.emptyPortH);
      return { w: Math.ceil(w), h };
    }
    case 'instance': {
      const rows = instanceRows(n, o.attrRows);
      const w = Math.max(
        measure(instanceTitle(n), FONT_NAME) + 2 * M.boxPadX,
        // 2 * instPad plus room for the row's "?" button (svl-3du)
        ...rows.map((r) => measure(r, FONT_MONO) + 2 * M.instPad + 12),
        moreRow(n, o)
          ? measure(`▸ more methods (${o.moreMethods![n.id]})`, FONT_MONO) + 2 * M.instPad
          : 0,
        M.minBoxW,
      );
      // a title-only box (no attribute rows) needs no gap under the pill
      const body = rows.length * M.instRowH + (rows.length > 0 ? M.instPad : 0);
      return {
        w: Math.ceil(w),
        h: M.instHeaderH + body + moreRow(n, o) + (rows.length > 0 ? 0 : 6),
      };
    }
    case 'expr':
      return { w: Math.ceil(measure(n.text, FONT_MONO) + 2 * M.textPadX), h: M.exprH };
    case 'store':
      return { w: Math.ceil(measure(n.text, FONT_MONO) + 2 * M.textPadX + 8), h: M.storeH };
    case 'source':
      return { w: Math.ceil(measure(n.label, FONT_MONO) + 2 * M.textPadX), h: M.exprH };
    case 'import': {
      // a pill: the bound name, and under it the module it comes from (gray)
      const w = Math.max(
        measure(n.name, FONT_NAME),
        n.source === null ? 0 : measure(n.source, FONT_WNAME),
      );
      return { w: Math.ceil(w + 2 * M.textPadX), h: n.source === null ? M.exprH : M.exprH + 14 };
    }
  }
}

/** Pure: GraphModel -> ELK input graph. */
export function buildElkGraph(
  model: GraphModel,
  opts: {
    measure?: Measure;
    attrRows?: Record<string, string[]>;
    moreMethods?: Record<string, number>;
    minTier?: 0 | 1 | 2;
  } = {},
): ElkNode {
  return buildElk(model, opts).graph;
}

/** As `buildElkGraph`, also reporting how many edges were dropped for naming a missing node or port. */
export function buildElk(
  model: GraphModel,
  opts: {
    measure?: Measure;
    attrRows?: Record<string, string[]>;
    moreMethods?: Record<string, number>;
    minTier?: 0 | 1 | 2;
  } = {},
): { graph: ElkNode; dropped: number } {
  const measure = opts.measure ?? defaultMeasure;
  // Import nodes and callee edges stay in the model (a later bead draws imports as timeline steps) but are
  // not drawn: the import shows as `(module)` in the call box (svl-1x4).
  const modules = callModules(model);
  model = {
    ...model,
    nodes: model.nodes.filter((n) => n.kind !== 'import'),
    edges: model.edges.filter((e) => !e.callee),
  };
  const ids = new Set(model.nodes.map((n) => n.id));
  const instIds = new Set(model.nodes.filter((n) => n.kind === 'instance').map((n) => n.id));
  const kids = new Map<string | null, GNode[]>();
  for (const n of [...model.nodes].sort(byOrder)) {
    // M1-3: only instances have children; a node whose parent is missing or not an instance is top-level.
    const p = n.parent !== null && instIds.has(n.parent) ? n.parent : null;
    let list = kids.get(p);
    if (!list) kids.set(p, (list = []));
    list.push(n);
  }

  const callById = new Map<string, CallNode>();
  for (const n of model.nodes) if (n.kind === 'call') callById.set(n.id, n);
  const endpoint = (r: GEdge['from']): string | null => {
    if (!ids.has(r.node)) return null;
    if (r.port === null) return r.node;
    const n = callById.get(r.node);
    const has = n !== undefined && [...n.inPorts, ...n.outPorts].some((p) => p.id === r.port);
    return has ? portKey(r.node, r.port) : null;
  };

  // Sorted by id so the output does not depend on the input order.
  const resolved: { id: string; from: string; to: string; fromNode: string; toNode: string }[] = [];
  let dropped = 0;
  for (const ed of [...model.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const from = endpoint(ed.from);
    const to = endpoint(ed.to);
    if (from === null || to === null) dropped++;
    else resolved.push({ id: ed.id, from, to, fromNode: ed.from.node, toNode: ed.to.node });
  }
  // An edge from outside into an instance's method box goes through a hierarchical port on the instance's
  // west border, placed below the attribute rows, so it never runs through the header or the rows.
  const effParent = new Map<string, string | null>();
  for (const [p, list] of kids) for (const k of list) effParent.set(k.id, p);
  const intoInst = new Map<string, string[]>();
  const lane = new Map<string, string>(); // edge id -> instance id
  for (const r of resolved) {
    const inst = effParent.get(r.toNode) ?? null;
    if (inst === null || r.fromNode === inst || effParent.get(r.fromNode) === inst) continue;
    lane.set(r.id, inst);
    let l = intoInst.get(inst);
    if (!l) intoInst.set(inst, (l = []));
    l.push(r.id);
  }

  const edges: ElkExtendedEdge[] = [];
  for (const r of resolved) {
    const inst = lane.get(r.id);
    if (inst === undefined) edges.push({ id: r.id, sources: [r.from], targets: [r.to] });
    else {
      edges.push({ id: `${r.id}${SPLIT_A}`, sources: [r.from], targets: [laneKey(inst, r.id)] });
      edges.push({ id: `${r.id}${SPLIT_B}`, sources: [laneKey(inst, r.id)], targets: [r.to] });
    }
  }

  const build = (n: GNode): ElkNode => {
    const e: ElkNode = { id: n.id };
    const children = kids.get(n.id);
    const size = leafSize(n, measure, { ...opts, modules });
    if (n.kind === 'call') {
      e.width = size.w;
      e.height = size.h;
      e.layoutOptions = { 'elk.portConstraints': 'FIXED_ORDER' };
      const nIn = n.inPorts.length;
      const nOut = n.outPorts.length;
      const ports: ElkPort[] = [];
      // ELK numbers ports clockwise from the top-left: NORTH left-to-right, then SOUTH right-to-left.
      n.inPorts.forEach((p, k) =>
        ports.push({
          id: portKey(n.id, p.id),
          width: 0,
          height: 0,
          layoutOptions: { 'elk.port.side': 'NORTH', 'elk.port.index': String(k) },
        }),
      );
      n.outPorts.forEach((p, k) =>
        ports.push({
          id: portKey(n.id, p.id),
          width: 0,
          height: 0,
          layoutOptions: {
            'elk.port.side': 'SOUTH',
            'elk.port.index': String(nIn + (nOut - 1 - k)),
          },
        }),
      );
      e.ports = ports;
    } else if (n.kind === 'instance' && children?.length) {
      const rows = instanceRows(n, opts.attrRows);
      const top =
        M.instHeaderH +
        rows.length * M.instRowH +
        M.instPad +
        (intoInst.get(n.id)?.length ?? 0) * M.laneGap;
      const bottom = M.instPad + moreRow(n, opts);
      e.children = children.map(build);
      // Wires from outside enter through the west border below the attribute rows (hierarchical ports).
      const lanes = intoInst.get(n.id) ?? [];
      e.ports = lanes.map((edgeId, k) => ({
        id: laneKey(n.id, edgeId),
        x: 0,
        y: top - M.instPad + M.laneGap * (k + 1),
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': 'WEST' },
      }));
      e.layoutOptions = {
        'elk.portConstraints': 'FIXED_POS',
        'elk.padding': `[top=${top},left=${M.instPad},bottom=${bottom},right=${M.instPad}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        // ELK reads a compound's minimum as (height, width) under direction DOWN (it lays out sideways and
        // rotates), so a (w, h) value would reserve w px of height: the empty band under a lone method box.
        'elk.nodeSize.minimum': `(${size.h},${size.w})`,
      };
    } else {
      e.width = size.w;
      e.height = size.h;
    }
    return e;
  };

  const load = longEdgeLoad(model.nodes, resolved);
  // Tier 2's SEPARATE_CHILDREN leaves wires that cross a compound border without sections, so with instances
  // that have children the tier is capped at 1.
  const compound = kids.size > 0 && [...kids.keys()].some((k) => k !== null);
  const tier = Math.min(Math.max(tierFor(load), opts.minTier ?? 0), compound ? 1 : 2) as 0 | 1 | 2;
  return {
    graph: {
      id: 'root',
      layoutOptions: { ...ROOT_OPTIONS, ...TIER_OPTIONS[tier] },
      children: (kids.get(null) ?? []).map(build),
      edges,
    },
    dropped,
  };
}

/** An ELK instance running in the elkjs worker build (`workerUrl` = URL of `elkjs/lib/elk-worker.min.js`). */
export function createElk(opts: { workerUrl: string }): ELK {
  return new ELKApi({ workerUrl: opts.workerUrl });
}

let bundled: Promise<ELK> | undefined;
async function defaultElk(): Promise<ELK> {
  bundled ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return bundled;
}

function dedupe(pts: [number, number][]): [number, number][] {
  return pts.filter((p, k) => k === 0 || p[0] !== pts[k - 1]![0] || p[1] !== pts[k - 1]![1]);
}

/** Convert ELK's output (child coordinates relative to the parent) to absolute coordinates. */
export function toLaid(
  root: ElkNode,
  model: GraphModel,
  measure: Measure = defaultMeasure,
  attrRows?: Record<string, string[]>,
  moreMethods?: Record<string, number>,
): Laid {
  const laid: Laid = {
    width: root.width ?? 0,
    height: root.height ?? 0,
    nodes: {},
    edges: {},
    labels: {},
    dropped: 0,
  };
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const walk = (n: ElkNode, ox: number, oy: number, isRoot: boolean): void => {
    const x = ox + (n.x ?? 0);
    const y = oy + (n.y ?? 0);
    const g = byId.get(n.id);
    const ln: LaidNode = { x, y, w: n.width ?? 0, h: n.height ?? 0, ports: {} };
    if (g?.kind === 'call') {
      const pw = callPortWidths(g, measure);
      const widths = new Map<string, number>();
      g.inPorts.forEach((p, k) => widths.set(p.id, pw.in[k] ?? 0));
      g.outPorts.forEach((p, k) => widths.set(p.id, pw.out[k] ?? 0));
      const prefix = `${g.id}#`;
      for (const p of n.ports ?? []) {
        const pid = p.id.startsWith(prefix) ? p.id.slice(prefix.length) : p.id;
        ln.ports[pid] = {
          x: x + (p.x ?? 0) + (p.width ?? 0) / 2,
          y: y + (p.y ?? 0) + (p.height ?? 0) / 2,
          w: widths.get(pid) ?? 0,
        };
      }
    } else if (g?.kind === 'instance') {
      ln.headerH = M.instHeaderH;
      ln.attrsH = instanceRows(g, attrRows).length * M.instRowH;
      const more = moreMethods?.[g.id] ?? 0;
      if (more > 0) {
        ln.moreN = more;
        ln.moreH = M.moreH;
      }
    }
    if (!isRoot) laid.nodes[n.id] = ln;
    for (const c of n.children ?? []) walk(c, isRoot ? 0 : x, isRoot ? 0 : y, false);
  };
  walk(root, 0, 0, true);
  for (const e of root.edges ?? []) {
    const pts: [number, number][] = [];
    for (const s of (e as ElkExtendedEdge).sections ?? []) {
      pts.push([s.startPoint.x, s.startPoint.y]);
      for (const b of s.bendPoints ?? []) pts.push([b.x, b.y]);
      pts.push([s.endPoint.x, s.endPoint.y]);
    }
    const half = e.id.endsWith(SPLIT_A) ? SPLIT_A : e.id.endsWith(SPLIT_B) ? SPLIT_B : null;
    if (half === null) laid.edges[e.id] = { points: pts };
    else {
      // the two halves of an edge split at an instance port: join them (the port point appears once)
      const id = e.id.slice(0, -half.length);
      const cur = laid.edges[id]?.points ?? [];
      const joined = half === SPLIT_A ? [...pts, ...cur] : [...cur, ...pts];
      laid.edges[id] = { points: dedupe(joined) };
    }
  }
  return laid;
}

export async function layout(model: GraphModel, opts: LayoutOptions = {}): Promise<Laid> {
  const measure = opts.measure ?? defaultMeasure;
  const { graph, dropped } = buildElk(model, {
    measure,
    attrRows: opts.attrRows,
    moreMethods: opts.moreMethods,
    minTier: opts.minTier,
  });
  if (dropped > 0) console.warn(`layout: dropped ${dropped} edge(s) naming a missing node or port`);
  let out: ElkNode;
  try {
    out = await (opts.elk ?? (await defaultElk())).layout(graph);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ELK layout failed for a model with ${model.nodes.length} nodes and ${model.edges.length} edges: ${msg}`,
      { cause: err },
    );
  }
  const laid = toLaid(out, model, measure, opts.attrRows, opts.moreMethods);
  laid.labels = placeLabels(model, laid, opts.edgeLabels ?? {}, measure);
  laid.dropped = dropped;
  return laid;
}

// ---------------------------------------------------------------------------------------------
// Wire labels

const LABEL_H = 18;
/** Furthest a label may sit from its wire (px) before it gets a leader line. */
export const LABEL_MAX_DIST = 24;
const LABEL_PLACEHOLDER = 'DataFrame (000, 0)';
type Rect = { x: number; y: number; w: number; h: number };

const overlap = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

function segHits(r: Rect, a: [number, number], b: [number, number]): boolean {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return x0 <= r.x + r.w && x1 >= r.x && y0 <= r.y + r.h && y1 >= r.y;
}

/** A uniform grid over rectangles, so a query only visits the items near it (each item once). */
class Grid<T> {
  private cells = new Map<number, number[]>();
  private items: T[] = [];
  private seen: number[] = [];
  private stamp = 0;
  constructor(private cell = 64) {}
  private key(i: number, j: number): number {
    return i * 1048576 + j;
  }
  insert(r: Rect, item: T): void {
    const id = this.items.length;
    this.items.push(item);
    this.seen.push(0);
    const c = this.cell;
    for (let i = Math.floor(r.x / c); i <= Math.floor((r.x + r.w) / c); i++)
      for (let j = Math.floor(r.y / c); j <= Math.floor((r.y + r.h) / c); j++) {
        const k = this.key(i, j);
        const l = this.cells.get(k);
        if (l) l.push(id);
        else this.cells.set(k, [id]);
      }
  }
  /** Calls `f` once for every item whose cells touch `r` (a superset of those overlapping it). */
  query(r: Rect, f: (item: T) => void): void {
    const c = this.cell;
    this.stamp++;
    for (let i = Math.floor(r.x / c); i <= Math.floor((r.x + r.w) / c); i++)
      for (let j = Math.floor(r.y / c); j <= Math.floor((r.y + r.h) / c); j++) {
        for (const id of this.cells.get(this.key(i, j)) ?? []) {
          if (this.seen[id] === this.stamp) continue;
          this.seen[id] = this.stamp;
          f(this.items[id]!);
        }
      }
  }
}

/**
 * Choose a rectangle for each wire label beside its wire, avoiding boxes, instance headers and
 * attribute rows, other wires and other labels. Greedy in edge-id order, so the result is deterministic.
 */
export function placeLabels(
  model: GraphModel,
  laid: Laid,
  texts: Record<string, string>,
  measure: Measure,
): Record<string, LaidLabel> {
  const hasKids = new Set<string>();
  for (const n of model.nodes) if (n.parent !== null) hasKids.add(n.parent);
  const boxes: Rect[] = [];
  for (const n of model.nodes) {
    const l = laid.nodes[n.id];
    if (!l) continue;
    if (n.kind === 'instance' && hasKids.has(n.id)) {
      boxes.push({ x: l.x, y: l.y, w: l.w, h: (l.headerH ?? 0) + (l.attrsH ?? 0) });
    } else boxes.push({ x: l.x, y: l.y, w: l.w, h: l.h });
  }
  const segs: { id: string; a: [number, number]; b: [number, number] }[] = [];
  for (const [id, e] of Object.entries(laid.edges)) {
    for (let k = 0; k + 1 < e.points.length; k++)
      segs.push({ id, a: e.points[k]!, b: e.points[k + 1]! });
  }
  for (const n of model.nodes) {
    const l = laid.nodes[n.id];
    if (n.kind !== 'instance' || !l) continue;
    const [x0, y0, x1, y1] = [l.x, l.y, l.x + l.w, l.y + l.h];
    segs.push({ id: '', a: [x0, y0], b: [x1, y0] }, { id: '', a: [x1, y0], b: [x1, y1] });
    segs.push({ id: '', a: [x0, y1], b: [x1, y1] }, { id: '', a: [x0, y0], b: [x0, y1] });
  }
  const boxGrid = new Grid<Rect>();
  for (const b of boxes) boxGrid.insert(b, b);
  const segGrid = new Grid<(typeof segs)[number]>();
  for (const sg of segs)
    segGrid.insert(
      {
        x: Math.min(sg.a[0], sg.b[0]),
        y: Math.min(sg.a[1], sg.b[1]),
        w: Math.abs(sg.a[0] - sg.b[0]),
        h: Math.abs(sg.a[1] - sg.b[1]),
      },
      sg,
    );
  const placedGrid = new Grid<Rect>();
  const out: Record<string, LaidLabel> = {};
  const edges = [...model.edges].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  for (const ed of edges) {
    const pts = laid.edges[ed.id]?.points;
    if (!pts || pts.length < 2) continue;
    const type = texts[ed.id] ?? LABEL_PLACEHOLDER;
    const name = ed.nameLabel ?? '';
    const w = Math.ceil(
      measure(type, FONT_WTYPE) + (type && name ? 4 : 0) + measure(name, FONT_WNAME) + 8,
    );
    const cands: { r: Rect; pref: number }[] = [];
    const order = pts
      .slice(1)
      .map((p, k) => ({ k, len: Math.abs(p[0] - pts[k]![0]) + Math.abs(p[1] - pts[k]![1]) }))
      .sort((p, q) => q.len - p.len || p.k - q.k);
    order.forEach(({ k, len }, rank) => {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      const x0 = Math.min(a[0], b[0]);
      const y0 = Math.min(a[1], b[1]);
      if (len < 4) return;
      const base = rank * 4 + (len < 24 ? 30 : 0);
      if (a[1] === b[1]) {
        const fits = len >= w;
        for (const [fi, f] of [0.5, 0.2, 0.8, 0.05, 0.95].entries()) {
          const cx = fits ? x0 + w / 2 + (len - w) * f : x0 + len / 2;
          for (const [si, side] of [-1, 1].entries()) {
            const y = side < 0 ? a[1] - LABEL_H - 2 : a[1] + 2;
            cands.push({ r: { x: cx - w / 2, y, w, h: LABEL_H }, pref: base + fi * 2 + si });
          }
        }
      } else {
        for (const [fi, f] of [0.5, 0.2, 0.8, 0.05, 0.95].entries()) {
          const cy = len >= LABEL_H ? y0 + LABEL_H / 2 + (len - LABEL_H) * f : y0 + len / 2;
          for (const [si, x] of [b[0] + 4, b[0] - 4 - w].entries()) {
            cands.push({ r: { x, y: cy - LABEL_H / 2, w, h: LABEL_H }, pref: base + fi * 2 + si });
          }
        }
      }
    });
    const score = (c: { r: Rect; pref: number }): number => {
      let cost = c.pref;
      // the grid returns a superset; the exact predicates decide (the 2px / inclusive margins fit in a cell)
      const q = { x: c.r.x - 2, y: c.r.y - 2, w: c.r.w + 4, h: c.r.h + 4 };
      boxGrid.query(q, (bx) => {
        if (overlap(c.r, bx, 2)) cost += 1000;
      });
      placedGrid.query(q, (pl) => {
        if (overlap(c.r, pl, 2)) cost += 300;
      });
      segGrid.query(q, (sg) => {
        if (sg.id !== ed.id && segHits(c.r, sg.a, sg.b)) cost += 40;
      });
      if (c.r.x < 0) cost += 500;
      const d = nearestOnWire(c.r, pts).d;
      if (d > LABEL_MAX_DIST) cost += 150 + d / 4;
      return cost;
    };
    const best: { r: Rect | null; cost: number } = { r: null, cost: Infinity };
    const consider = (list: { r: Rect; pref: number }[]): void => {
      for (const c of list) {
        const cost = score(c);
        if (cost < best.cost) {
          best.r = c.r;
          best.cost = cost;
        }
      }
    };
    consider(cands);
    if (best.cost >= 300) {
      // crowded: scan outwards from the middle of the longest segment, preferring nearby spots
      const k = order[0]?.k ?? 0;
      const mx = (pts[k]![0] + pts[k + 1]![0]) / 2;
      const my = (pts[k]![1] + pts[k + 1]![1]) / 2;
      const scan: { r: Rect; pref: number }[] = [];
      for (let dy = -120; dy <= 120; dy += 10) {
        for (const dx of [4, -4 - w, 28, -28 - w, 60, -60 - w, 120, -120 - w]) {
          const r = { x: mx + dx, y: my + dy - LABEL_H / 2, w, h: LABEL_H };
          scan.push({ r, pref: 50 + (Math.abs(dx) + Math.abs(dy)) / 4 });
        }
      }
      consider(scan);
    }
    if (best.r === null) continue;
    placedGrid.insert(best.r, best.r);
    const near = nearestOnWire(best.r, pts);
    out[ed.id] = { ...best.r };
    if (near.d > LABEL_MAX_DIST) {
      const r = best.r;
      const [wx, wy] = near.p;
      const sx = Math.min(Math.max(wx, r.x), r.x + r.w);
      const sy = Math.min(Math.max(wy, r.y), r.y + r.h);
      out[ed.id]!.leader = [sx, sy, wx, wy];
    }
  }
  return out;
}

/** The point of the polyline nearest the rectangle, and its distance to it (0 when they touch). */
function nearestOnWire(r: Rect, pts: [number, number][]): { d: number; p: [number, number] } {
  let best = { d: Infinity, p: pts[0]! };
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k]!;
    const b = pts[k + 1]!;
    // nearest point of the (axis-aligned) segment to the rectangle's centre, then its distance to the rectangle
    const px = Math.min(Math.max(cx, Math.min(a[0], b[0])), Math.max(a[0], b[0]));
    const py = Math.min(Math.max(cy, Math.min(a[1], b[1])), Math.max(a[1], b[1]));
    const dx = Math.max(r.x - px, px - (r.x + r.w), 0);
    const dy = Math.max(r.y - py, py - (r.y + r.h), 0);
    const d = Math.hypot(dx, dy);
    if (d < best.d) best = { d, p: [px, py] };
  }
  return best;
}
