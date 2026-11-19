import { describe, expect, it } from 'vitest';
import type { OutputEntry } from '@machines/log';
import { frameLabel, libraryLabel, outputItems, parseWarning, repeatLabel } from './model';

describe('output model', () => {
  it('parses warnings with their student line', () => {
    expect(parseWarning('11: FutureWarning: legacy API')).toEqual({
      line: 11,
      category: 'FutureWarning',
      message: 'legacy API',
    });
    expect(parseWarning('just text')).toEqual({
      line: null,
      category: 'Warning',
      message: 'just text',
    });
  });

  it('merges consecutive stdout and numbers figures', () => {
    const e: OutputEntry[] = [
      { i: 1, stream: 'stdout', text: 'a\n' },
      { i: 2, stream: 'stdout', text: 'b\n' },
      { i: 2, stream: 'warning', text: '3: UserWarning: x' },
      { i: 3, stream: 'figure', png: 'AA', width: 1, height: 1 },
      { i: 4, stream: 'figure', png: 'BB', width: 1, height: 1 },
    ];
    const items = outputItems(e);
    expect(items.map((x) => x.kind)).toEqual(['stdout', 'warning', 'figure', 'figure']);
    expect(items[0]).toMatchObject({ text: 'a\nb\n' });
    expect(items[3]).toMatchObject({ n: 2 });
  });

  it('labels frames', () => {
    expect(libraryLabel({ kind: 'library', count: 3, modules: ['pandas', 'sklearn'] })).toBe(
      '… 3 frames in pandas, sklearn',
    );
    const f = { kind: 'student', line: 4, text: '', name: 'f', repeat: 5 } as const;
    expect(frameLabel(f)).toBe('line 4 in f');
    expect(repeatLabel(f)).toBe('repeated 5 times');
  });
});
