// GraphModel -> ELK -> Laid (CONTRACTS.md section 8, SPEC "Layout").
// `buildElkGraph` is a pure function (model + measure -> ELK input); `layout` runs ELK on it.
import type { CallNode, GEdge, GNode, GraphModel, InstanceNode } from '@machines/log';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';

export type Measure = (text: string, font: string) => number;

export interface LayoutOptions {
  expanded?: Set<string>;
  /** Text width in px. Default: canvas measureText in a browser, a character-count estimate elsewhere. */
  measure?: Measure;
  /**
   * Attribute rows (the `name type` texts) to reserve in each instance box, by instance id.
   * Default: one row per constructor param. Pass the union over all versions so the box never resizes.
   */
  attrRows?: Record<string, string[]>;
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
}
export interface Laid {
  width: number;
  height: number;
  nodes: Record<string, LaidNode>;
  edges: Record<string, { points: [number, number][] }>;
}

/** Fonts, shared with the SVG renderer so ELK and SVG agree on sizes. */
export const FONT_MONO = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
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

function leafSize(
  n: GNode,
  measure: Measure,
  attrRows?: Record<string, string[]>,
): { w: number; h: number } {
  switch (n.kind) {
    case 'call': {
      const pw = callPortWidths(n, measure);
      // FIXED_ORDER spaces ports evenly: n ports split the width into n + 1 gaps.
      const sum = (a: number[]): number => (a.length ? (a.length + 1) * Math.max(...a) : 0);
      const w = Math.max(
        M.minBoxW,
        measure(n.name, FONT_NAME) + 2 * M.boxPadX,
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
      const rows = instanceRows(n, attrRows);
      const w = Math.max(
        measure(instanceTitle(n), FONT_NAME) + 2 * M.boxPadX,
        ...rows.map((r) => measure(r, FONT_MONO) + 2 * M.instPad),
        M.minBoxW,
      );
      return { w: Math.ceil(w), h: M.instHeaderH + rows.length * M.instRowH + M.instPad };
    }
    case 'expr':
      return { w: Math.ceil(measure(n.text, FONT_MONO) + 2 * M.textPadX), h: M.exprH };
    case 'store':
      return { w: Math.ceil(measure(n.text, FONT_MONO) + 2 * M.textPadX + 8), h: M.storeH };
    case 'source':
      return { w: Math.ceil(measure(n.label, FONT_MONO) + 2 * M.textPadX), h: M.exprH };
  }
}

/** Pure: GraphModel -> ELK input graph. */
export function buildElkGraph(
  model: GraphModel,
  opts: { measure?: Measure; attrRows?: Record<string, string[]> } = {},
): ElkNode {
  const measure = opts.measure ?? defaultMeasure;
  const ids = new Set(model.nodes.map((n) => n.id));
  const kids = new Map<string | null, GNode[]>();
  for (const n of [...model.nodes].sort(byOrder)) {
    const p = n.parent !== null && ids.has(n.parent) ? n.parent : null;
    let list = kids.get(p);
    if (!list) kids.set(p, (list = []));
    list.push(n);
  }

  const build = (n: GNode): ElkNode => {
    const e: ElkNode = { id: n.id };
    const children = kids.get(n.id);
    const size = leafSize(n, measure, opts.attrRows);
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
      const top = M.instHeaderH + rows.length * M.instRowH + M.instPad;
      e.children = children.map(build);
      e.layoutOptions = {
        'elk.padding': `[top=${top},left=${M.instPad},bottom=${M.instPad},right=${M.instPad}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${size.w},${size.h})`,
      };
    } else {
      e.width = size.w;
      e.height = size.h;
    }
    return e;
  };

  const callById = new Map<string, CallNode>();
  for (const n of model.nodes) if (n.kind === 'call') callById.set(n.id, n);
  const endpoint = (r: GEdge['from']): string => {
    if (r.port === null) return r.node;
    const n = callById.get(r.node);
    const has = n !== undefined && [...n.inPorts, ...n.outPorts].some((p) => p.id === r.port);
    return has ? portKey(r.node, r.port) : r.node;
  };

  const edges: ElkExtendedEdge[] = [];
  for (const ed of model.edges) {
    if (!ids.has(ed.from.node) || !ids.has(ed.to.node)) continue;
    edges.push({ id: ed.id, sources: [endpoint(ed.from)], targets: [endpoint(ed.to)] });
  }

  return {
    id: 'root',
    layoutOptions: { ...ROOT_OPTIONS },
    children: (kids.get(null) ?? []).map(build),
    edges,
  };
}

let elk: InstanceType<typeof ELK> | undefined;

/** Convert ELK's output (child coordinates relative to the parent) to absolute coordinates. */
export function toLaid(
  root: ElkNode,
  model: GraphModel,
  measure: Measure = defaultMeasure,
  attrRows?: Record<string, string[]>,
): Laid {
  const laid: Laid = { width: root.width ?? 0, height: root.height ?? 0, nodes: {}, edges: {} };
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
    laid.edges[e.id] = { points: pts };
  }
  return laid;
}

export async function layout(model: GraphModel, opts: LayoutOptions = {}): Promise<Laid> {
  const measure = opts.measure ?? defaultMeasure;
  const input = buildElkGraph(model, { measure, attrRows: opts.attrRows });
  elk ??= new ELK();
  const out = await elk.layout(input);
  return toLaid(out, model, measure, opts.attrRows);
}
