// EventLog -> GraphModel (CONTRACTS.md section 8, SPEC "Graph construction"). Pure and deterministic.
import type { Event, EventError, EventLog, Input, Token } from './types';

export interface GraphModel {
  nodes: GNode[];
  edges: GEdge[];
  steps: number[];
  tooMany?: number;
}
export type GNode = CallNode | InstanceNode | ExprNode | StoreNode | SourceNode;
export interface NodeBase {
  id: string;
  parent: string | null;
  order: number;
}
export interface Execution {
  i: number;
  ret: number;
  inputs: Record<string, Token>;
  outputs: Record<string, Token>;
  count: number;
  error: EventError | null;
  interrupted: boolean;
}
export interface Port {
  id: string;
  param: string;
  typeLabel: string;
  nameLabel: string | null;
  constText?: string;
  changedInPlace?: boolean;
}
export interface CallNode extends NodeBase {
  kind: 'call';
  mergeKey: string;
  name: string;
  module: string | null;
  executions: Execution[];
  inPorts: Port[];
  outPorts: Port[];
  student: boolean;
}
export interface InstanceNode extends NodeBase {
  kind: 'instance';
  className: string;
  varName: string | null;
  createdAt: number;
  createdBy: string | null;
  params: { name: string; text: string }[];
  versions: { i: number; token: Token }[];
}
export interface ExprNode extends NodeBase {
  kind: 'expr';
  text: string;
  executions: Execution[];
}
export interface StoreNode extends NodeBase {
  kind: 'store';
  text: string;
  executions: Execution[];
}
export interface SourceNode extends NodeBase {
  kind: 'source';
  label: string;
  token: Token;
}
export interface GEdge {
  id: string;
  from: { node: string; port: string | null };
  to: { node: string; port: string | null };
  dashed: boolean;
  uses: { i: number; token: Token }[];
  nameLabel: string | null;
}

export const MAX_NODES = 300;

interface Ref {
  node: string;
  port: string | null;
}

