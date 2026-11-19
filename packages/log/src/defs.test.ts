// def / class steps and the callee participant (CONTRACTS.md sections 3, 8; svl-jl3). Hand-written logs.
import { describe, expect, test } from 'vitest';
import { describeStep, summaryText } from './describe';
import { buildGraph } from './graph';
import type { CallNode, DefNode, GraphModel } from './graph';
import { shelfAt, shelfOrder, stageAt } from './stage';
import type { DefInfo, Event, EventLog, Site } from './types';
import { validateLog } from './validate';

class L {
  sites: Site[] = [];
  events: Event[] = [];

  private ev(site: number, kind: Event['kind'], name: string, extra: Partial<Event> = {}): void {
    const i = this.events.length;
    this.events.push({
      i,
      ret: i,
      site,
      scope: 0,
      kind,
      name,
      module: null,
      owner: null,
      inputs: [],
      outputs: [],
      returns_self: false,
      mutates: [],
      count: 1,
      merge_key: `s${site}`,
      error: null,
      ...extra,
    });
  }
  def(line: number, d: Partial<DefInfo> & { name: string }, run = true): void {
    const site = this.sites.length;
    const info: DefInfo = {
      kind: 'function',
      signature: `${d.name}()`,
      decorated: false,
      link: true,
      ...d,
    };
    this.sites.push({
      id: site,
      kind: 'def',
      line,
      col: 0,
      end_line: line,
      end_col: 10,
      text: `def ${d.name}(): pass`,
      def: info,
    });
    if (run) this.ev(site, 'def', d.name);
  }
  imp(line: number, name: string, module: string, sole = true): void {
    const site = this.sites.length;
    this.sites.push({
      id: site,
      kind: 'import',
      line,
      col: 0,
      end_line: line,
      end_col: 20,
      text: `import ${module} as ${name}`,
      imports: [{ name, module, attr: null, sole }],
    });
    this.ev(site, 'import', `import ${module} as ${name}`);
  }
  call(
    line: number,
    text: string,
    kind: Event['kind'],
    name: string,
    extra: Partial<Event> = {},
  ): void {
    const site = this.sites.length;
    this.sites.push({
      id: site,
      kind: 'call',
      line,
      col: 0,
      end_line: line,
      end_col: 20,
      text: `${text}()`,
      func_text: text,
    });
    this.ev(site, kind, name, { module: '__main__', ...extra });
  }
  log(): EventLog {
    return validateLog(
      JSON.parse(
        JSON.stringify({
          version: 2,
          status: 'ok',
          error: null,
          sites: this.sites,
          scopes: [
            { id: 0, name: '<module>', parent_event: null, lexical_parent: null, bindings: [] },
          ],
          values: { 'v1.0': { type: 'C' } },
          events: this.events,
          output: [],
          diagnostics: [],
        }),
      ),
    );
  }
  graph(): GraphModel {
    return buildGraph(this.log());
  }
}

const defs = (g: GraphModel): DefNode[] => g.nodes.filter((n): n is DefNode => n.kind === 'def');
const calls = (g: GraphModel): CallNode[] =>
  g.nodes.filter((n): n is CallNode => n.kind === 'call');

describe('def nodes', () => {
  test('a def step places a function object on the shelf, with no wires', () => {
    const l = new L();
    l.def(1, { name: 'f', signature: 'f(x, y=2)' });
    const g = l.graph();
    expect(defs(g)).toHaveLength(1);
    expect(defs(g)[0]).toMatchObject({
      name: 'f',
      defKind: 'function',
      signature: 'f(x, y=2)',
      methods: [],
      decorated: false,
    });
    expect(g.steps).toEqual([0]);
    expect(g.edges).toEqual([]);
    expect(shelfOrder(g)).toEqual([{ node: defs(g)[0]!.id, kind: 'def', at: 0, objects: 1 }]);
    expect(shelfAt(g, 0)).toEqual([]);
    expect(shelfAt(g, 1)).toHaveLength(1);
  });

  test('a def that did not run (conditional) has no node', () => {
    const l = new L();
    l.def(1, { name: 'f' });
    l.def(3, { name: 'g' }, false);
    expect(defs(l.graph()).map((n) => n.name)).toEqual(['f']);
  });

  test('a redefinition is a new object at its own step', () => {
    const l = new L();
    l.def(1, { name: 'f' });
    l.def(2, { name: 'f' });
    const g = l.graph();
    expect(defs(g)).toHaveLength(2);
    expect(new Set(defs(g).map((n) => n.id)).size).toBe(2);
    expect(defs(g).map((n) => n.executions[0]!.i)).toEqual([0, 1]);
  });

  test('a loop runs a def again: one node, one execution per run', () => {
    const l = new L();
    l.def(2, { name: 'f' });
    l.events.push({ ...l.events[0]!, i: 1, ret: 1, count: 2 });
    const g = l.graph();
    expect(defs(g)).toHaveLength(1);
    expect(defs(g)[0]!.executions.map((x) => x.i)).toEqual([0, 1]);
  });

  test('stageAt of a def step: one created participant of kind def', () => {
    const l = new L();
    l.def(1, { name: 'f' });
    const log = l.log();
    const g = buildGraph(log);
    const st = stageAt(g, log, 1)!;
    expect(st.kind).toBe('def');
    expect(st.participants).toMatchObject([
      { kind: 'def', role: 'created', node: defs(g)[0]!.id, newBox: true },
    ]);
  });
});

