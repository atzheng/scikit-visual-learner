// EventLog -> GraphModel (CONTRACTS.md section 8, SPEC "Graph construction"). Pure and deterministic.
import type { Event, EventError, EventLog, ImportBinding, Input, Site, Token } from './types';

export interface GraphModel {
  nodes: GNode[];
  edges: GEdge[];
  steps: number[];
  /** Set when the graph was cut at the node cap: the number of boxes it would have had. */
  tooMany?: number;
  /** Set with `tooMany`: what is shown, and the source line of the last box shown. */
  truncated?: { shown: number; total: number; line: number };
  /** Number of unnamed temporaries folded into chips on their wire (`GEdge.chip`). */
  folded?: number;
}
export type GNode = CallNode | InstanceNode | ExprNode | StoreNode | SourceNode | ImportNode;
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
  owner: Token | null;
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
  /**
   * Where the called name was imported from (`sklearn.linear_model` for `LinearRegression`, `pandas` for
   * `pd.read_csv`), when the callee is a bare dotted name whose root has a `sole` import that ran before the
   * call. The box writes `name (module)`. Not a wire: nothing is drawn between the import block and the call.
   */
  importedFrom?: string;
}
export interface InstanceNode extends NodeBase {
  kind: 'instance';
  className: string;
  varName: string | null;
  createdAt: number;
  createdBy: string | null;
  params: { name: string; text: string }[];
  versions: InstanceVersion[];
}
/**
 * `new`: the first version of an object, so a box merged from a loop's objects gets one per pass;
 * `mutate`: a method changed this object in place; `store`: an item/attribute assignment (`df['a'] = 0`) did.
 */
