import { describe, expect, it } from 'vitest';
import { STARTER_EXAMPLE } from '../course';
import {
  MAX_UPLOAD_BYTES,
  countRows,
  replayFiles,
  resolveLinkFiles,
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
  it('posts every write before the first one finishes, with its own buffer copy', async () => {
    const files = [df('a.csv', 'x\n1\n'), df('b.csv', 'y\n2\n')];
    const posted: string[] = [];
    const pending: (() => void)[] = [];
    const done = replayFiles(files, (n, b) => {
      posted.push(`${n}:${new TextDecoder().decode(b)}`);
      return new Promise<void>((res) => pending.push(res));
    });
    expect(posted).toEqual(['a.csv:x\n1\n', 'b.csv:y\n2\n']); // both before any ack
    pending.forEach((r) => r());
    expect(await done).toEqual([]);
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
    expect(sharableFiles([df('a.csv', 'x\n1\n')])).toEqual({
      files: { 'a.csv': 'x\n1\n' },
      tooLarge: [],
      skipped: [],
    });
  });
  it('sharableFiles checks size on bytes and skips non-UTF-8 files', () => {
    const big: DataFile = { ...df('big.csv'), bytes: new Uint8Array(300 * 1024).fill(97) };
    const latin1: DataFile = { ...df('l.csv'), bytes: Uint8Array.of(0x78, 0x0a, 0xe9, 0x0a) };
    const r = sharableFiles([latin1, big]);
    expect(r.tooLarge).toEqual(['big.csv']);
    expect(r.skipped).toEqual(['l.csv']);
    expect(r.files).toEqual({});
  });
});

describe('starter example', () => {
  it('is the notebook fixture and reads a course dataset', () => {
    expect(STARTER_EXAMPLE).toContain('pd.read_csv("listings.csv")');
  });
});

describe('resolveLinkFiles', () => {
  const link = (name: string, text = 'a\n1\n'): DataFile => ({ ...df(name, text), origin: 'link' });
  it('adds files that do not clash', () => {
    const r = resolveLinkFiles([link('n.csv')], [df('m.csv')], ['listings.csv']);
    expect(r.files.map((f) => f.name)).toEqual(['n.csv']);
    expect(r.renamed).toEqual([]);
  });
  it('renames a link file that clashes with an upload or a course dataset', () => {
    const r = resolveLinkFiles(
      [link('m.csv', 'z\n9\n'), link('listings.csv')],
      [df('m.csv', 'x\n1\n')],
      ['listings.csv'],
    );
    expect(r.files.map((f) => f.name)).toEqual(['m (link).csv', 'listings (link).csv']);
    expect(r.renamed).toHaveLength(2);
  });
  it('ignores identical content, and replaces an earlier link file of the same name', () => {
    expect(resolveLinkFiles([link('m.csv')], [df('m.csv')], []).files).toEqual([]);
    const r = resolveLinkFiles([link('k.csv', 'q\n1\n')], [link('k.csv')], []);
    expect(r.files.map((f) => f.name)).toEqual(['k.csv']);
  });
});
