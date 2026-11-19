import { buildGraph, stateAt, type EventLog, type InstanceNode } from '@machines/log';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { attributeValue, docRequest, entryNames, inlinePieces, shortSignature } from './model';

describe('docs model', () => {
  test('student targets carry the run source, library targets do not', () => {
    expect(docRequest({ module: '__main__', name: 'f' }, 'x = 1')).toEqual({
      module: '__main__',
      name: 'f',
      source: 'x = 1',
    });
    expect(docRequest({ module: 'pandas', name: 'read_csv' }, 'x = 1')).toEqual({
      module: 'pandas',
      name: 'read_csv',
    });
  });
  test('an attribute target keeps its flag', () => {
    expect(
      docRequest({ module: 'sklearn.linear_model', name: 'Ridge.alpha', attr: true }, 'x'),
    ).toEqual({
      module: 'sklearn.linear_model',
      name: 'Ridge.alpha',
      attr: true,
    });
    expect(docRequest({ module: '__main__', name: 'M.w_', attr: true }, 'src')).toEqual({
      module: '__main__',
      name: 'M.w_',
      attr: true,
      source: 'src',
    });
  });
  test('the current value of an attribute at the shown step', () => {
    const log = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/logs/edge_expr.json'),
        'utf8',
      ),
    ) as EventLog;
    const model = buildGraph(log, { expanded: new Set() });
    const inst = model.nodes.find(
      (n): n is InstanceNode => n.kind === 'instance' && n.className === 'LinearRegression',
    )!;
    const read = model.nodes.find((n) => n.kind === 'expr' && n.text === 'model.coef_')!;
    const end = stateAt(model, log, model.steps.length);
    const t = { name: 'LinearRegression.coef_', attr: true };
    expect(attributeValue(model, log, end, inst.id, t)).toBe('array (3)');
    expect(attributeValue(model, log, end, read.id, t)).toBe('array (3)');
    expect(attributeValue(model, log, stateAt(model, log, 0), inst.id, t)).toBeNull();
    expect(attributeValue(model, log, end, inst.id, { name: 'LinearRegression.coef_' })).toBeNull();
  });
  test('long signatures collapse to the name', () => {
    expect(shortSignature('f(a, b)')).toEqual({ text: 'f(a, b)', cut: false });
    const long = `read_csv(${'a=1, '.repeat(60)})`;
    expect(shortSignature(long)).toEqual({ text: 'read_csv(…)', cut: true });
    expect(shortSignature(null)).toBeNull();
  });
  test('entry names and inline code', () => {
    expect(entryNames('x, y')).toEqual(['x', 'y']);
    expect(entryNames('*args')).toEqual(['args']);
    expect(inlinePieces('use `a` here')).toEqual([
      { code: false, text: 'use ' },
      { code: true, text: 'a' },
      { code: false, text: ' here' },
    ]);
  });
});
