import { describe, expect, it } from 'vitest';
import { MAX_LINK_BYTES, decodeShare, encodeShare, fragmentPayload, linkUrl } from './link';

async function roundTrip(p: Parameters<typeof encodeShare>[0]) {
  const e = await encodeShare(p);
  if (!e.ok) throw new Error(e.error);
  const d = await decodeShare(e.fragment);
  if (!d.ok) throw new Error(d.error);
  return d.payload;
}

// Deterministic noise that deflate cannot shrink.
function noise(n: number): string {
  let x = 12345;
  let s = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += String.fromCharCode(33 + ((x >> 8) % 90));
  }
  return s;
}

async function packRaw(raw: Uint8Array): Promise<string> {
  const s = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const b = new Uint8Array(await new Response(s).arrayBuffer());
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
const packJson = (obj: unknown) => packRaw(new TextEncoder().encode(JSON.stringify(obj)));

describe('share links', () => {
  it('round-trips code', async () => {
    const code = 'import pandas as pd\ndf = pd.read_csv("listings.csv")\n';
    expect(await roundTrip({ code })).toEqual({ code });
  });
  it('round-trips files and non-ASCII', async () => {
    const p = { code: 'x = "naïve café 日本語 🙂"\n', files: { 'a.csv': 'a,b\n1,é\n' } };
    expect(await roundTrip(p)).toEqual(p);
  });
  it('produces url-safe text', async () => {
    const e = await encodeShare({ code: noise(300) });
    expect(e.ok && /^[A-Za-z0-9_-]+$/.test(e.fragment)).toBe(true);
  });
  it('refuses payloads over 8 KB', async () => {
    const big = await encodeShare({ code: noise(9000) });
    expect(big.ok).toBe(false);
    if (!big.ok) {
      expect(big.reason).toBe('too-big');
      expect(big.withoutDataFits).toBe(false);
    }
  });
  it('offers to drop data when the code alone fits', async () => {
    const r = await encodeShare({ code: 'x = 1\n', files: { 'd.csv': noise(9000) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.withoutDataFits).toBe(true);
  });
  it('accepts a payload just under the limit', async () => {
    const e = await encodeShare({ code: noise(5000) });
    expect(e.ok && e.bytes <= MAX_LINK_BYTES).toBe(true);
  });
  it('refuses oversized input on decode', async () => {
    expect((await decodeShare('A'.repeat(MAX_LINK_BYTES + 1))).ok).toBe(false);
  });
  it.each(['', '!!!', 'A', 'AAAA', 'not-a-link', '////'])(
    'corrupt input %j gives an error, not an exception',
    async (t) => {
      const d = await decodeShare(t);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.error.length).toBeGreaterThan(5);
    },
  );
  it('detects truncation', async () => {
    const e = await encodeShare({ code: noise(500) });
    if (!e.ok) throw new Error('encode');
    expect((await decodeShare(e.fragment.slice(0, e.fragment.length >> 1))).ok).toBe(false);
  });
  it('rejects wrong version and shape', async () => {
    expect((await decodeShare(await packJson({ v: 2, code: 'x' }))).ok).toBe(false);
    expect((await decodeShare(await packJson({ v: 1 }))).ok).toBe(false);
    expect((await decodeShare(await packJson({ v: 1, code: 'x', files: { a: 1 } }))).ok).toBe(
      false,
    );
    expect((await decodeShare(await packJson([1]))).ok).toBe(false);
  });
  it('stops a decompression bomb', async () => {
    const t = await packRaw(new Uint8Array(5 * 1024 * 1024));
    expect(t.length).toBeLessThan(MAX_LINK_BYTES);
    expect((await decodeShare(t)).ok).toBe(false);
  });
});

describe('fragment helpers', () => {
  it('extracts and builds', () => {
    expect(fragmentPayload('#c=abc')).toBe('abc');
    expect(fragmentPayload('#x=1&c=abc')).toBe('abc');
    expect(fragmentPayload('')).toBeNull();
    expect(fragmentPayload('#other')).toBeNull();
    expect(linkUrl('http://h/p?q=1#old', 'zz')).toBe('http://h/p?q=1#c=zz');
  });
});
