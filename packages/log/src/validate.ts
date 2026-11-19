// Hand-written runtime check for EventLog (CONTRACTS.md section 2). No dependencies.
import type { EventLog } from './types';

const STATUSES = ['ok', 'error', 'timeout', 'stopped', 'limit'];
const KINDS = ['function', 'method', 'constructor', 'student_function', 'expr', 'store'];
const ORIGINS = ['const', 'name', 'call', 'expr', 'unknown'];
const STREAMS = ['stdout', 'stderr', 'warning', 'figure'];

function fail(path: string, what: string): never {
  throw new Error(`invalid EventLog at ${path}: ${what}`);
}

type Obj = Record<string, unknown>;

function obj(x: unknown, path: string): Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) fail(path, 'expected an object');
  return x as Obj;
}
function arr(x: unknown, path: string): unknown[] {
  if (!Array.isArray(x)) fail(path, 'expected an array');
  return x;
}
function str(x: unknown, path: string): string {
  if (typeof x !== 'string') fail(path, 'expected a string');
  return x;
}
function int(x: unknown, path: string): number {
  if (typeof x !== 'number' || !Number.isInteger(x)) fail(path, 'expected an integer');
  return x;
}
function bool(x: unknown, path: string): boolean {
  if (typeof x !== 'boolean') fail(path, 'expected a boolean');
  return x;
}
function oneOf(x: unknown, allowed: string[], path: string): string {
  const s = str(x, path);
  if (!allowed.includes(s)) fail(path, `expected one of ${allowed.join(', ')}, got ${s}`);
  return s;
}
function strOrNull(x: unknown, path: string): string | null {
  return x === null ? null : str(x, path);
}

