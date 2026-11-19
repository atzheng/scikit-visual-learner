import { describe, expect, test } from 'vitest';
import { buildGraph } from './graph';
import type { CallNode, GraphModel, InstanceNode } from './graph';
import { attrsAround, eventLabel, stateAt, stepOfEvent } from './timeline';
import type { Event, EventLog, Input, OutputEntry, Site, ValueSummary } from './types';
import { validateLog } from './validate';

class B {
  sites: Site[] = [];
  events: Event[] = [];
  values: Record<string, ValueSummary> = {};
  bindings: [number, string, string][] = [];
  n = 0;
  site(text: string, line: number, extra: Partial<Site> = {}): number {
    const id = this.sites.length;
    this.sites.push({
      id,
      kind: 'call',
      line,
      col: 0,
      end_line: line,
      end_col: text.length,
      text,
      func_text: text.split('(')[0],
      ...extra,
    });
    return id;
  }
  val(token: string, type: string, extra: Partial<ValueSummary> = {}): string {
    this.values[token] = { type, ...extra };
    return token;
  }
  ev(site: number, kind: Event['kind'], name: string, extra: Partial<Event> = {}): Event {
    const i = this.n++;
    const e: Event = {
      i,
      ret: i,
      site,
      scope: 0,
      kind,
      name,
      module: kind === 'expr' || kind === 'store' ? null : 'lib',
      owner: null,
      inputs: [],
      outputs: [],
      returns_self: false,
      mutates: [],
      count: 1,
      merge_key: `s${site}`,
      error: null,
      ...extra,
    };
    this.events.push(e);
    return e;
  }
  bind(name: string, token: string): void {
    this.bindings.push([this.n - 1, name, token]);
  }
  log(extra: Partial<EventLog> = {}): EventLog {
    const log: EventLog = {
      version: 2,
      status: 'ok',
      error: null,
      sites: this.sites,
      scopes: [
        {
          id: 0,
          name: '<module>',
          parent_event: null,
          lexical_parent: null,
          bindings: this.bindings,
        },
      ],
      values: this.values,
      events: this.events,
      output: [],
      diagnostics: [],
      ...extra,
    };
    return validateLog(JSON.parse(JSON.stringify(log)));
  }
}
const wired = (param: string, value: string): Input => ({ param, origin: 'name', value });
const konst = (param: string, text: string): Input => ({ param, origin: 'const', text });
const build = (log: EventLog): GraphModel => buildGraph(log, { expanded: new Set(), fold: false });
const call = (m: GraphModel, name: string): CallNode => {
  const c = m.nodes.find((n): n is CallNode => n.kind === 'call' && n.name === name);
  if (!c) throw new Error(`no call ${name}`);
  return c;
};
/** The box of a class (default: the model; every object is a box, so the first instance is a DataFrame). */
const inst = (m: GraphModel, className = 'LinearRegression'): InstanceNode =>
  m.nodes.find((n): n is InstanceNode => n.kind === 'instance' && n.className === className)!;
const edgeBetween = (m: GraphModel, from: string, to: string) =>
  m.edges.find((e) => e.from.node === from && e.to.node === to)!;

const out = (i: number, text: string): OutputEntry => ({ i, stream: 'stdout', text });

const twoScopes = [
  { id: 0, name: '<module>', parent_event: null, lexical_parent: null, bindings: [] },
  { id: 1, name: 'f', parent_event: 0, lexical_parent: 0, bindings: [] },
];

