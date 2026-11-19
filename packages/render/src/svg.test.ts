import { describe, expect, test } from 'vitest';
import { buildGraph } from '@machines/log';
import type { Execution, InstanceNode } from '@machines/log';
import { linregLog } from '../dev/models';
import {
  attrRowsFor,
  badgeText,
  changedAttrs,
  dataRowModels,
  instanceRowModels,
  labelAnchor,
  roundedPath,
  statusOf,
  summaryLabel,
  truncate,
  wireTypeLabel,
  wrapText,
} from './svg';

const exec = (extra: Partial<Execution>): Execution => ({
  i: 0,
  ret: 0,
  inputs: {},
  outputs: {},
  count: 1,
  owner: null,
  error: null,
  interrupted: false,
  ...extra,
});

describe('roundedPath', () => {
  test('straight line', () => {
    expect(
      roundedPath([
        [0, 0],
        [0, 40],
      ]),
    ).toBe('M0 0L0 40');
  });
  test('rounds a corner and clips the radius to half the shorter segment', () => {
    expect(
      roundedPath(
        [
          [0, 0],
          [0, 20],
          [20, 20],
        ],
        8,
      ),
    ).toBe('M0 0L0 12Q0 20 8 20L20 20');
    expect(
      roundedPath(
        [
          [0, 0],
          [0, 6],
          [30, 6],
        ],
        8,
      ),
    ).toBe('M0 0L0 3Q0 6 3 6L30 6');
  });
  test('empty input', () => {
    expect(roundedPath([])).toBe('');
  });
});

describe('labelAnchor', () => {
  test('hugs the upper end of a long vertical run', () => {
    expect(
      labelAnchor([
        [10, 0],
        [10, 100],
      ]),
    ).toEqual({ x: 17, y: 22, anchor: 'start' });
  });
  test('short vertical run: beside its middle', () => {
    expect(
      labelAnchor([
        [10, 0],
        [10, 20],
      ]),
    ).toEqual({ x: 17, y: 14, anchor: 'start' });
  });
  test('horizontal run: above its middle', () => {
    expect(
      labelAnchor([
        [0, 5],
        [40, 5],
      ]),
    ).toEqual({ x: 20, y: -1, anchor: 'middle' });
  });
  test('no segments', () => {
    expect(labelAnchor([[1, 1]])).toBeNull();
  });
});