// Internal per-node scratch data.
interface CallInfo {
  node: CallNode;
  events: Event[];
}
interface PlainInfo {
  node: ExprNode | StoreNode;
  events: Event[];
}
interface InstInfo {
  node: InstanceNode;
  objs: string[]; // object keys ("v12") mapped to this instance, in order
  ctorEvents: Event[];
  createdByPort: string | null;
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const keyOf = (t: Token): string => (t.startsWith('v') ? t.slice(0, t.indexOf('.')) : t);

export function buildGraph(log: EventLog, _opts?: { expanded?: Set<string> }): GraphModel {
  void _opts; // expansion of student functions is M4
  const { values, sites } = log;
  const typeOf = (t: Token): string => values[t]?.type ?? '';
  const isMachine = (t: Token | null): boolean => t !== null && values[t]?.machine === true;

  // ---- stable ids: hash of the site's text plus the occurrence number among equal texts
  const siteIdBase: string[] = [];
  {
    const seen = new Map<string, number>();
    for (const s of sites) {
      const sig = `${s.kind}|${s.text}`;
      const occ = seen.get(sig) ?? 0;
      seen.set(sig, occ + 1);
      siteIdBase[s.id] = `${hash(sig)}.${occ}`;
    }
  }
  const baseFor = (mk: string, site: number): string => {
    const m = /^s\d+(.*)$/.exec(mk);
    const suffix = m && m[1] ? m[1] : '';
    return (siteIdBase[site] ?? `x${site}`) + (suffix ? `~${hash(suffix)}` : '');
  };
  const orderOf = (site: number): number => {
    const s = sites[site];
    return s ? s.line * 100000 + s.col : 0;
  };

  // ---- names (scope 0 bindings)
  const firstNameByKey = new Map<string, string>();
  const lastKeyByName = new Map<string, string>();
  {
    const scope0 = log.scopes.find((s) => s.id === 0);
    for (const [, name, token] of scope0?.bindings ?? []) {
      const k = keyOf(token);
      if (!firstNameByKey.has(k)) firstNameByKey.set(k, name);
      lastKeyByName.set(name, k);
    }
  }
  /** Bound name of a value; a name since rebound to a different value gets a prime. */
  const nameOf = (t: Token): string | null => {
    const k = keyOf(t);
    const name = firstNameByKey.get(k);
    if (name === undefined) return null;
    return lastKeyByName.get(name) === k ? name : `${name}′`;
  };
  const plainNameOf = (t: Token): string | null => firstNameByKey.get(keyOf(t)) ?? null;

  const events = log.events.filter((e) => e.scope === 0);

  const calls = new Map<string, CallInfo>();
  const plains = new Map<string, PlainInfo>();
  const insts = new Map<string, InstInfo>(); // by instance key (merge key + output index)
  const instByObj = new Map<string, InstInfo>();
  const producers = new Map<Token, Ref>();
  const nodeOrder: GNode[] = [];

  const makeExecution = (
    e: Event,
    inputs: Record<string, Token>,
    outputs: Record<string, Token>,
  ): Execution => ({
    i: e.i,
    ret: e.ret,
    inputs,
    outputs,
    count: e.count,
    error: e.error,
    interrupted: e.interrupted === true,
  });

  const newInstance = (
    key: string,
    e: Event,
    token: Token,
    createdBy: string | null,
    createdByPort: string | null,
    idBase?: string,
  ): InstInfo => {
    const node: InstanceNode = {
      id: `i:${idBase ?? baseFor(e.merge_key, e.site)}`,
      kind: 'instance',
      parent: null,
      order: orderOf(e.site),
      className: typeOf(token),
      varName: null,
      createdAt: e.i,
      createdBy,
      params: [],
      versions: [],
    };
    const info: InstInfo = { node, objs: [], ctorEvents: [], createdByPort };
    insts.set(key, info);
    nodeOrder.push(node);
    return info;
  };

  /** Instance for a machine token; created lazily (no producing event) when unseen. */
  const instanceFor = (token: Token, at: Event): InstInfo => {
    const k = keyOf(token);
    let info = instByObj.get(k);
    if (!info) {
      info = newInstance(
        `lazy:${k}`,
        at,
        token,
        null,
        null,
        `${baseFor(at.merge_key, at.site)}!${k}`,
      );
      info.node.versions.push({ i: at.i, token });
      info.objs.push(k);
      instByObj.set(k, info);
    }
    return info;
  };

  const registerObj = (info: InstInfo, token: Token, i: number): void => {
    const k = keyOf(token);
    if (!instByObj.has(k)) {
      instByObj.set(k, info);
      info.objs.push(k);
    }
    info.node.versions.push({ i, token });
  };

  // ---- pass 1: nodes, executions, producers
  for (const e of events) {
    const mk = e.merge_key;
    const wired = e.inputs.filter((x): x is Input & { value: Token } => x.value !== undefined);

    if (e.kind === 'expr' || e.kind === 'store') {
      let info = plains.get(mk);
      if (!info) {
        const node: ExprNode | StoreNode = {
          id: `${e.kind === 'expr' ? 'x' : 't'}:${baseFor(mk, e.site)}`,
          kind: e.kind,
          parent: null,
          order: orderOf(e.site),
          text: e.name,
          executions: [],
        };
        info = { node, events: [] };
        plains.set(mk, info);
        nodeOrder.push(node);
      }
      const ins: Record<string, Token> = {};
      for (const x of wired) ins[`in:${x.param}`] = x.value;
      const outs: Record<string, Token> = {};
      e.outputs.forEach((t, k) => {
        outs[`out:${k}`] = t;
        if (!producers.has(t)) producers.set(t, { node: info!.node.id, port: null });
      });
      info.node.executions.push(makeExecution(e, ins, outs));
      info.node.text = e.name;
      info.events.push(e);
      processMutates(e);
      continue;
    }

    // constructor of a machine: becomes an instance node with params
    if (
      e.kind === 'constructor' &&
      e.error === null &&
      e.outputs.length >= 1 &&
      isMachine(e.outputs[0] ?? null)
    ) {
      const token = e.outputs[0] as Token;
      const key = `${mk}#0`;
      let info = insts.get(key);
      if (!info) info = newInstance(key, e, token, null, null);
      info.node.createdAt = Math.min(info.node.createdAt, e.i);
      info.node.className = typeOf(token);
      info.ctorEvents.push(e);
      registerObj(info, token, e.i);
      processMutates(e);
      continue;
    }

    // call node
    let info = calls.get(mk);
    if (!info) {
      const node: CallNode = {
        id: `n:${baseFor(mk, e.site)}`,
        kind: 'call',
        mergeKey: mk,
        name: e.name,
        module: e.module,
        parent: null,
        order: orderOf(e.site),
        executions: [],
        inPorts: [],
        outPorts: [],
        student: e.kind === 'student_function',
      };
      if (e.kind === 'method' && e.owner !== null && isMachine(e.owner)) {
        node.parent = instanceFor(e.owner, e).node.id;
      }
      info = { node, events: [] };
      calls.set(mk, info);
      nodeOrder.push(node);
    } else if (info.events.every((x) => x.interrupted === true) && e.interrupted !== true) {
      info.node.name = e.name;
      info.node.module = e.module;
      info.node.student = e.kind === 'student_function';
    }
    const ins: Record<string, Token> = {};
    for (const x of drawnInputs(e)) if (x.value !== undefined) ins[`in:${x.param}`] = x.value;
    const outs: Record<string, Token> = {};
    e.outputs.forEach((t, k) => {
      const port = `out:${k}`;
      outs[port] = t;
      if (isMachine(t)) {
        if (!instByObj.has(keyOf(t))) {
          const ii = newInstance(
            `${mk}#${k}`,
            e,
            t,
            info!.node.id,
            port,
            k > 0 ? `${baseFor(mk, e.site)}#${k}` : undefined,
          );
          registerObj(ii, t, e.i);
        }
      } else if (!producers.has(t)) {
        producers.set(t, { node: info!.node.id, port });
      }
    });
    e.mutates.forEach(([before, after], k) => {
      if (isMachine(before)) return;
      const input = e.inputs.find((x) => x.value === before);
      const port = `out:mut:${input ? input.param : k}`;
      outs[port] = after;
      producers.set(after, { node: info!.node.id, port });
    });
    info.node.executions.push(makeExecution(e, ins, outs));
    info.events.push(e);
    processMutates(e);
  }

  /** Inputs drawn as ports: a machine owner is not a port; a data method gets `self`. */
  function drawnInputs(e: Event): Input[] {
    let ins = e.inputs;
    if (e.kind === 'method' && e.owner !== null) {
      if (isMachine(e.owner)) ins = ins.filter((x) => !(x.param === 'self' && x.value === e.owner));
      else if (!ins.some((x) => x.param === 'self'))
        ins = [{ param: 'self', origin: 'name', value: e.owner }, ...ins];
    }
    return ins;
  }

  function processMutates(e: Event): void {
    for (const [before, after] of e.mutates) {
      if (!isMachine(before)) continue;
      const inst = instanceFor(before, e);
      const last = inst.node.versions[inst.node.versions.length - 1];
      if (!last || last.token !== after || last.i !== e.i)
        inst.node.versions.push({ i: e.i, token: after });
    }
  }

  // ---- pass 2: edges and sources
  const edges = new Map<string, GEdge>();
  const sources = new Map<string, SourceNode>(); // by consumer+param
  const sourceOfToken = new Map<Token, SourceNode>();

  const addEdge = (
    from: Ref,
    to: Ref,
    use: { i: number; token: Token },
    nameLabel: string | null,
    dashed: boolean,
  ): void => {
    const id = `e:${from.node}.${from.port ?? ''}>${to.node}.${to.port ?? ''}`;
    let edge = edges.get(id);
    if (!edge) {
      edge = { id, from, to, dashed, uses: [], nameLabel: null };
      edges.set(id, edge);
    }
    edge.uses.push(use);
    edge.nameLabel = nameLabel;
  };

  const resolve = (
    token: Token,
    e: Event,
    consumer: string,
    param: string,
  ): { ref: Ref; source: boolean } => {
    if (isMachine(token))
      return { ref: { node: instanceFor(token, e).node.id, port: null }, source: false };
    const p = producers.get(token);
    if (p) return { ref: p, source: false };
    let src = sourceOfToken.get(token);
    if (!src) {
      const key = `${consumer}:${param}`;
      src = sources.get(key);
      if (!src) {
        src = {
          id: `src:${key}`,
          kind: 'source',
          parent: null,
          order: orderOf(e.site) - 0.5,
          label: '',
          token,
        };
        sources.set(key, src);
        nodeOrder.push(src);
      }
      sourceOfToken.set(token, src);
    }
    src.token = token;
    src.label = plainNameOf(token) ?? typeOf(token) ?? token;
    return { ref: { node: src.id, port: null }, source: true };
  };

  for (const info of calls.values()) {
    for (const e of info.events) {
      for (const x of drawnInputs(e)) {
        if (x.value === undefined) continue;
        const { ref, source } = resolve(x.value, e, info.node.id, x.param);
        addEdge(
          ref,
          { node: info.node.id, port: `in:${x.param}` },
          { i: e.i, token: x.value },
          source || isMachine(x.value) ? null : nameOf(x.value),
          false,
        );
      }
    }
  }
  for (const info of plains.values()) {
    for (const e of info.events) {
      for (const x of e.inputs) {
        if (x.value === undefined) continue;
        const { ref, source } = resolve(x.value, e, info.node.id, x.param);
        addEdge(
          ref,
          { node: info.node.id, port: null },
          { i: e.i, token: x.value },
          source || isMachine(x.value) ? null : nameOf(x.value),
          info.node.kind === 'expr',
        );
      }
    }
  }
  for (const info of insts.values()) {
    const node = info.node;
    const last = info.ctorEvents[info.ctorEvents.length - 1];
    if (last) {
      node.params = [];
      for (const x of last.inputs) {
        if (x.value === undefined) {
          if (x.text !== undefined) node.params.push({ name: x.param, text: x.text });
        } else if (x.value.startsWith('s')) {
          node.params.push({
            name: x.param,
            text: x.text ?? values[x.value]?.repr ?? typeOf(x.value),
          });
        } else {
          node.params.push({ name: x.param, text: typeOf(x.value) });
        }
      }
    }
    for (const e of info.ctorEvents) {
      for (const x of e.inputs) {
        if (x.value === undefined || x.value.startsWith('s')) continue;
        const { ref, source } = resolve(x.value, e, node.id, x.param);
        addEdge(
          ref,
          { node: node.id, port: null },
          { i: e.i, token: x.value },
          source || isMachine(x.value) ? null : nameOf(x.value),
          false,
        );
      }
    }
    if (node.createdBy !== null && info.createdByPort !== null) {
      const tok = node.versions[0]?.token;
      if (tok !== undefined)
        addEdge(
          { node: node.createdBy, port: info.createdByPort },
          { node: node.id, port: null },
          { i: node.createdAt, token: tok },
          null,
          false,
        );
    }
    node.varName = null;
    for (const v of node.versions) {
      const n = plainNameOf(v.token);
      if (n !== null) {
        node.varName = n;
        break;
      }
    }
    node.versions.sort((a, b) => a.i - b.i);
  }

  // ---- ports for call nodes
  for (const info of calls.values()) {
    const inPorts = new Map<string, Port>();
    const outPorts = new Map<string, Port>();
    for (const e of info.events) {
      for (const x of drawnInputs(e)) {
        const id = `in:${x.param}`;
        const port: Port = { id, param: x.param, typeLabel: '', nameLabel: null };
        if (x.value !== undefined) port.typeLabel = typeOf(x.value);
        else if (x.text !== undefined) port.constText = `${x.param} = ${x.text}`;
        inPorts.set(id, port);
      }
      e.outputs.forEach((t, k) => {
        const id = `out:${k}`;
        outPorts.set(id, { id, param: `${k}`, typeLabel: typeOf(t), nameLabel: nameOf(t) });
      });
      e.mutates.forEach(([before, after], k) => {
        if (isMachine(before)) return;
        const input = e.inputs.find((x) => x.value === before);
        const param = input ? input.param : `${k}`;
        const id = `out:mut:${param}`;
        outPorts.set(id, {
          id,
          param,
          typeLabel: typeOf(after),
          nameLabel: nameOf(after),
          changedInPlace: true,
        });
      });
    }
    info.node.inPorts = [...inPorts.values()];
    info.node.outPorts = [...outPorts.values()];
  }

  // ---- drop expr nodes that reach no call/store/instance node (transitively); then orphan sources
  const allEdges = [...edges.values()];
  const live = new Set<string>();
  const incoming = new Map<string, string[]>();
  for (const ed of allEdges) {
    const l = incoming.get(ed.to.node);
    if (l) l.push(ed.from.node);
    else incoming.set(ed.to.node, [ed.from.node]);
  }
  const queue: string[] = [];
  for (const n of nodeOrder) {
    if (n.kind !== 'expr') {
      live.add(n.id);
      queue.push(n.id);
    }
  }
  const exprIds = new Set(nodeOrder.filter((n) => n.kind === 'expr').map((n) => n.id));
  while (queue.length > 0) {
    const n = queue.pop() as string;
    for (const f of incoming.get(n) ?? []) {
      if (exprIds.has(f) && !live.has(f)) {
        live.add(f);
        queue.push(f);
      }
    }
  }
  for (const ed of allEdges) ed.dashed = exprIds.has(ed.from.node) || exprIds.has(ed.to.node);
  let keptEdges = allEdges.filter((ed) => live.has(ed.from.node) && live.has(ed.to.node));
  const connected = new Set<string>();
  for (const ed of keptEdges) {
    connected.add(ed.from.node);
    connected.add(ed.to.node);
  }
  let nodes = nodeOrder.filter((n) =>
    n.kind === 'expr' ? live.has(n.id) : n.kind === 'source' ? connected.has(n.id) : true,
  );

  // ---- truncate to MAX_NODES by source order
  let tooMany: number | undefined;
  nodes = nodes
    .map((n, idx) => ({ n, idx }))
    .sort((a, b) => a.n.order - b.n.order || a.idx - b.idx)
    .map((x) => x.n);
  if (nodes.length > MAX_NODES) {
    tooMany = nodes.length;
    nodes = nodes.slice(0, MAX_NODES);
    const kept = new Set(nodes.map((n) => n.id));
    for (const n of nodes) if (n.parent !== null && !kept.has(n.parent)) n.parent = null;
    keptEdges = keptEdges.filter((ed) => kept.has(ed.from.node) && kept.has(ed.to.node));
  }

  // ---- steps: every drawn execution and every instance version
  const stepSet = new Set<number>();
  for (const n of nodes) {
    if (n.kind === 'call' || n.kind === 'expr' || n.kind === 'store')
      for (const x of n.executions) stepSet.add(x.i);
    else if (n.kind === 'instance') for (const v of n.versions) stepSet.add(v.i);
  }
  const model: GraphModel = { nodes, edges: keptEdges, steps: [...stepSet].sort((a, b) => a - b) };
  if (tooMany !== undefined) model.tooMany = tooMany;
  return model;
}