/** df = read_csv(); a, b = split(df); model = LinearRegression(); model.fit(a); model.predict(b) */
function linregLog(): EventLog {
  const x = new B();
  const s0 = x.site('df = pd.read_csv("a.csv")', 1);
  const s1 = x.site('a, b = train_test_split(df, test_size=0.2)', 2);
  const s2 = x.site('model = LinearRegression()', 3);
  const s3 = x.site('model.fit(a)', 4);
  const s4 = x.site('model.predict(b)', 5);
  x.val('v1.0', 'DF');
  x.ev(s0, 'function', 'read_csv', { inputs: [konst('filepath', '"a.csv"')], outputs: ['v1.0'] });
  x.bind('df', 'v1.0');
  x.val('v2.0', 'DF');
  x.val('v3.0', 'DF');
  x.ev(s1, 'function', 'train_test_split', {
    inputs: [wired('arrays[0]', 'v1.0'), konst('test_size', '0.2')],
    outputs: ['v2.0', 'v3.0'],
  });
  x.val('v4.0', 'LinearRegression', { machine: true, attrs: {} });
  x.ev(s2, 'constructor', 'LinearRegression', { outputs: ['v4.0'] });
  x.bind('model', 'v4.0');
  x.val('s1', 'float', { repr: '1.5' });
  x.val('v5.0', 'array');
  x.val('v4.1', 'LinearRegression', { machine: true, attrs: { coef_: 'v5.0', intercept_: 's1' } });
  x.ev(s3, 'method', 'LinearRegression.fit', {
    owner: 'v4.0',
    inputs: [wired('X', 'v2.0')],
    returns_self: true,
    mutates: [['v4.0', 'v4.1']],
  });
  x.val('v6.0', 'array');
  x.ev(s4, 'method', 'LinearRegression.predict', {
    owner: 'v4.1',
    inputs: [wired('X', 'v3.0')],
    outputs: ['v6.0'],
  });
  return x.log({
    output: [out(-1, 'hello'), out(1, 'split done'), out(3, 'fitted'), out(4, 'pred')],
  });
}

describe('stateAt basics', () => {
  const log = linregLog();
  const m = build(log);

  test('step 0 shows nothing; -1 output is always visible', () => {
    const s = stateAt(m, log, 0);
    expect(s.current).toBeNull();
    expect(s.visibleNodes.size).toBe(0);
    expect(s.visibleEdges.size).toBe(0);
    expect(s.activeExecution.size).toBe(0);
    expect(s.badge.size).toBe(0);
    expect(s.attrsBefore).toBeUndefined();
    expect(s.output.map((o) => o.i)).toEqual([-1]);
  });

  test('final step shows everything; out-of-range steps are clamped', () => {
    const s = stateAt(m, log, m.steps.length);
    expect(s.current).toBe(m.steps[m.steps.length - 1]);
    expect(s.visibleNodes.size).toBe(m.nodes.length);
    expect(s.visibleEdges.size).toBe(m.edges.length);
    expect(s.output).toHaveLength(4);
    expect(stateAt(m, log, 999).visibleNodes.size).toBe(m.nodes.length);
    expect(stateAt(m, log, -3).visibleNodes.size).toBe(0);
  });

  test('a box appears at its i; a wire when its consumer has started', () => {
    const read = call(m, 'read_csv');
    const split = call(m, 'train_test_split');
    const df = inst(m, 'DF'); // read_csv's box; the wire to the split leaves the box
    const e = edgeBetween(m, df.id, split.id);
    const s1 = stateAt(m, log, 1);
    expect(s1.current).toBe(0);
    expect([...s1.visibleNodes]).toEqual([read.id, df.id]);
    expect(s1.visibleEdges.has(e.id)).toBe(false);
    expect(s1.activeExecution.get(read.id)?.i).toBe(0);
    const s2 = stateAt(m, log, 2);
    expect(s2.visibleNodes.has(split.id)).toBe(true);
    expect(s2.visibleEdges.has(e.id)).toBe(true);
    expect(s2.activeToken.get(e.id)).toBe('v1.0');
    expect(s2.output.map((o) => o.i)).toEqual([-1, 1]);
  });

  test('instance appears at createdAt, with its method boxes after', () => {
    const i = inst(m);
    expect(i.createdAt).toBe(2);
    expect(stateAt(m, log, 2).visibleNodes.has(i.id)).toBe(false);
    const s3 = stateAt(m, log, 3);
    expect(s3.visibleNodes.has(i.id)).toBe(true);
    // method slots exist from the constructor step, uncalled until their first execution
    const fitId = call(m, 'LinearRegression.fit').id;
    expect(s3.visibleNodes.has(fitId)).toBe(true);
    expect(s3.uncalled.has(fitId)).toBe(true);
    expect(s3.activeExecution.has(fitId)).toBe(false);
    expect(s3.visibleNodes.has(call(m, 'LinearRegression').id)).toBe(true);
    const s4 = stateAt(m, log, 4);
    expect(s4.uncalled.has(fitId)).toBe(false);
    expect(s4.activeExecution.get(fitId)?.i).toBe(3);
    expect(stateAt(m, log, 2).uncalled.size).toBe(0);
    expect(stateAt(m, log, m.steps.length).uncalled.size).toBe(0);
  });

  test('attrsBefore/attrsAfter differ exactly in the fitted attrs', () => {
    const fit = stateAt(m, log, 4);
    expect(fit.current).toBe(3);
    expect(fit.attrsBefore).toEqual({});
    expect(fit.attrsAfter).toEqual({ coef_: 'v5.0', intercept_: 's1' });
    // a method that does not mutate: before == after (the owner's attrs)
    const pred = stateAt(m, log, 5);
    expect(pred.attrsBefore).toEqual(pred.attrsAfter);
    expect(pred.attrsAfter).toEqual({ coef_: 'v5.0', intercept_: 's1' });
    // not a method on an instance
    expect(stateAt(m, log, 1).attrsBefore).toBeUndefined();
  });

  test('output is filtered by i', () => {
    expect(stateAt(m, log, 4).output.map((o) => (o.stream === 'figure' ? '' : o.text))).toEqual([
      'hello',
      'split done',
      'fitted',
    ]);
  });

  test('sources are shown with their consumer', () => {
    const b = new B();
    const s = b.site('f(x)', 1);
    b.val('s1', 'int');
    b.ev(s, 'function', 'f', { inputs: [wired('x', 's1')], outputs: [b.val('s2', 'int')] });
    const lg = b.log();
    const mm = build(lg);
    const src = mm.nodes.find((n) => n.kind === 'source')!;
    expect(stateAt(mm, lg, 0).visibleNodes.has(src.id)).toBe(false);
    expect(stateAt(mm, lg, 1).visibleNodes.has(src.id)).toBe(true);
  });
});

