// Stage model (CONTRACTS.md section 8, svl-61q.1): which objects take part in the current step, and the
// order of the shelf. Pure: (model, log, step) -> StageModel. No layout, no DOM, no animation.
import { keyOf } from './graph';
import type { Execution, GEdge, GNode, GraphModel, InstanceNode, InstanceVersion } from './graph';
import { stateAt } from './timeline';
import type { EventError, EventLog, Token } from './types';

export type StageRole = 'owner' | 'input' | 'output' | 'created';

/**
 * An object that takes part in the step. `kind: 'instance'` is a shelf object (`node` is its instance box);
 * `kind: 'import'` is an import block (created by an import step); `kind: 'chip'` is a folded temporary: it
 * has no box and never lives on the shelf, the stage draws it only for this step (`chip`).
 */
export interface StageParticipant {
  kind: 'instance' | 'import' | 'chip';
  role: StageRole;
  /** Instance or import node id; for a chip, the id its box would have (`GEdge.chip.node`). */
  node: string;
  /** The object the step used or made (`v12`); null for an import block. */
  object: string | null;
  /** The token that travelled (input, owner, output, created); the box's version at this step for an instance-only step; null for an import. */
  token: Token | null;
  /** Port of the stage node it binds to: an in-port for an input, an out-port for an output or created. Null for the owner, imports, and nodes without ports (expr, store). */
  port: string | null;
  /** The gray parameter name of that port (inputs; expr and store: the operand name), the output index text (outputs); null for owner and imports. */
  param: string | null;
  /** Graph edge that carries it (input: into the node; output or created: out of the node to the box; chip: the chip wire); null when there is none (owner, import). */
  edge: string | null;
  /** This step changed the object in place (a `mutate` or `store` version made by the event). */
  changed: boolean;
  /** The token after the in-place change (the box's version made by this event); present when `changed`. */
  after?: Token;
  /** Boxes holding several objects (a loop): 1-based position of this object and how many the box holds. */
  objectOf?: { k: number; n: number };
  /** Chips only. */
  chip?: { type: string; shape: number[] | null };
}

/** A value that is not an object: shown inline in the stage, never on the shelf. */
export interface StageValue {
  role: 'input' | 'output';
  port: string;
  param: string;
  /** `null` for a literal argument (`test_size = 0.2`); the value's token for a scalar that came from elsewhere. */
  token: Token | null;
  /** The literal's text for a constant, else the scalar's repr; null when the recorder kept none. */
  text: string | null;
  type: string | null;
  /** Graph edge that carries it (a scalar wired from another box); null for literals and source nodes. */
  edge: string | null;
}

export interface StageModel {
  /** The call, expr, store or import node of the current event (for an instance-only step: that instance). */
  node: string;
  kind: GNode['kind'];
  /** The current execution of `node`; null only when `node` is an instance. */
  execution: Execution | null;
  /** Event i of the step. */
  i: number;
  /** Source line of the event, null if the site is unknown. */
  line: number | null;
  error: EventError | null;
  participants: StageParticipant[];
  values: StageValue[];
}

/** One entry of the shelf, in creation order. */
export interface ShelfEntry {
  /** Instance or import node id. */
  node: string;
  kind: 'instance' | 'import';
  /** Event i at which the entry appears: `createdAt` (instance), or the first run of the statement (import). */
  at: number;
  /** Instances: how many objects the box holds (a merged loop box is one entry holding n); 1 for an import. */
  objects: number;
}

const objectsOf = (n: InstanceNode): number => n.versions.filter((v) => v.kind === 'new').length;

/** Instance box of each object, by object key (`v12`). */
function instanceByObject(model: GraphModel): Map<string, InstanceNode> {
  const m = new Map<string, InstanceNode>();
  for (const n of model.nodes)
    if (n.kind === 'instance') for (const v of n.versions) m.set(keyOf(v.token), n);
  return m;
}