export type VersionKind = 'new' | 'mutate' | 'store';
export interface InstanceVersion {
  i: number;
  token: Token;
  kind: VersionKind;
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
/**
 * A name bound by an import statement that ran (svl-i6s): one node per bound name, placed on the board at the
 * step of the statement, used or not. `name` is the bound name (`pd`, `LinearRegression`); `source` the module
 * it comes from (`pandas`, `sklearn.linear_model`), or null when it is the name itself (`import numpy`). It
 * has no wires. `executions` has one entry per run of the statement (inputs and outputs empty).
 */
export interface ImportNode extends NodeBase {
  kind: 'import';
  name: string;
  source: string | null;
  /** Id of the `import` site the node comes from. */
  site: number;
  executions: Execution[];
}
export interface GEdge {
  id: string;
  from: { node: string; port: string | null };
  to: { node: string; port: string | null };
  dashed: boolean;
  uses: { i: number; token: Token }[];
  nameLabel: string | null;
  /**
   * A folded temporary: an object never bound to a name and used exactly once. The wire runs from the
   * producer straight to its one consumer and carries exactly `token`; `node` is the id the object's box
   * would have (pass it in `buildGraph`'s `unfold` to draw the box instead).
   */
  chip?: { node: string; token: Token; type: string; shape: number[] | null };
}

/**
 * Most boxes one graph draws; later ones (by source order) are cut and `GraphModel.truncated` says so.
 * Measured (svl-lo6): the 98-line pandas program has 460 boxes unfolded (364 folded) and lays out in under
 * 0.7 s. The dense worst case (every box 3 ports, 3 wires, 24 instances with children) takes about 8 s at
 * 600 and 12 s at 700, in the worker, so 600 keeps the worst case under 10 s.
 */
export const MAX_NODES = 600;

/** `pd.read_csv`, `LinearRegression`: a bare dotted name. `pd.read_csv(x).head` and `a[0].f` do not match. */
const CALLEE_ROOT = /^([\p{L}_][\p{L}\p{N}_]*)(?:\.[\p{L}\p{N}_]+)*$/u;

/** Gray text under the name: the module it comes from, unless that is the name itself. */
function importSource(b: ImportBinding): string | null {
  const full = b.attr !== null && b.attr !== b.name ? `${b.module}.${b.attr}` : b.module;
  return full === b.name ? null : full;
}

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
  ctorEvents: Event[]; // constructor events that created this instance (for `params`)
  /** Port of the creating node the creation wire leaves from (null for an expr node); undefined: no creator. */
  createdByPort: string | null | undefined;
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const keyOf = (t: Token): string => (t.startsWith('v') ? t.slice(0, t.indexOf('.')) : t);

export interface BuildOptions {
  /** Expansion of student functions: M4, ignored. */
  expanded?: Set<string>;
  /** Fold unnamed temporaries into chips on their wire (default true). false draws every object as a box. */
  fold?: boolean;
  /** Ids of folded objects (`GEdge.chip.node`) to draw as boxes anyway. */
  unfold?: ReadonlySet<string>;
  /** Node cap (default MAX_NODES); for tests and measurements. */
  maxNodes?: number;
}

export function buildGraph(log: EventLog, opts: BuildOptions = {}): GraphModel {
  const { values, sites } = log;
  const typeOf = (t: Token): string => values[t]?.type ?? '';
  // THE predicate for "this value is drawn as an instance box": it creates the box (via the creating call's
  // output wire), owns method slots keyed by (box, method name), and is wired by its border. Every
  // reference value ("v<obj>.<ver>": DataFrame, Series, array, list, model, student object); scalars
  // ("s<n>") stay port text and wire labels. timeline.ts `ownerAttrs` follows it.
  const isObject = (t: Token | null): boolean => t !== null && t.startsWith('v');

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
  const keysByName = new Map<string, string[]>(); // name -> distinct values bound to it, in time order
  {
    const scope0 = log.scopes.find((s) => s.id === 0);
    for (const [, name, token] of scope0?.bindings ?? []) {
      const k = keyOf(token);
      if (!firstNameByKey.has(k)) firstNameByKey.set(k, name);
      const ks = keysByName.get(name);
      if (!ks) keysByName.set(name, [k]);
      else if (!ks.includes(k)) ks.push(k);
    }
  }
  /**
   * Bound name of a value. Each new value bound to a name gets one more prime, in time order:
   * `df`, `df′`, `df″`, then `df‴` for any later one (a loop rebinds on every pass).
   */
  const nameOf = (t: Token): string | null => {
    const k = keyOf(t);
    const name = firstNameByKey.get(k);
    if (name === undefined) return null;
    const idx = Math.min(keysByName.get(name)?.indexOf(k) ?? 0, 3);
    return name + ['', '′', '″', '‴'][idx];
  };
  const plainNameOf = (t: Token): string | null => firstNameByKey.get(keyOf(t)) ?? null;

  const events = log.events.filter((e) => e.scope === 0);

  // ---- unnamed temporaries to fold (svl-lo6). An object (key) folds only when every one of these holds,
  // so that the chip's wire is exactly the two wires the box would have had, joined:
  //  - no scope binds it to a name, no event mutates it, and it is not a constructed machine;
  //  - exactly one event outputs it, and that event's output slot (site, index) holds no other object;
  //  - exactly one use in the whole log: an input port or the owner of a method call, by a scope-0 event
  //    that is neither an expression read nor before the producer.
  // foldKeys: object key -> id of the box it would have; the creator and consumer are found after pass 1.
  const foldKeys = new Map<string, string>();
  if (opts.fold !== false) {
    const named = new Set<string>();
    for (const sc of log.scopes) for (const [, , t] of sc.bindings) named.add(keyOf(t));
    const producedBy = new Map<string, Event[]>();
    const slotObjs = new Map<string, Set<string>>();
    const useCount = new Map<string, number>();
    const useEvent = new Map<string, Event>();
    const touched = new Set<string>();
    for (const e of log.events) {
      e.outputs.forEach((t, k) => {
        if (!isObject(t)) return;
        const key = keyOf(t);
        producedBy.set(key, [...(producedBy.get(key) ?? []), e]);
        if (e.scope !== 0) return;
        const slot = `${e.merge_key}#${k}`;
        const set = slotObjs.get(slot) ?? new Set<string>();
        slotObjs.set(slot, set);
        set.add(key);
      });
      for (const [b, a] of e.mutates) {
        touched.add(keyOf(b));
        touched.add(keyOf(a));
      }
      const owner = e.kind === 'method' && e.owner !== null && isObject(e.owner) ? e.owner : null;
      for (const x of e.inputs) {
        if (x.value === undefined || !isObject(x.value)) continue;
        if (owner !== null && x.param === 'self' && x.value === owner) continue;
        const key = keyOf(x.value);
        useCount.set(key, (useCount.get(key) ?? 0) + 1);
        useEvent.set(key, e);
      }
      if (owner !== null) {
        const key = keyOf(owner);
        useCount.set(key, (useCount.get(key) ?? 0) + 1);
        useEvent.set(key, e);
      }
    }
    for (const [key, made] of producedBy) {
      const c = made[0]!;
      const u = useEvent.get(key);
      if (made.length !== 1 || c.scope !== 0 || c.kind === 'constructor') continue;
      if (named.has(key) || touched.has(key) || useCount.get(key) !== 1) continue;
      if (u === undefined || u.scope !== 0 || u.kind === 'expr' || u.i <= c.i) continue;
      const k = c.outputs.findIndex((t) => keyOf(t) === key);
      if (k < 0 || slotObjs.get(`${c.merge_key}#${k}`)?.size !== 1) continue;
      const id = `i:${baseFor(c.merge_key, c.site)}${k > 0 ? `#${k}` : ''}`;
      if (!opts.unfold?.has(id)) foldKeys.set(key, id);
    }
  }

  // ---- import bindings that nothing can have rebound (the transformer's `sole` flag)
  const soleImports = new Map<string, { site: Site; binding: ImportBinding }>();
  const importRanAt = new Map<number, number>(); // import site -> i of its first execution
  const importSubmodules = new Map<number, string[]>(); // import site -> `submodules` of its first execution
  for (const s of sites)
    for (const b of s.imports ?? [])
      if (s.kind === 'import' && b.sole && !soleImports.has(b.name))
        soleImports.set(b.name, { site: s, binding: b });

  const importNodes = new Map<string, ImportNode>();
  const calls = new Map<string, CallInfo>();
  const mkCounts = new Map<string, Map<string, number>>(); // merge key -> method box id -> recorded executions
  const siteCounts = new Map<string, Map<string, number>>(); // method box id -> merge key -> latest count
  const plains = new Map<string, PlainInfo>();
  const insts = new Map<string, InstInfo>(); // by instance key (merge key + output index)
  const instByObj = new Map<string, InstInfo>();
  const producers = new Map<Token, Ref>();
  const producerAt = new Map<Token, number>(); // event index of the producing event
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
    owner: e.owner,
    error: e.error,
    interrupted: e.interrupted === true,
  });

  const newInstance = (
    key: string,
    e: Event,
    token: Token,
    createdBy: string | null,
    createdByPort: string | null | undefined,
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
        undefined,
        `${baseFor(at.merge_key, at.site)}!${k}`,
      );
      info.node.versions.push({ i: at.i, token, kind: 'new' });
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
    info.node.versions.push({ i, token, kind: 'new' });
  };

  // ---- pass 1: nodes, executions, producers
  for (const e of events) {
    const mk = e.merge_key;
    const wired = e.inputs.filter((x): x is Input & { value: Token } => x.value !== undefined);

    if (e.kind === 'import') {
      // one block per bound name, all revealed at this step (no wires, no values)
      if (!importRanAt.has(e.site)) {
        importRanAt.set(e.site, e.i);
        importSubmodules.set(e.site, e.submodules ?? []);
      }
      (sites[e.site]?.imports ?? []).forEach((b, k) => {
        const id = `m:${siteIdBase[e.site]}.${hash(b.name)}`;
        let node = importNodes.get(id);
        if (!node) {
          node = {
            id,
            kind: 'import',
            parent: null,
            order: orderOf(e.site) + k * 0.01,
            name: b.name,
            source: importSource(b),
            site: e.site,
            executions: [],
          };
          importNodes.set(id, node);
          nodeOrder.push(node);
        }
        node.executions.push(makeExecution(e, {}, {}));
      });
      continue;
    }

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
        if (isObject(t)) outputInstance(e, t, k, info!.node.id, null);
        else if (!producers.has(t)) {
          producers.set(t, { node: info!.node.id, port: null });
          producerAt.set(t, e.i);
        }
      });
      info.node.executions.push(makeExecution(e, ins, outs));
      info.node.text = e.name;
      info.events.push(e);
      processMutates(e);
      if (e.kind === 'store') processStore(e);
      continue;
    }

    // call node
    const ownerInst =
      e.kind === 'method' && e.owner !== null && isObject(e.owner)
        ? instanceFor(e.owner, e).node
        : null;
    // one method box per (instance, method name), not per call site
    const callKey = ownerInst ? `m:${e.name}@${ownerInst.id}` : mk;
    let info = calls.get(callKey);
    if (!info) {
      const node: CallNode = {
        id: ownerInst ? `n:m${hash(e.name)}@${ownerInst.id}` : `n:${baseFor(mk, e.site)}`,
        kind: 'call',
        mergeKey: mk,
        name: e.name,
        module: e.module,
        parent: ownerInst ? ownerInst.id : null,
        order: orderOf(e.site),
        executions: [],
        inPorts: [],
        outPorts: [],
        student: e.kind === 'student_function',
      };
      info = { node, events: [] };
      calls.set(callKey, info);
      nodeOrder.push(node);
    } else if (info.events.every((x) => x.interrupted === true) && e.interrupted !== true) {
      info.node.name = e.name;
      info.node.module = e.module;
      info.node.student = e.kind === 'student_function';
    }
    if (ownerInst) info.node.order = Math.min(info.node.order, orderOf(e.site));
    // The recorder counts per call site, over every owner. A method box counts its own executions per
    // site (this event's count less other boxes' recorded executions there) and adds the sites up.
    let nodeCount = e.count;
    if (ownerInst) {
      const perNode = mkCounts.get(mk) ?? new Map<string, number>();
      mkCounts.set(mk, perNode);
      let others = 0;
      for (const [id, n] of perNode) if (id !== info.node.id) others += n;
      perNode.set(info.node.id, (perNode.get(info.node.id) ?? 0) + 1);
      const sc = siteCounts.get(info.node.id) ?? new Map<string, number>();
      siteCounts.set(info.node.id, sc);
      sc.set(mk, Math.max(1, e.count - others));
      nodeCount = 0;
      for (const n of sc.values()) nodeCount += n;
    }
    const ins: Record<string, Token> = {};
    for (const x of drawnInputs(e)) if (x.value !== undefined) ins[`in:${x.param}`] = x.value;
    const outs: Record<string, Token> = {};
    e.outputs.forEach((t, k) => {
      const port = `out:${k}`;
      outs[port] = t;
      if (isObject(t)) outputInstance(e, t, k, info!.node.id, port);
      else if (!producers.has(t)) {
        producers.set(t, { node: info!.node.id, port });
        producerAt.set(t, e.i);
      }
    });
    e.mutates.forEach(([before, after], k) => {
      if (isObject(before)) return;
      const input = drawnInputs(e).find((x) => x.value === before);
      const port = `out:mut:${input ? input.param : k}`;
      outs[port] = after;
      producers.set(after, { node: info!.node.id, port });
      producerAt.set(after, e.i);
    });
    info.node.executions.push({ ...makeExecution(e, ins, outs), count: nodeCount });
    info.events.push(e);
    processMutates(e);
  }

  /**
   * An object output of event `e` (output `k`, left by `creator` through `port`) lands in the instance box of
   * its call site and output index (one box per site, so a loop's objects share a box). An object that already
   * has a box (the call returned its argument, a lookup returned a known object) gets no new box and no wire:
   * a missing wire is acceptable, a false one is not.
   */
  function outputInstance(
    e: Event,
    t: Token,
    k: number,
    creator: string,
    port: string | null,
  ): void {
    const ik = `${e.merge_key}#${k}`;
    let ii = insts.get(ik);
    if (!ii) {
      if (instByObj.has(keyOf(t))) return;
      ii = newInstance(
        ik,
        e,
        t,
        creator,
        port,
        k > 0 ? `${baseFor(e.merge_key, e.site)}#${k}` : undefined,
      );
    } else ii.node.createdAt = Math.min(ii.node.createdAt, e.i);
    if (e.kind === 'constructor' && k === 0) ii.ctorEvents.push(e);
    if (!instByObj.has(keyOf(t))) registerObj(ii, t, e.i);
  }

  /** Inputs drawn as ports: a machine owner is not a port; a data method gets `self`. */
  function drawnInputs(e: Event): Input[] {
    let ins = e.inputs;
    if (e.kind === 'method' && e.owner !== null) {
      if (isObject(e.owner)) {
        // the owner of a folded temporary is its method's own `self` port (the object has no box)
        if (foldKeys.has(keyOf(e.owner))) {
          if (!ins.some((x) => x.param === 'self'))
            ins = [{ param: 'self', origin: 'name', value: e.owner }, ...ins];
        } else ins = ins.filter((x) => !(x.param === 'self' && x.value === e.owner));
      } else if (!ins.some((x) => x.param === 'self'))
        ins = [{ param: 'self', origin: 'name', value: e.owner }, ...ins];
    }
    return ins;
  }

  function processMutates(e: Event): void {
    for (const [before, after] of e.mutates) {
      if (!isObject(before)) continue;
      const inst = instanceFor(before, e);
      const last = inst.node.versions[inst.node.versions.length - 1];
      if (!last || last.token !== after || last.i !== e.i)
        inst.node.versions.push({ i: e.i, token: after, kind: 'mutate' });
    }
  }

  /** A store's output is a forced new version of an object that already has a box: add it to that box. */
  function processStore(e: Event): void {
    for (const t of e.outputs) {
      if (!isObject(t)) continue;
      const inst = instByObj.get(keyOf(t));
      if (!inst) continue;
      if (inst.node.versions.some((v) => v.token === t)) continue;
      inst.node.versions.push({ i: e.i, token: t, kind: 'store' });
    }
  }

  // ---- folded temporaries: the object has no box; the method it owns (if any) stands alone
  const foldedBoxes = new Set<string>();
  for (const key of foldKeys.keys()) {
    // every folded object was output by exactly one scope-0 event, so its box has a creator and a port
    const info = instByObj.get(key);
    if (info) foldedBoxes.add(info.node.id);
  }
  for (const info of calls.values())
    if (info.node.parent !== null && foldedBoxes.has(info.node.parent)) info.node.parent = null;

  // ---- pass 2: edges and sources
  const retOf = new Map<number, number>(events.map((e) => [e.i, e.ret]));
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

  /** The wire of a folded temporary: from the node that made it straight to the consumer, carrying its token. */
  const addChipEdge = (token: Token, to: Ref, i: number): void => {
    const info = instByObj.get(keyOf(token))!;
    const id = `f:${info.node.id}`;
    edges.set(id, {
      id,
      from: { node: info.node.createdBy!, port: info.createdByPort! },
      to,
      dashed: false,
      uses: [{ i, token }],
      nameLabel: null,
      chip: {
        node: info.node.id,
        token,
        type: typeOf(token),
        shape: values[token]?.shape ?? null,
      },
    });
  };

  const resolve = (
    token: Token,
    e: Event,
    consumer: string,
    param: string,
  ): { ref: Ref; source: boolean } => {
    if (isObject(token))
      return { ref: { node: instanceFor(token, e).node.id, port: null }, source: false };
    const p = producers.get(token);
    // a producer only counts for consumers that ran after it: an earlier use is a source
    if (p && (producerAt.get(token) ?? -1) < e.i) return { ref: p, source: false };
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

  // ---- the module a call's name was imported from (never guessed: only a `sole` binding, a call that comes
  // textually after the import statement, and an import that ran before the call). Shown in the call box.
  for (const info of calls.values()) {
    if (info.node.parent !== null) continue; // a method of a machine: its owner is the callee
    for (const e of info.events) {
      const site = sites[e.site];
      const root = site?.func_text === undefined ? null : CALLEE_ROOT.exec(site.func_text)?.[1];
      const hit = root ? soleImports.get(root) : undefined;
      if (!site || !hit) continue;
      const at = hit.site;
      if (site.line < at.end_line || (site.line === at.end_line && site.col < at.end_col)) continue;
      const ran = importRanAt.get(at.id);
      if (ran === undefined || ran > e.i) continue;
      const b = hit.binding;
      // A binding that is a module for certain (`import a.b.c`, or a `from m import a` that bound
      // the submodule `m.a`, as the recorder saw) names the full module. For `import a.b.c` that is
      // the longest prefix the callee's qualifier shares with `a.b.c`; whatever follows may be an
      // attribute, not a module.
      if (b.dotted !== undefined) {
        const q = (site.func_text ?? '').split('.').slice(0, -1);
        const d = b.dotted.split('.');
        let n = 0;
        while (n < q.length && n < d.length && q[n] === d[n]) n++;
        info.node.importedFrom = d.slice(0, Math.max(n, 1)).join('.');
        break;
      }
      if (b.attr !== null && importSubmodules.get(at.id)?.includes(b.name)) {
        info.node.importedFrom = `${b.module}.${b.attr}`;
        break;
      }
      const src = importSource(b) ?? b.name;
      const tail = `.${info.node.name}`;
      info.node.importedFrom = src.endsWith(tail) ? src.slice(0, -tail.length) : src;
      break;
    }
  }

  for (const info of calls.values()) {
    for (const e of info.events) {
      for (const x of drawnInputs(e)) {
        if (x.value === undefined) continue;
        if (isObject(x.value) && foldKeys.has(keyOf(x.value))) {
          addChipEdge(x.value, { node: info.node.id, port: `in:${x.param}` }, e.i);
          continue;
        }
        const { ref, source } = resolve(x.value, e, info.node.id, x.param);
        addEdge(
          ref,
          { node: info.node.id, port: `in:${x.param}` },
          { i: e.i, token: x.value },
          source || isObject(x.value) ? null : nameOf(x.value),
          false,
        );
      }
    }
  }
  for (const info of plains.values()) {
    for (const e of info.events) {
      for (const x of e.inputs) {
        if (x.value === undefined) continue;
        if (isObject(x.value) && foldKeys.has(keyOf(x.value))) {
          addChipEdge(x.value, { node: info.node.id, port: null }, e.i);
          continue;
        }
        const { ref, source } = resolve(x.value, e, info.node.id, x.param);
        addEdge(
          ref,
          { node: info.node.id, port: null },
          { i: e.i, token: x.value },
          source || isObject(x.value) ? null : nameOf(x.value),
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
    if (node.createdBy !== null && info.createdByPort !== undefined && !foldedBoxes.has(node.id)) {
      const tok = node.versions[0]?.token;
      if (tok !== undefined)
        addEdge(
          { node: node.createdBy, port: info.createdByPort },
          { node: node.id, port: null },
          // the wire to the instance exists once its creator has returned
          { i: retOf.get(node.createdAt) ?? node.createdAt, token: tok },
          null,
          false,
        );
    }
    node.varName = null;
    for (const v of node.versions) {
      const n = nameOf(v.token); // a loop's objects share the box: it takes the first one's name
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
        // an object's box shows its type and shape: the port keeps only the name
        if (x.value !== undefined) port.typeLabel = isObject(x.value) ? '' : typeOf(x.value);
        else if (x.text !== undefined) port.constText = `${x.param} = ${x.text}`;
        inPorts.set(id, port);
      }
      e.outputs.forEach((t, k) => {
        const id = `out:${k}`;
        outPorts.set(id, {
          id,
          param: `${k}`,
          typeLabel: isObject(t) ? '' : typeOf(t),
          // an object's port carries its box's name (a loop's objects share one box and one name)
          nameLabel: (isObject(t) ? instByObj.get(keyOf(t))?.node.varName : null) ?? nameOf(t),
        });
      });
      e.mutates.forEach(([before, after], k) => {
        if (isObject(before)) return;
        const input = drawnInputs(e).find((x) => x.value === before);
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
    n.kind === 'expr'
      ? live.has(n.id)
      : foldedBoxes.has(n.id)
        ? false
        : n.kind === 'source'
          ? connected.has(n.id)
          : true,
  );

  // ---- truncate to MAX_NODES by source order
  let tooMany: number | undefined;
  nodes = nodes
    .map((n, idx) => ({ n, idx }))
    .sort((a, b) => a.n.order - b.n.order || a.idx - b.idx)
    .map((x) => x.n);
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  let truncated: GraphModel['truncated'];
  if (nodes.length > maxNodes) {
    tooMany = nodes.length;
    nodes = nodes.slice(0, maxNodes);
    truncated = {
      shown: nodes.length,
      total: tooMany,
      // sources sort a fraction before their site: round the half up, not down a line
      line: Math.floor(((nodes[nodes.length - 1]?.order ?? 0) + 0.5) / 100000),
    };
    const kept = new Set(nodes.map((n) => n.id));
    for (const n of nodes) if (n.parent !== null && !kept.has(n.parent)) n.parent = null;
    keptEdges = keptEdges.filter((ed) => kept.has(ed.from.node) && kept.has(ed.to.node));
  }

  // ---- steps: every drawn execution and every instance version
  const stepSet = new Set<number>();
  for (const n of nodes) {
    if (n.kind === 'call' || n.kind === 'expr' || n.kind === 'store' || n.kind === 'import')
      for (const x of n.executions) stepSet.add(x.i);
    else if (n.kind === 'instance') for (const v of n.versions) stepSet.add(v.i);
  }
  const model: GraphModel = { nodes, edges: keptEdges, steps: [...stepSet].sort((a, b) => a - b) };
  if (tooMany !== undefined) model.tooMany = tooMany;
  if (truncated) model.truncated = truncated;
  if (foldedBoxes.size > 0) model.folded = foldedBoxes.size;
  return model;
}