describe('merged boxes', () => {
  /** x = load(); for k in range(3): x = f(x)   (events 0..3) */
  function loopLog(): EventLog {
    const b = new B();
    const s0 = b.site('x = load()', 1);
    const s1 = b.site('x = f(x)', 2);
    b.val('s1', 'int');
    b.ev(s0, 'function', 'load', { outputs: ['s1'] });
    for (let k = 1; k <= 3; k++) {
      b.val(`s${k + 1}`, 'int');
      b.ev(s1, 'function', 'f', {
        inputs: [wired('x', `s${k}`)],
        outputs: [`s${k + 1}`],
        count: k,
      });
    }
    return b.log();
  }

  test('stepping onto the 3rd execution sets the badge to 3 of 3 and switches active tokens', () => {
    const lg = loopLog();
    const m = build(lg);
    const f = call(m, 'f');
    const load = call(m, 'load');
    const fromLoad = edgeBetween(m, load.id, f.id);
    const self = edgeBetween(m, f.id, f.id);
    const s2 = stateAt(m, lg, 2);
    expect(s2.badge.get(f.id)).toEqual({ k: 1, n: 3 });
    expect(s2.badge.has(load.id)).toBe(false);
    expect(s2.activeToken.get(fromLoad.id)).toBe('s1');
    expect(s2.visibleEdges.has(self.id)).toBe(false);
    const s3 = stateAt(m, lg, 3);
    expect(s3.badge.get(f.id)).toEqual({ k: 2, n: 3 });
    expect(s3.activeToken.get(self.id)).toBe('s2');
    expect(s3.activeExecution.get(f.id)?.outputs['out:0']).toBe('s3');
    const s4 = stateAt(m, lg, 4);
    expect(s4.badge.get(f.id)).toEqual({ k: 3, n: 3 });
    expect(s4.activeToken.get(self.id)).toBe('s3');
    expect(s4.activeToken.get(fromLoad.id)).toBe('s1');
  });

  test('a loop box holding different objects: activeVersion and objectBadge follow the pass', () => {
    // d = make(); d.drop(inplace=True)   -- twice, from the same two sites (events 0..3)
    const b = new B();
    const s0 = b.site('d = make()', 1);
    const s1 = b.site('d.drop(inplace=True)', 2);
    for (const t of ['v1.0', 'v1.1', 'v2.0', 'v2.1']) b.val(t, 'DF');
    b.ev(s0, 'function', 'make', { outputs: ['v1.0'] });
    b.ev(s1, 'method', 'DataFrame.drop', {
      owner: 'v1.0',
      inputs: [konst('inplace', 'True')],
      mutates: [['v1.0', 'v1.1']],
    });
    b.ev(s0, 'function', 'make', { outputs: ['v2.0'], count: 2 });
    b.ev(s1, 'method', 'DataFrame.drop', {
      owner: 'v2.0',
      inputs: [konst('inplace', 'True')],
      mutates: [['v2.0', 'v2.1']],
      count: 2,
    });
    const lg = b.log();
    const m = build(lg);
    const boxes = m.nodes.filter((n): n is InstanceNode => n.kind === 'instance');
    expect(boxes).toHaveLength(1);
    const d = boxes[0]!;
    expect(d.versions.map((v) => v.kind)).toEqual(['new', 'mutate', 'new', 'mutate']);
    const at = (s: number) => stateAt(m, lg, s);
    expect(at(1).activeVersion.get(d.id)).toBe('v1.0');
    expect(at(1).objectBadge.get(d.id)).toEqual({ k: 1, n: 2 });
    expect(at(2).activeVersion.get(d.id)).toBe('v1.1');
    expect(at(2).objectBadge.get(d.id)).toEqual({ k: 1, n: 2 });
    expect(at(3).activeVersion.get(d.id)).toBe('v2.0'); // a new object, not v1.1 changed
    expect(at(3).objectBadge.get(d.id)).toEqual({ k: 2, n: 2 });
    expect(at(4).activeVersion.get(d.id)).toBe('v2.1');
    expect(at(m.steps.length).objectBadge.get(d.id)).toEqual({ k: 2, n: 2 });
  });

  test('slot executions (non-contiguous i) step correctly', () => {
    const b = new B();
    const s = b.site('f(x)', 1);
    b.val('v1.0', 'DF');
    for (const k of [0, 1, 2]) {
      b.val(`v${k + 10}.0`, 'DF');
      b.ev(s, 'function', 'f', {
        inputs: [wired('x', 'v1.0')],
        outputs: [`v${k + 10}.0`],
        count: k + 1,
      });
    }
    const lg = b.log();
    lg.events.push({
      ...(lg.events[2] as Event),
      i: 40,
      ret: 40,
      count: 50,
      slot: true,
      outputs: ['v10.0'],
    });
    lg.output.push(out(20, 'between'), out(40, 'at slot'));
    const m = build(lg);
    expect(m.steps).toEqual([0, 1, 2, 40]);
    const f = call(m, 'f');
    expect(stateAt(m, lg, 3).badge.get(f.id)).toEqual({ k: 3, n: 50 });
    const s4 = stateAt(m, lg, 4);
    expect(s4.current).toBe(40);
    expect(s4.badge.get(f.id)).toEqual({ k: 50, n: 50 });
    expect(s4.activeExecution.get(f.id)?.i).toBe(40);
    expect(stateAt(m, lg, 3).output).toHaveLength(0);
    expect(s4.output.map((o) => o.i)).toEqual([20, 40]);
  });

  test('methods on two instances from one site: each box has its own owner and badge', () => {
    const b = new B();
    const sc = b.site('m = Ridge()', 1);
    const sf = b.site('m.fit(x)', 2);
    b.val('v1.0', 'DF');
    for (const t of ['v2.0', 'v2.1', 'v3.0', 'v3.1']) b.val(t, 'Ridge', { machine: true });
    b.ev(sc, 'constructor', 'Ridge', { outputs: ['v2.0'], count: 1 });
    b.ev(sc, 'constructor', 'Ridge', { outputs: ['v3.0'], count: 2 });
    b.ev(sf, 'method', 'Ridge.fit', {
      owner: 'v2.0',
      inputs: [wired('X', 'v1.0')],
      returns_self: true,
      mutates: [['v2.0', 'v2.1']],
      count: 1,
    });
    b.ev(sf, 'method', 'Ridge.fit', {
      owner: 'v3.0',
      inputs: [wired('X', 'v1.0')],
      returns_self: true,
      mutates: [['v3.0', 'v3.1']],
      count: 2,
    });
    const lg = b.log();
    const m = build(lg);
    const s = stateAt(m, lg, m.steps.length);
    const fits = m.nodes.filter((n): n is CallNode => n.kind === 'call' && n.name === 'Ridge.fit');
    expect(fits.length).toBeGreaterThanOrEqual(1);
    for (const c of fits) {
      expect(s.activeExecution.get(c.id)?.owner).toBe(c.executions[c.executions.length - 1]!.owner);
    }
    expect(s.attrsBefore).toBeUndefined(); // no attrs recorded for these values
  });
});