/** Throws an Error naming the offending path if `x` is not a well-formed EventLog; returns it typed otherwise. */
export function validateLog(x: unknown): EventLog {
  const log = obj(x, '$');
  if (log.version !== 2) fail('$.version', 'expected 2');
  oneOf(log.status, STATUSES, '$.status');
  if (log.error !== null) {
    const e = obj(log.error, '$.error');
    str(e.type, '$.error.type');
    str(e.message, '$.error.message');
    if (e.line !== null) int(e.line, '$.error.line');
    arr(e.traceback, '$.error.traceback').forEach((f, k) => {
      const p = `$.error.traceback[${k}]`;
      const fo = obj(f, p);
      if (fo.kind === 'student') {
        int(fo.line, `${p}.line`);
        str(fo.text, `${p}.text`);
        str(fo.name, `${p}.name`);
      } else if (fo.kind === 'library') {
        int(fo.count, `${p}.count`);
        arr(fo.modules, `${p}.modules`).forEach((m, j) => str(m, `${p}.modules[${j}]`));
      } else fail(`${p}.kind`, 'expected student or library');
    });
  }

  const sites = arr(log.sites, '$.sites');
  sites.forEach((s, k) => {
    const p = `$.sites[${k}]`;
    const so = obj(s, p);
    if (int(so.id, `${p}.id`) !== k) fail(`${p}.id`, 'site id must equal its index');
    oneOf(so.kind, ['call', 'bind', 'store', 'ret'], `${p}.kind`);
    for (const f of ['line', 'col', 'end_line', 'end_col']) int(so[f], `${p}.${f}`);
    str(so.text, `${p}.text`);
    const checkOrigin = (o: unknown, op: string): void => {
      oneOf(obj(o, op).origin, ORIGINS, `${op}.origin`);
    };
    if (so.args !== undefined)
      arr(so.args, `${p}.args`).forEach((o, j) => checkOrigin(o, `${p}.args[${j}]`));
    if (so.keywords !== undefined) {
      for (const [name, o] of Object.entries(obj(so.keywords, `${p}.keywords`)))
        checkOrigin(o, `${p}.keywords.${name}`);
    }
    if (so.value !== undefined) checkOrigin(so.value, `${p}.value`);
  });

  const values = obj(log.values, '$.values');
  for (const [tok, v] of Object.entries(values)) {
    const p = `$.values.${tok}`;
    const vo = obj(v, p);
    str(vo.type, `${p}.type`);
    if (vo.methods !== undefined) {
      arr(vo.methods, `${p}.methods`).forEach((m, k) => {
        const mo = obj(m, `${p}.methods[${k}]`);
        str(mo.name, `${p}.methods[${k}].name`);
        str(mo.doc, `${p}.methods[${k}].doc`);
      });
    }
    if (vo.attrs !== undefined) {
      for (const [a, t] of Object.entries(obj(vo.attrs, `${p}.attrs`))) {
        if (!(str(t, `${p}.attrs.${a}`) in values))
          fail(`${p}.attrs.${a}`, `token ${String(t)} has no entry in values`);
      }
    }
  }
  const needToken = (t: unknown, p: string): void => {
    if (!(str(t, p) in values)) fail(p, `token ${String(t)} has no entry in values`);
  };

  const scopes = arr(log.scopes, '$.scopes');
  scopes.forEach((s, k) => {
    const p = `$.scopes[${k}]`;
    const so = obj(s, p);
    int(so.id, `${p}.id`);
    str(so.name, `${p}.name`);
    if (so.parent_event !== null) int(so.parent_event, `${p}.parent_event`);
    if (so.lexical_parent !== null) int(so.lexical_parent, `${p}.lexical_parent`);
    arr(so.bindings, `${p}.bindings`).forEach((b, j) => {
      const bp = `${p}.bindings[${j}]`;
      const ba = arr(b, bp);
      if (ba.length !== 3) fail(bp, 'expected [event, name, token]');
      int(ba[0], `${bp}[0]`);
      str(ba[1], `${bp}[1]`);
      needToken(ba[2], `${bp}[2]`);
    });
  });

  let prev = -Infinity;
  arr(log.events, '$.events').forEach((e, k) => {
    const p = `$.events[${k}]`;
    const eo = obj(e, p);
    const i = int(eo.i, `${p}.i`);
    if (i <= prev) fail(`${p}.i`, 'events must be sorted by strictly increasing i');
    prev = i;
    int(eo.ret, `${p}.ret`);
    const site = int(eo.site, `${p}.site`);
    if (site < 0 || site >= sites.length) fail(`${p}.site`, 'no such site');
    int(eo.scope, `${p}.scope`);
    oneOf(eo.kind, KINDS, `${p}.kind`);
    str(eo.name, `${p}.name`);
    strOrNull(eo.module, `${p}.module`);
    if (eo.owner !== null) needToken(eo.owner, `${p}.owner`);
    arr(eo.inputs, `${p}.inputs`).forEach((inp, j) => {
      const ip = `${p}.inputs[${j}]`;
      const io = obj(inp, ip);
      str(io.param, `${ip}.param`);
      oneOf(io.origin, ORIGINS, `${ip}.origin`);
      if (io.value !== undefined) needToken(io.value, `${ip}.value`);
      if (io.text !== undefined) str(io.text, `${ip}.text`);
    });
    arr(eo.outputs, `${p}.outputs`).forEach((t, j) => needToken(t, `${p}.outputs[${j}]`));
    bool(eo.returns_self, `${p}.returns_self`);
    arr(eo.mutates, `${p}.mutates`).forEach((m, j) => {
      const mp = `${p}.mutates[${j}]`;
      const ma = arr(m, mp);
      if (ma.length !== 2) fail(mp, 'expected [before, after]');
      needToken(ma[0], `${mp}[0]`);
      needToken(ma[1], `${mp}[1]`);
    });
    int(eo.count, `${p}.count`);
    if (eo.slot !== undefined && eo.slot !== true) fail(`${p}.slot`, 'expected true or absent');
    str(eo.merge_key, `${p}.merge_key`);
    if (eo.error !== null) {
      const er = obj(eo.error, `${p}.error`);
      str(er.type, `${p}.error.type`);
      str(er.message, `${p}.error.message`);
      bool(er.handled, `${p}.error.handled`);
    }
    if (eo.interrupted !== undefined && eo.interrupted !== true)
      fail(`${p}.interrupted`, 'expected true or absent');
  });

  arr(log.output, '$.output').forEach((o, k) => {
    const p = `$.output[${k}]`;
    const oo = obj(o, p);
    int(oo.i, `${p}.i`);
    const stream = oneOf(oo.stream, STREAMS, `${p}.stream`);
    if (stream === 'figure') {
      str(oo.png, `${p}.png`);
      int(oo.width, `${p}.width`);
      int(oo.height, `${p}.height`);
    } else str(oo.text, `${p}.text`);
  });
  arr(log.diagnostics, '$.diagnostics').forEach((d, k) => str(d, `$.diagnostics[${k}]`));
  return x as EventLog;
}