describe('labels and status', () => {
  test('badgeText', () => {
    expect(badgeText(3, 30, false)).toBe('3 of 30');
    expect(badgeText(30, 30, true)).toBe('×30');
  });
  test('summaryLabel', () => {
    expect(summaryLabel({ type: 'DataFrame', shape: [3, 4] })).toBe('DataFrame (3, 4)');
    expect(summaryLabel({ type: 'float', repr: '0.5' })).toBe('float 0.5');
    expect(
      summaryLabel({ type: 'LinearRegression', machine: true, repr: 'LinearRegression()' }),
    ).toBe('LinearRegression');
    expect(summaryLabel(undefined)).toBe('');
  });
  test('truncate collapses whitespace', () => {
    expect(truncate('a\n  b', 10)).toBe('a b');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
  test('statusOf', () => {
    expect(statusOf(undefined)).toBeNull();
    expect(statusOf(exec({}))).toBeNull();
    expect(
      statusOf(exec({ error: { type: 'ValueError', message: 'bad', handled: false } })),
    ).toEqual({
      kind: 'error',
      text: '⚠ ValueError: bad',
    });
    expect(statusOf(exec({ error: { type: 'KeyError', message: 'k', handled: true } }))?.kind).toBe(
      'handled',
    );
    expect(statusOf(exec({ interrupted: true }))).toEqual({
      kind: 'stopped',
      text: '⏹ stopped here',
    });
  });
  test('changedAttrs', () => {
    expect([...changedAttrs({ a: 't1', b: 't2' }, { a: 't1', b: 't3', c: 't4' })]).toEqual([
      'b',
      'c',
    ]);
    expect(changedAttrs(undefined, undefined).size).toBe(0);
  });
});

describe('instance rows', () => {
  const log = linregLog();
  const model = buildGraph(log, { expanded: new Set() });
  const inst = model.nodes.find(
    (n): n is InstanceNode => n.kind === 'instance' && n.className === 'LinearRegression',
  )!;
  test('rows follow the version: none before fit, three after', () => {
    expect(instanceRowModels(inst, inst.versions[0]!.token, log.values)).toEqual([]);
    const after = instanceRowModels(
      inst,
      inst.versions[inst.versions.length - 1]!.token,
      log.values,
    );
    expect(after.map((r) => `${r.name} ${r.detail}`)).toEqual([
      'coef_ ndarray',
      'intercept_ float',
      'n_features_in_ int',
    ]);
  });
  test('attrRowsFor reserves the union over versions', () => {
    expect(attrRowsFor(model, log)[inst.id]).toEqual([
      'coef_ ndarray',
      'intercept_ float',
      'n_features_in_ int',
    ]);
  });
});

describe('data box rows', () => {
  test('a DataFrame shows its shape and the first columns, cut with an ellipsis', () => {
    expect(
      dataRowModels({
        type: 'DF',
        shape: [120, 4],
        columns: ['beds', 'baths', 'sqft', 'year_built'],
      }),
    ).toEqual([
      { name: 'shape', detail: '(120, 4)', param: false },
      { name: 'columns', detail: 'beds, baths, sqft, …', param: false },
    ]);
    const wide = dataRowModels({
      type: 'DF',
      shape: [3, 9],
      columns: ['neighbourhood', 'price_per_sqft', 'year_built', 'beds', 'baths'],
    });
    expect(wide[1]!.detail).toBe('neighbourhood, …');
    expect(wide[1]!.detail.length).toBeLessThanOrEqual(30);
    const long = dataRowModels({ type: 'DF', shape: [1, 1], columns: ['a'.repeat(60)] });
    expect(long[1]!.detail).toHaveLength(26);
    expect(long[1]!.detail.endsWith('…')).toBe(true);
  });
  test('a Series or array shows shape and dtype; a list or an unknown value shows nothing', () => {
    expect(
      dataRowModels({ type: 'Series', shape: [96], dtype: 'float64' }).map((r) => r.name),
    ).toEqual(['shape', 'dtype']);
    expect(dataRowModels({ type: 'list[3]' })).toEqual([]);
    expect(dataRowModels(undefined)).toEqual([]);
  });
  test('wire type labels are for scalars only: an object box shows its own type', () => {
    const values = { s1: { type: 'float', repr: '0.2' }, v1: { type: 'DF', shape: [2, 2] } };
    expect(wireTypeLabel('s1', values)).toBe('float 0.2');
    expect(wireTypeLabel('v1.0', { 'v1.0': values.v1 })).toBe('');
  });
});

describe('changedAttrs on a real fit (golden_linreg)', () => {
  test('only attributes the fit set are marked; scalar hyperparameters are not', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { stateAt } = await import('@machines/log');
    const path = (d: string): string =>
      fileURLToPath(new URL(`../../../fixtures/${d}/golden_linreg.json`, import.meta.url));
    const log = JSON.parse(readFileSync(path('logs'), 'utf8'));
    const model = buildGraph(log);
    let found = false;
    for (let step = 1; step <= model.steps.length; step++) {
      const st = stateAt(model, log, step);
      const ev = log.events.find((e: { i: number }) => e.i === st.current);
      if (!ev?.name.endsWith('fit')) continue;
      found = true;
      const ch = changedAttrs(st.attrsBefore, st.attrsAfter, log.values);
      for (const a of ['coef_', 'intercept_', 'n_features_in_', 'rank_', 'singular_'])
        expect(ch.has(a), a).toBe(true);
      for (const a of ['copy_X', 'fit_intercept', 'n_jobs', 'positive', 'tol'])
        expect(ch.has(a), a).toBe(false);
    }
    expect(found).toBe(true);
  });
  test('wrapText keeps lines within the width', () => {
    const lines = wrapText('ValueError: a fairly long message that needs wrapping', 20);
    expect(lines.every((l) => l.length <= 20)).toBe(true);
    expect(lines.join(' ')).toBe('ValueError: a fairly long message that needs wrapping');
  });
});