describe('ret and function-returning machines', () => {
  function pipeLog(withConsumer: boolean): EventLog {
    const b = new B();
    const s0 = b.site('pipe = make_pipeline(a, b)', 1);
    const s1 = b.site('print_it(pipe)', 2);
    b.val('v1.0', 'Pipeline', { machine: true });
    b.ev(s0, 'function', 'make_pipeline', { outputs: ['v1.0'], ret: 2 });
    // interior events in scope 1 are not drawn
    b.ev(s0, 'function', 'inner', { scope: 1 });
    b.ev(s0, 'function', 'inner2', { scope: 1 });
    if (withConsumer) b.ev(s1, 'function', 'print_it', { inputs: [wired('x', 'v1.0')] });
    return b.log({ scopes: twoScopes });
  }

  test('wire from a function into the instance it creates appears at ret', () => {
    const lg = pipeLog(true);
    const m = build(lg);
    expect(m.steps).toEqual([0, 3]);
    const mk = call(m, 'make_pipeline');
    const e = edgeBetween(m, mk.id, inst(m, 'Pipeline').id);
    const s1 = stateAt(m, lg, 1);
    expect(s1.visibleNodes.has(mk.id)).toBe(true);
    expect(s1.visibleNodes.has(inst(m, 'Pipeline').id)).toBe(true);
    expect(s1.visibleEdges.has(e.id)).toBe(false);
    const s2 = stateAt(m, lg, 2);
    expect(s2.visibleEdges.has(e.id)).toBe(true);
    expect(s2.activeToken.get(e.id)).toBe('v1.0');
  });

  test('an edge ready only after the last drawn step still shows at the end', () => {
    const lg = pipeLog(false);
    const m = build(lg);
    expect(m.steps).toEqual([0]);
    expect(m.edges.length).toBeGreaterThan(0);
    expect(stateAt(m, lg, 1).visibleEdges.size).toBe(m.edges.length);
  });

  test('no drawn events: step 0 is the end and shows all output', () => {
    const lg = new B().log({ output: [out(5, 'x')] });
    const m = build(lg);
    expect(stateAt(m, lg, 0).output).toHaveLength(1);
  });
});

