import { describe, expect, test } from 'vitest';
import { docRequest, entryNames, inlinePieces, shortSignature } from './model';

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
