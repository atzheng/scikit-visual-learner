import { describe, expect, it } from 'vitest';
import { lineStarts, siteAt, siteRange, type SpanSite } from './spans';

const site = (line: number, col: number, end_line: number, end_col: number, id = 0): SpanSite => ({
  id,
  kind: 'call',
  line,
  col,
  end_line,
  end_col,
});

describe('siteRange', () => {
  it('maps ASCII columns', () => {
    const src = 'x = 1\ny = f(2)\n';
    expect(siteRange(src, site(2, 4, 2, 8))).toEqual({ from: 10, to: 14 });
  });
  it('maps a call after a line containing cafe with an accent', () => {
    const src = 'name = "caf\u00e9"; f(name)\n';
    const col = [...src].lastIndexOf('f');
    const r = siteRange(src, site(1, col, 1, col + 7))!;
    expect(src.slice(r.from, r.to)).toBe('f(name)');
  });
  it('counts astral characters as one code point', () => {
    const src = 's = "\u{1F600}"; f(s)\n';
    const col = [...src].lastIndexOf('f');
    expect(col).not.toBe(src.indexOf('f'));
    const r = siteRange(src, site(1, col, 1, col + 4))!;
    expect(src.slice(r.from, r.to)).toBe('f(s)');
  });
  it('treats tabs as one column', () => {
    const src = 'if x:\n\tf(1)\n';
    const r = siteRange(src, site(2, 1, 2, 5))!;
    expect(src.slice(r.from, r.to)).toBe('f(1)');
  });
  it('handles multi-line spans and CRLF', () => {
    const src = 'a = f(\r\n  1,\r\n  2)\r\n';
    const r = siteRange(src, site(1, 4, 3, 4))!;
    expect(src.slice(r.from, r.to)).toBe('f(\r\n  1,\r\n  2)');
  });
  it('returns null outside the source', () => {
    expect(siteRange('x\n', site(9, 0, 9, 1))).toBeNull();
  });
  it('clamps columns to the line', () => {
    expect(siteRange('ab\ncd', site(1, 0, 1, 50))).toEqual({ from: 0, to: 2 });
  });
});

describe('lineStarts', () => {
  it('splits on LF, CRLF and CR', () => {
    expect(lineStarts('a\nb\r\nc\rd')).toEqual([0, 2, 5, 7]);
  });
});

describe('siteAt', () => {
  const src = 'model.fit(scale(X), y)\n';
  const outer = site(1, 0, 1, 22, 0);
  const inner = site(1, 10, 1, 18, 1);
  it('returns the innermost containing site', () => {
    expect(siteAt([outer, inner], 14, src)?.id).toBe(1);
    expect(siteAt([inner, outer], 14, src)?.id).toBe(1);
    expect(siteAt([outer, inner], 20, src)?.id).toBe(0);
  });
  it('includes the span ends', () => {
    expect(siteAt([outer, inner], 18, src)?.id).toBe(1);
    expect(siteAt([outer], 22, src)?.id).toBe(0);
  });
  it('returns null outside every site or for non-call sites', () => {
    expect(siteAt([inner], 2, src)).toBeNull();
    expect(siteAt([{ ...outer, kind: 'bind' }], 5, src)).toBeNull();
  });
});