describe('eventLabel', () => {
  test('line and source text', () => {
    const b = new B();
    const s = b.site('train_test_split(X, y, test_size=0.2)', 10);
    b.ev(s, 'function', 'train_test_split');
    const lg = b.log();
    expect(eventLabel(lg, 0)).toBe('line 10: train_test_split(X, y, test_size=0.2)');
    expect(eventLabel(lg, 99)).toBe('event 99');
  });

  test('collapses whitespace, truncates, marks errors and interruptions', () => {
    const b = new B();
    const long = 'f(\n    ' + 'a, '.repeat(60) + 'z)';
    const s0 = b.site(long, 3);
    const s1 = b.site('g(x)', 4);
    const s2 = b.site('h(x)', 5);
    const s3 = b.site('k(x)', 6);
    b.ev(s0, 'function', 'f');
    b.ev(s1, 'function', 'g', { error: { type: 'ValueError', message: 'bad', handled: false } });
    b.ev(s2, 'function', 'h', { error: { type: 'KeyError', message: 'k', handled: true } });
    b.ev(s3, 'function', 'k', { interrupted: true });
    const lg = b.log();
    const l0 = eventLabel(lg, 0);
    expect(l0.startsWith('line 3: f( a, a,')).toBe(true);
    expect(l0.endsWith('…')).toBe(true);
    expect(l0.length).toBeLessThanOrEqual('line 3: '.length + 80);
    expect(eventLabel(lg, 1)).toBe('line 4: g(x) (error: ValueError)');
    expect(eventLabel(lg, 2)).toBe('line 5: h(x) (handled KeyError)');
    expect(eventLabel(lg, 3)).toBe('line 6: k(x) (stopped here)');
  });
});

