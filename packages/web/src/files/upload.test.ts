import { describe, expect, it } from 'vitest';
import { STARTER_EXAMPLE } from '../course';
import {
  MAX_UPLOAD_BYTES,
  countRows,
  replayFiles,
  rowWarning,
  sharableFiles,
  validateUpload,
  withFile,
  type DataFile,
} from './upload';

const df = (name: string, text = 'a\n1\n'): DataFile => ({
  name,
  bytes: new TextEncoder().encode(text),
  rows: countRows(text),
  origin: 'upload',
});

describe('validateUpload', () => {
  it('accepts a csv', () => expect(validateUpload({ name: 'a.csv', size: 10 })).toBeNull());
  it('accepts upper-case extension', () =>
    expect(validateUpload({ name: 'A.CSV', size: 10 })).toBeNull());
  it('rejects other types, empty and oversize files', () => {
    expect(validateUpload({ name: 'a.xlsx', size: 10 })).toMatch(/not a .csv/);
    expect(validateUpload({ name: 'a.csv', size: 0 })).toMatch(/empty/);
    expect(validateUpload({ name: 'a.csv', size: MAX_UPLOAD_BYTES + 1 })).toMatch(/larger/);
  });
  it('rejects names that cannot go into a link or the filesystem', () => {
    expect(validateUpload({ name: 'a/b.csv', size: 1 })).toMatch(/cannot be used/);
    expect(validateUpload({ name: '..csv', size: 1 })).toMatch(/cannot be used/);
  });
  it('does not overwrite a course dataset', () => {
    expect(validateUpload({ name: 'listings.csv', size: 1 }, ['listings.csv'])).toMatch(/course/);
  });
});

describe('countRows', () => {
  it('counts data rows without the header', () => {
    expect(countRows('a,b\n1,2\n3,4\n')).toBe(2);
    expect(countRows('a,b\r\n1,2\r\n3,4')).toBe(2);
    expect(countRows('a,b\n')).toBe(0);
    expect(countRows('')).toBe(0);
  });
  it('ignores blank lines and newlines inside quotes', () => {
    expect(countRows('a,b\n\n1,"x\ny"\n\n2,3\n')).toBe(2);
    expect(countRows('a\n"he said ""hi""\nthere"\n')).toBe(1);
  });
});

describe('rowWarning', () => {
  it('warns above 10,000 rows only', () => {
    expect(rowWarning('big.csv', 10_000)).toBeNull();
    expect(rowWarning('big.csv', 12_000)).toMatch(/12,000 rows/);
  });
});

describe('replayFiles', () => {
  it('writes every file in order, each with its own buffer copy', async () => {
    const files = [df('a.csv', 'x\n1\n'), df('b.csv', 'y\n2\n')];
    const seen: [string, string][] = [];
    const failed = await replayFiles(files, async (n, b) => {
      seen.push([n, new TextDecoder().decode(b)]);
      structuredClone(b, { transfer: [b] }); // detaches it, as postMessage does
    });
    expect(failed).toEqual([]);
    expect(seen).toEqual([
      ['a.csv', 'x\n1\n'],
      ['b.csv', 'y\n2\n'],
    ]);
    // the stored bytes survive for the next restart
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe('x\n1\n');
  });
  it('reports failures and keeps going', async () => {
    const failed = await replayFiles([df('a.csv'), df('b.csv')], async (n) => {
      if (n === 'a.csv') throw new Error('restarted');
    });
    expect(failed).toEqual(['a.csv']);
  });
});

describe('files helpers', () => {
  it('withFile replaces by name', () => {
    const out = withFile([df('a.csv', 'x\n1\n'), df('b.csv')], df('a.csv', 'x\n1\n2\n'));
    expect(out.map((f) => f.name).sort()).toEqual(['a.csv', 'b.csv']);
    expect(out.find((f) => f.name === 'a.csv')?.rows).toBe(2);
  });
  it('sharableFiles gives file text by name', () => {
    expect(sharableFiles([df('a.csv', 'x\n1\n')])).toEqual({ 'a.csv': 'x\n1\n' });
  });
});

describe('starter example', () => {
  it('is the notebook fixture and reads a course dataset', () => {
    expect(STARTER_EXAMPLE).toContain('pd.read_csv("listings.csv")');
  });
});
