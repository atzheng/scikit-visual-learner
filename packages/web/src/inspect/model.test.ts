import { buildGraph, stateAt, type EventLog } from '@machines/log';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  attrRows,
  edgeToken,
  inspectTarget,
  placePopover,
  previewOmitted,
  summaryTitle,
  truncationNote,
} from './model';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'logs',
);
const readLog = (n: string): EventLog =>
  JSON.parse(readFileSync(join(ROOT, `${n}.json`), 'utf8')) as EventLog;

describe('placePopover', () => {
  const vp = { w: 1000, h: 800 };
  const size = { w: 300, h: 200 };
  test('below and right of the pointer when there is room', () => {
    expect(placePopover({ x: 100, y: 100 }, size, vp)).toEqual({ x: 112, y: 112 });
  });
  test('flips to the left and above near the far edges', () => {
    const p = placePopover({ x: 950, y: 780 }, size, vp);
    expect(p).toEqual({ x: 950 - 12 - 300, y: 780 - 12 - 200 });
  });
  test('always inside the viewport, for any pointer position', () => {
    for (const x of [-50, 0, 3, 500, 995, 1000, 1200])
      for (const y of [-50, 0, 3, 400, 795, 800, 1000]) {
        const p = placePopover({ x, y }, size, vp);
        expect(p.x).toBeGreaterThanOrEqual(8);
        expect(p.y).toBeGreaterThanOrEqual(8);
        expect(p.x + size.w).toBeLessThanOrEqual(vp.w - 8);
        expect(p.y + size.h).toBeLessThanOrEqual(vp.h - 8);
      }
  });
  test('larger than the viewport: the top-left corner stays visible', () => {
    expect(placePopover({ x: 50, y: 50 }, { w: 2000, h: 2000 }, vp)).toEqual({ x: 8, y: 8 });
  });
});

describe('summaries', () => {
  test('title has type and shape', () => {
    expect(summaryTitle({ type: 'DF', shape: [150, 4] })).toBe('DF (150 × 4)');
    expect(summaryTitle({ type: 'float', repr: '1.5' })).toBe('float');
    expect(summaryTitle(undefined)).toBe('value unavailable');
  });
  test('preview omitted only for data values without a preview', () => {
    expect(previewOmitted({ type: 'array', shape: [3] })).toBe(true);
    expect(previewOmitted({ type: 'float', repr: '1' })).toBe(false);
    expect(
      previewOmitted({ type: 'array', shape: [1], preview: { kind: 'matrix', rows: [['1']] } }),
    ).toBe(false);
  });
  test('a 1-D array is one row of values', () => {
    const row = [['0', '1', '2', '3', '4']];
    expect(
      truncationNote({ type: 'array', shape: [12], preview: { kind: 'matrix', rows: row } }),
    ).toBe('first 5 of 12 values');
  });
  test('truncation note names what was cut', () => {
    const rows = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => '0'));
    expect(
      truncationNote({ type: 'array', shape: [100, 20], preview: { kind: 'matrix', rows } }),
    ).toBe('first 5 of 100 rows, first 5 of 20 columns');
    expect(
      truncationNote({ type: 'array', shape: [5, 5], preview: { kind: 'matrix', rows } }),
    ).toBeNull();
  });
});

describe('attrRows', () => {
  test('changed, added and removed attributes come first', () => {
    const rows = attrRows({ a: 'v1', b: 's1', c: 's2' }, { a: 'v1', b: 's9', d: 's3' });
    expect(rows.map((r) => [r.name, r.changed])).toEqual([
      ['b', true],
      ['d', true],
      ['c', true],
      ['a', false],
    ]);
    expect(rows.find((r) => r.name === 'd')?.before).toBeNull();
    expect(rows.find((r) => r.name === 'c')?.after).toBeNull();
  });
  test('equal scalars observed twice are not a change', () => {
    const values = {
      s1: { type: 'bool', repr: 'True' },
      s2: { type: 'bool', repr: 'True' },
      s3: { type: 'int', repr: '4' },
    };
    expect(attrRows({ a: 's1' }, { a: 's2' }, values)[0]!.changed).toBe(false);
    expect(attrRows({ a: 's1' }, { a: 's3' }, values)[0]!.changed).toBe(true);
  });
  test('missing sides count as empty', () => {
    expect(attrRows(undefined, undefined)).toEqual([]);
  });
});

describe('golden_linreg: the fit step', () => {
  const log = readLog('golden_linreg');
  const model = buildGraph(log);
  const inst = model.nodes.find((n) => n.kind === 'instance' && n.className === 'LinearRegression');

  test('the panel at the fit call shows coef_ and intercept_ as changed', () => {
    expect(inst).toBeDefined();
    let found = false;
    for (let s = 1; s <= model.steps.length; s++) {
      const st = stateAt(model, log, s);
      const t = inspectTarget(model, log, st, undefined);
      if (
        t?.call &&
        t.node.id === inst!.id &&
        Object.keys(t.after).length > Object.keys(t.before).length
      ) {
        const changed = attrRows(t.before, t.after, log.values)
          .filter((r) => r.changed)
          .map((r) => r.name);
        expect(changed).toContain('coef_');
        expect(changed).toContain('intercept_');
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  test('a selected instance at a step that is not its call shows its attributes unchanged', () => {
    const st = stateAt(model, log, model.steps.length);
    const t = inspectTarget(model, log, st, inst!.id);
    expect(t).not.toBeNull();
    expect(t!.before).toEqual(t!.after);
    expect(attrRows(t!.before, t!.after, log.values).some((r) => r.changed)).toBe(false);
  });

  test('no instance, no panel', () => {
    expect(inspectTarget(model, log, stateAt(model, log, 0), undefined)).toBeNull();
  });

  test('every visible wire has a token to preview', () => {
    const st = stateAt(model, log, model.steps.length);
    for (const e of model.edges.filter((x) => !x.callee && st.visibleEdges.has(x.id)))
      expect(edgeToken(model, st, e.id)).not.toBeNull();
  });
});