describe('performance', () => {
  test('stateAt on a 300-node model is under 5 ms', () => {
    const b = new B();
    b.val('v0.0', 'DF');
    let prev = 'v0.0';
    for (let k = 1; k <= 290; k++) {
      const s = b.site(`f${k}(x)`, k);
      const t = b.val(`v${k}.0`, 'DF');
      b.ev(s, 'function', `f${k}`, { inputs: [wired('x', prev)], outputs: [t] });
      prev = t;
    }
    const output = Array.from({ length: 2000 }, (_, k) => out(k % 290, 'line'));
    const lg = b.log({ output });
    const m = build(lg);
    expect(m.nodes.length).toBeGreaterThanOrEqual(290);
    stateAt(m, lg, 1); // builds the index
    const t0 = performance.now();
    const reps = 50;
    for (let r = 0; r < reps; r++) stateAt(m, lg, 100 + r);
    const per = (performance.now() - t0) / reps;
    expect(per).toBeLessThan(5);
  });
});

describe('review additions', () => {
  const log = linregLog();
  const m = build(log);

  test('activeVersion follows the instance versions; currentNode names the current box', () => {
    const i = inst(m);
    expect(stateAt(m, log, 2).activeVersion.has(i.id)).toBe(false);
    expect(stateAt(m, log, 3).activeVersion.get(i.id)).toBe('v4.0');
    // data boxes follow too: the DataFrame box exists from read_csv on
    expect(stateAt(m, log, 1).activeVersion.get(inst(m, 'DF').id)).toBe('v1.0');
    expect(stateAt(m, log, 3).currentNode).toBe(call(m, 'LinearRegression').id); // constructor step
    const fit = stateAt(m, log, 4);
    expect(fit.activeVersion.get(i.id)).toBe('v4.1');
    expect(fit.currentNode).toBe(call(m, 'LinearRegression.fit').id);
    expect(stateAt(m, log, 0).currentNode).toBeNull();
    expect(stateAt(m, log, m.steps.length).activeVersion.get(i.id)).toBe('v4.1');
  });

  test('stepOfEvent maps execution i to its step', () => {
    expect(stepOfEvent(m, 3)).toBe(4);
    expect(stateAt(m, log, stepOfEvent(m, 3)!).current).toBe(3);
    expect(stepOfEvent(m, 99)).toBeNull();
  });

  test('attrsAround gives before/after for a chosen method execution', () => {
    expect(attrsAround(m, log, 3)).toEqual({
      before: {},
      after: { coef_: 'v5.0', intercept_: 's1' },
    });
    expect(attrsAround(m, log, 0)).toBeNull(); // not a method on a machine
    expect(attrsAround(m, log, 99)).toBeNull();
  });

  test('NaN clamps to step 0; Infinity to the end', () => {
    const s = stateAt(m, log, NaN);
    expect(s.current).toBeNull();
    expect(s.visibleNodes.size).toBe(0);
    expect(stateAt(m, log, Infinity).visibleNodes.size).toBe(m.nodes.length);
  });

  test('eventLabel never splits a surrogate pair', () => {
    const b = new B();
    const s = b.site('f("' + 'x'.repeat(75) + '😀😀😀😀")', 1);
    b.ev(s, 'function', 'f');
    const label = eventLabel(b.log(), 0);
    expect(label.endsWith('…')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(label)).toBe(false);
    expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(label)).toBe(false);
  });
});