function positionIn(n: InstanceNode, key: string): { k: number; n: number } | undefined {
  const total = objectsOf(n);
  if (total < 2) return undefined;
  let k = 0;
  for (const v of n.versions)
    if (v.kind === 'new') {
      k++;
      if (keyOf(v.token) === key) return { k, n: total };
    }
  return undefined;
}

/**
 * The shelf: every instance and import block in creation order (event i, then source order, then id). A
 * box merged from a loop is one entry whose `objects` says how many it holds. Chips, source nodes and
 * scalars are never entries. A truncated graph lists the boxes it kept. An entry is on the shelf from the
 * step after its `at` line: while that line is the current step its object is on the stage.
 */
export function shelfOrder(model: GraphModel): ShelfEntry[] {
  const out: { e: ShelfEntry; order: number }[] = [];
  for (const n of model.nodes) {
    if (n.kind === 'instance')
      out.push({
        e: { node: n.id, kind: 'instance', at: n.createdAt, objects: objectsOf(n) },
        order: n.order,
      });
    else if (n.kind === 'import' && n.executions.length > 0)
      out.push({
        e: { node: n.id, kind: 'import', at: n.executions[0]!.i, objects: 1 },
        order: n.order,
      });
  }
  out.sort(
    (a, b) =>
      a.e.at - b.e.at ||
      a.order - b.order ||
      (a.e.node < b.e.node ? -1 : a.e.node > b.e.node ? 1 : 0),
  );
  return out.map((x) => x.e);
}

/**
 * What takes part in the step: the node that ran, and around it the owner, the input objects, the output
 * objects and the objects it created, each with the port it binds to (so the stage can draw its wires).
 * Null at step 0, or when the current event's box is not in the model (a truncated graph).
 *
 * Decisions: scalars and literals are `values`, drawn inline, not participants. A folded temporary
 * (chip) is a participant of kind `chip`: it exists only on the stage. An object that cannot be matched to
 * a box (cut by truncation) and is no chip is left out, as is a scalar owner. Nothing is guessed.
 */
