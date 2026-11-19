// Import steps and blocks (CONTRACTS.md section 8, "Import nodes"). Hand-written logs.
import { describe, expect, test } from 'vitest';
import { buildGraph } from './graph';
import type { CallNode, GraphModel, ImportNode } from './graph';
import type { Event, EventLog, Site, ValueSummary } from './types';
import { validateLog } from './validate';

class L {
  sites: Site[] = [];
  events: Event[] = [];
  values: Record<string, ValueSummary> = {};

  imp(
    text: string,
    line: number,
    name: string,
    module: string,
    attr: string | null,
    sole = true,
    run = true,
  ): void {
    const site = this.sites.length;
    if (run) this.event(site, 'import', text);
    this.sites.push({
      id: this.sites.length,
      kind: 'import',
      line,
      col: 0,
      end_line: line,
      end_col: text.length,
      text,
      imports: [{ name, module, attr, sole }],
    });
  }
  event(site: number, kind: Event['kind'], name: string, extra: Partial<Event> = {}): void {
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
  call(
    text: string,
    line: number,
    kind: Event['kind'],
    name: string,
    extra: Partial<Event> = {},
    funcText?: string,
  ): void {
    const site = this.sites.length;
    this.sites.push({
      id: site,
      kind: 'call',
      line,
      col: 0,
      end_line: line,
      end_col: text.length,
      text,
      func_text: funcText ?? text.split('(')[0],
    });
    const i = this.events.length;
    this.events.push({
      i,
      ret: i,
      site,
      scope: 0,
      kind,
      name,
      module: 'lib',
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
  graph(): GraphModel {
    const log: EventLog = {
      version: 2,
      status: 'ok',
      error: null,
      sites: this.sites,
      scopes: [{ id: 0, name: '<module>', parent_event: null, lexical_parent: null, bindings: [] }],
      values: this.values,
      events: this.events,
      output: [],
      diagnostics: [],
    };
    return buildGraph(validateLog(JSON.parse(JSON.stringify(log))));
  }
}

const readCsv = (sole: boolean, callLine = 3, root = 'pd', run = true): GraphModel => {
  const l = new L();
  l.imp('import pandas as pd', 1, 'pd', 'pandas', null, sole, run);
  l.values['v1.0'] = { type: 'DataFrame' };
  l.call(`${root}.read_csv("a.csv")`, callLine, 'function', 'read_csv', { outputs: ['v1.0'] });
  return l.graph();
};
const importNodes = (g: GraphModel): ImportNode[] =>
  g.nodes.filter((n): n is ImportNode => n.kind === 'import');
const callNode = (g: GraphModel): CallNode =>
  g.nodes.find((n): n is CallNode => n.kind === 'call')!;

describe('import blocks (svl-i6s)', () => {
  test('an import step places a block at its own step, before the first call, with no wires', () => {
    const g = readCsv(true);
    expect(importNodes(g)).toHaveLength(1);
    const node = importNodes(g)[0]!;
    expect(node).toMatchObject({ name: 'pd', source: 'pandas', site: 0 });
    expect(node.executions.map((x) => x.i)).toEqual([0]);
    expect(g.steps).toEqual([0, 1]); // the import is a step of its own
    expect(g.edges.filter((e) => e.from.node === node.id || e.to.node === node.id)).toEqual([]); // no wires
    expect(g.nodes[0]!.kind).toBe('import'); // in source order
  });

  test('an unused import still places its block (every import places an object)', () => {
    const l = new L();
    l.imp('import numpy as np', 1, 'np', 'numpy', null);
    expect(importNodes(l.graph())).toHaveLength(1);
  });

  test('a rebound name (not sole) gets a block but no module in the call box', () => {
    const g = readCsv(false);
    expect(importNodes(g)).toHaveLength(1);
    expect(callNode(g).importedFrom).toBeUndefined();
  });

  test('an import that did not run gives no block and no module', () => {
    const g = readCsv(true, 3, 'pd', false);
    expect(importNodes(g)).toHaveLength(0);
    expect(callNode(g).importedFrom).toBeUndefined();
  });

  test('a call before the import statement has no module', () => {
    expect(callNode(readCsv(true, 0)).importedFrom).toBeUndefined();
  });

  test('a call through another root name has no module', () => {
    expect(callNode(readCsv(true, 3, 'np')).importedFrom).toBeUndefined();
  });

  test('a call on a result is not a callee through the root name', () => {
    const l = new L();
    l.imp('import pandas as pd', 1, 'pd', 'pandas', null);
    l.values['v1.0'] = { type: 'DataFrame' };
    l.call(
      'pd.read_csv("a").dropna()',
      3,
      'method',
      'dropna',
      { outputs: ['v1.0'] },
      'pd.read_csv("a").dropna',
    );
    expect(callNode(l.graph()).importedFrom).toBeUndefined();
  });

  test('module of a from-import, none when the name is the module, alias path', () => {
    const l = new L();
    l.imp(
      'from sklearn.linear_model import LinearRegression',
      1,
      'LinearRegression',
      'sklearn.linear_model',
      'LinearRegression',
    );
    l.imp('import numpy', 2, 'numpy', 'numpy', null);
    l.imp('from sklearn.linear_model import Ridge as R', 3, 'R', 'sklearn.linear_model', 'Ridge');
    l.values['v1.0'] = { type: 'LinearRegression', machine: true };
    l.values['v2.0'] = { type: 'ndarray', shape: [3] };
    l.values['v3.0'] = { type: 'Ridge', machine: true };
    l.call('LinearRegression', 5, 'constructor', 'LinearRegression', { outputs: ['v1.0'] });
    l.call('numpy.zeros', 6, 'function', 'zeros', { outputs: ['v2.0'] });
    l.call('R', 7, 'constructor', 'Ridge', { outputs: ['v3.0'] });
    const g = l.graph();
    const sources = Object.fromEntries(importNodes(g).map((n) => [n.name, n.source]));
    expect(sources).toEqual({
      LinearRegression: 'sklearn.linear_model',
      numpy: null,
      R: 'sklearn.linear_model.Ridge',
    });
    const from = Object.fromEntries(
      g.nodes.filter((n): n is CallNode => n.kind === 'call').map((n) => [n.name, n.importedFrom]),
    );
    expect(from).toEqual({
      LinearRegression: 'sklearn.linear_model',
      zeros: 'numpy',
      Ridge: 'sklearn.linear_model',
    });
    expect(g.edges.some((e) => e.from.node.startsWith('m:') || e.to.node.startsWith('m:'))).toBe(
      false,
    );
    expect(g.nodes.slice(0, 3).map((n) => n.kind)).toEqual(['import', 'import', 'import']);
  });

  test('one statement binding several names: one step, one block per name', () => {
    const l = new L();
    l.sites.push({
      id: 0,
      kind: 'import',
      line: 1,
      col: 0,
      end_line: 1,
      end_col: 30,
      text: 'import numpy as np, pandas as pd',
      imports: [
        { name: 'np', module: 'numpy', attr: null, sole: true },
        { name: 'pd', module: 'pandas', attr: null, sole: true },
      ],
    });
    l.event(0, 'import', 'import numpy as np, pandas as pd');
    const g = l.graph();
    expect(importNodes(g).map((n) => n.name)).toEqual(['np', 'pd']);
    expect(g.steps).toEqual([0]);
  });

  test('a repeated import is one block with one execution per run', () => {
    const l = new L();
    l.imp('import os', 1, 'os', 'os', null);
    l.event(0, 'import', 'import os', { count: 2 });
    const node = importNodes(l.graph())[0]!;
    expect(node.executions.map((x) => x.i)).toEqual([0, 1]);
  });
});
