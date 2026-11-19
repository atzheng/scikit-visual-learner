// Import nodes and callee wires (CONTRACTS.md section 8, "Import nodes"). Hand-written logs.
import { describe, expect, test } from 'vitest';
import { buildGraph } from './graph';
import type { CallNode, GraphModel } from './graph';
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
  ): void {
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

const readCsv = (sole: boolean, callLine = 3, root = 'pd'): GraphModel => {
  const l = new L();
  l.imp('import pandas as pd', 1, 'pd', 'pandas', null, sole);
  l.values['v1.0'] = { type: 'DataFrame' };
  l.call(`${root}.read_csv("a.csv")`, callLine, 'function', 'read_csv', { outputs: ['v1.0'] });
  return l.graph();
};

describe('import nodes', () => {
  test('a sole import gets a node and a callee wire into the call box', () => {
    const g = readCsv(true);
    const node = g.nodes.find((n) => n.kind === 'import');
    expect(node).toMatchObject({ name: 'pd', source: 'pandas' });
    const call = g.nodes.find((n): n is CallNode => n.kind === 'call')!;
    const wires = g.edges.filter((e) => e.callee);
    expect(wires).toHaveLength(1);
    expect(wires[0]).toMatchObject({
      from: { node: node!.id, port: null },
      to: { node: call.id, port: null },
      dashed: false,
      nameLabel: null,
    });
    // the instance box is created by the call: no wire from the import into it
    expect(g.edges.filter((e) => e.to.node.startsWith('i:') && e.from.node === node!.id)).toEqual(
      [],
    );
  });

  test('a rebound name (not sole) gets no callee wire and no import node', () => {
    const g = readCsv(false);
    expect(g.nodes.some((n) => n.kind === 'import')).toBe(false);
    expect(g.edges.some((e) => e.callee)).toBe(false);
  });

  test('a call before the import statement gets no wire', () => {
    const g = readCsv(true, 0);
    expect(g.edges.some((e) => e.callee)).toBe(false);
    expect(g.nodes.some((n) => n.kind === 'import')).toBe(false);
  });

  test('another root name gets no wire', () => {
    expect(readCsv(true, 3, 'np').edges.some((e) => e.callee)).toBe(false);
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
    expect(l.graph().edges.some((e) => e.callee)).toBe(false);
  });

  test('a machine method call and an unused import make no node', () => {
    const l = new L();
    l.imp('import numpy as np', 1, 'np', 'numpy', null);
    l.values['v1.0'] = { type: 'LinearRegression', machine: true };
    l.values['v1.1'] = { type: 'LinearRegression', machine: true };
    l.call('model.fit', 4, 'method', 'fit', { owner: 'v1.0', mutates: [['v1.0', 'v1.1']] });
    expect(l.graph().nodes.some((n) => n.kind === 'import')).toBe(false);
  });

  test('labels: module of a from-import, none when the name is the module, alias path', () => {
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
    const sources = Object.fromEntries(
      g.nodes.flatMap((n) => (n.kind === 'import' ? [[n.name, n.source]] : [])),
    );
    expect(sources).toEqual({
      LinearRegression: 'sklearn.linear_model',
      numpy: null,
      R: 'sklearn.linear_model.Ridge',
    });
    expect(g.edges.filter((e) => e.callee)).toHaveLength(3);
    // import nodes come first in source order
    expect(g.nodes[0]!.kind).toBe('import');
  });
});