export function stageAt(model: GraphModel, log: EventLog, step: number): StageModel | null {
  const st = stateAt(model, log, step);
  if (st.current === null || st.currentNode === null) return null;
  const cur = st.current;
  const node = model.nodes.find((n) => n.id === st.currentNode);
  if (!node || node.kind === 'source') return null;
  const ev = log.events.find((e) => e.i === cur);
  const site = ev ? log.sites[ev.site] : undefined;
  const base = { node: node.id, kind: node.kind, i: cur, line: site ? site.line : null };

  if (node.kind === 'instance') {
    const ver = node.versions.find((v) => v.i === cur);
    const created = node.createdAt === cur;
    const p: StageParticipant = {
      kind: 'instance',
      role: created ? 'created' : 'owner',
      node: node.id,
      object: ver ? keyOf(ver.token) : null,
      token: st.activeVersion.get(node.id) ?? null,
      port: null,
      param: null,
      edge: null,
      changed: ver !== undefined && ver.kind !== 'new',
    };
    return { ...base, execution: null, error: null, participants: [p], values: [] };
  }

  const ex = node.executions.find((e) => e.i === cur);
  if (!ex) return null;
  const result: StageModel = {
    ...base,
    execution: ex,
    error: ex.error,
    participants: [],
    values: [],
  };

  if (node.kind === 'import') {
    // one statement can bind several names: every block it placed is created now
    for (const n of model.nodes)
      if (n.kind === 'import' && n.executions.some((e) => e.i === cur))
        result.participants.push({
          kind: 'import',
          role: 'created',
          node: n.id,
          object: null,
          token: null,
          port: null,
          param: null,
          edge: null,
          changed: false,
        });
    return result;
  }

  const byObject = instanceByObject(model);
  const inEdge = (port: string | null, token: Token): string | null =>
    model.edges.find(
      (e) =>
        e.chip === undefined &&
        e.to.node === node.id &&
        e.to.port === port &&
        e.uses.some((u) => u.i === cur && u.token === token),
    )?.id ?? null;
  const outEdge = (port: string | null, to: string | null): string | null =>
    model.edges.find(
      (e) =>
        e.chip === undefined &&
        e.from.node === node.id &&
        e.from.port === port &&
        (to === null || e.to.node === to),
    )?.id ?? null;
  const chipEdge = (token: Token, dir: 'in' | 'out'): GEdge | undefined =>
    model.edges.find(
      (e) =>
        e.chip !== undefined &&
        keyOf(e.chip.token) === keyOf(token) &&
        (dir === 'in' ? e.to.node === node.id : e.from.node === node.id),
    );
  const changedBy = (inst: InstanceNode, key: string): InstanceVersion | undefined =>
    inst.versions.find((v) => v.i === cur && v.kind !== 'new' && keyOf(v.token) === key);

  const add = (role: StageRole, token: Token, port: string | null, param: string | null): void => {
    const key = keyOf(token);
    const inst = byObject.get(key);
    if (inst) {
      const isNew = inst.versions.some(
        (v) => v.i === cur && v.kind === 'new' && keyOf(v.token) === key,
      );
      const r: StageRole = role === 'output' && isNew ? 'created' : role;
      const mut = changedBy(inst, key);
      const p: StageParticipant = {
        kind: 'instance',
        role: r,
        node: inst.id,
        object: key,
        token,
        port,
        param,
        edge:
          role === 'input'
            ? inEdge(port, token)
            : role === 'output'
              ? outEdge(port, inst.id)
              : null,
        changed: mut !== undefined,
      };
      if (mut) p.after = mut.token;
      const pos = positionIn(inst, key);
      if (pos) p.objectOf = pos;
      result.participants.push(p);
      return;
    }
    const ce = chipEdge(token, role === 'input' ? 'in' : 'out');
    if (ce?.chip)
      result.participants.push({
        kind: 'chip',
        role,
        node: ce.chip.node,
        object: key,
        token: ce.chip.token,
        port,
        param,
        edge: ce.id,
        changed: false,
        chip: { type: ce.chip.type, shape: ce.chip.shape },
      });
    // otherwise: no box and no chip (cut by truncation): leave it out
  };

  const scalar = (role: 'input' | 'output', port: string, param: string, token: Token): void => {
    const v = log.values[token];
    result.values.push({
      role,
      port,
      param,
      token,
      text: v?.repr ?? null,
      type: v?.type ?? null,
      edge: role === 'input' ? inEdge(port, token) : outEdge(port, null),
    });
  };

  if (ex.owner !== null && ex.owner.startsWith('v')) add('owner', ex.owner, null, null);

  if (node.kind === 'call') {
    for (const p of node.inPorts) {
      const tok = ex.inputs[p.id];
      if (tok === undefined) {
        if (p.constText !== undefined)
          result.values.push({
            role: 'input',
            port: p.id,
            param: p.param,
            token: null,
            text: p.constText.startsWith(`${p.param} = `)
              ? p.constText.slice(p.param.length + 3)
              : p.constText,
            type: null,
            edge: null,
          });
        continue;
      }
      if (tok.startsWith('v')) add('input', tok, p.id, p.param);
      else scalar('input', p.id, p.param, tok);
    }
    for (const p of node.outPorts) {
      const tok = ex.outputs[p.id];
      if (tok === undefined) continue;
      if (tok.startsWith('v')) add('output', tok, p.id, p.param);
      else scalar('output', p.id, p.param, tok);
    }
  } else {
    // expr and store nodes have no ports: operands are keyed `in:<param>`, results `out:<k>`
    for (const [id, tok] of Object.entries(ex.inputs))
      if (tok.startsWith('v')) add('input', tok, null, id.replace(/^in:/, ''));
    for (const [id, tok] of Object.entries(ex.outputs))
      if (tok.startsWith('v')) add('output', tok, null, id.replace(/^out:/, ''));
  }
  return result;
}