describe('describeStep for definitions', () => {
  test('function, decorated function, class with and without methods', () => {
    const l = new L();
    l.def(1, { name: 'f', signature: 'f(x, y=2)' });
    l.def(2, { name: 'g', signature: 'g()', decorated: true });
    l.def(3, { name: 'C', kind: 'class', signature: 'C()', methods: ['fit', 'predict'] });
    l.def(4, { name: 'D', kind: 'class', signature: 'D()', methods: [] });
    const log = l.log();
    const g = buildGraph(log);
    const said = [1, 2, 3, 4].map((s) => summaryText(describeStep(g, log, s)));
    expect(said).toEqual([
      'Defined function f(x, y=2).',
      'Defined function g() (decorated).',
      'Defined class C with methods fit, predict.',
      'Defined class D.',
    ]);
  });
});

describe('callee participants', () => {
  test('a call of a student function has the def as its callee, and the stage lists it', () => {
    const l = new L();
    l.def(1, { name: 'load', signature: 'load(path)' });
    l.call(5, 'load', 'student_function', 'load');
    const log = l.log();
    const g = buildGraph(log);
    const d = defs(g)[0]!;
    expect(calls(g)[0]!.executions[0]!.callee).toBe(d.id);
    const st = stageAt(g, log, 2)!;
    expect(st.participants.filter((p) => p.role === 'callee')).toMatchObject([
      { kind: 'def', node: d.id, role: 'callee', object: null, changed: false },
    ]);
  });

  test('a constructor call of a student class has the class as its callee', () => {
    const l = new L();
    l.def(1, { name: 'C', kind: 'class', signature: 'C()' });
    l.call(5, 'C', 'constructor', 'C');
    expect(calls(l.graph())[0]!.executions[0]!.callee).toBe(defs(l.graph())[0]!.id);
  });

  test('after a redefinition the call links to the latest def that ran before it', () => {
    const l = new L();
    l.def(1, { name: 'f' });
    l.call(3, 'f', 'student_function', 'f');
    l.def(5, { name: 'f' });
    l.call(7, 'f', 'student_function', 'f');
    const g = l.graph();
    const [d1, d2] = defs(g);
    const execs = calls(g).flatMap((c) => c.executions);
    expect(execs.map((x) => x.callee)).toEqual([d1!.id, d2!.id]);
  });

  test('no callee when the name may be rebound (link false), is decorated, or the call came first', () => {
    const l = new L();
    l.call(1, 'f', 'student_function', 'f'); // before any def ran
    l.def(2, { name: 'f', link: false });
    l.call(3, 'f', 'student_function', 'f');
    l.def(4, { name: 'g', decorated: true, link: false });
    l.call(5, 'g', 'student_function', 'g');
    const g = l.graph();
    for (const c of calls(g)) for (const x of c.executions) expect(x.callee).toBeUndefined();
  });

  test('no callee for a dotted call, a method, or a name with no def', () => {
    const l = new L();
    l.def(1, { name: 'f' });
    l.call(2, 'm.f', 'student_function', 'f');
    l.call(3, 'h', 'student_function', 'h');
    l.call(4, 'f', 'method', 'C.f', { owner: 'v1.0' });
    const g = l.graph();
    for (const c of calls(g)) for (const x of c.executions) expect(x.callee).toBeUndefined();
  });

  test('a sole import is the callee of a call of its name, and of a dotted call from it', () => {
    const l = new L();
    l.imp(1, 'pd', 'pandas');
    l.call(3, 'pd.read_csv', 'function', 'read_csv', { module: 'pandas' });
    const g = l.graph();
    const imp = g.nodes.find((n) => n.kind === 'import')!;
    expect(calls(g)[0]!.executions[0]!.callee).toBe(imp.id);
    const log = l.log();
    const st = stageAt(g, log, 2)!;
    expect(st.participants.filter((p) => p.role === 'callee')).toMatchObject([
      { kind: 'import', node: imp.id },
    ]);
  });

  test('no import callee when the name is not sole, or the call comes before the import', () => {
    const l = new L();
    l.imp(1, 'pd', 'pandas', false);
    l.call(3, 'pd.read_csv', 'function', 'read_csv', { module: 'pandas' });
    for (const c of calls(l.graph())) expect(c.executions[0]!.callee).toBeUndefined();

    const k = new L();
    k.call(1, 'pd.read_csv', 'function', 'read_csv', { module: 'pandas' });
    k.imp(2, 'pd', 'pandas');
    for (const c of calls(k.graph())) expect(c.executions[0]!.callee).toBeUndefined();
  });
});
