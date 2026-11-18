/**
 * Share links (SPEC "Share links"): `{v, code, files?}` as JSON, deflate-raw, base64url,
 * in the URL fragment as `#c=<payload>`. Pure apart from CompressionStream. Never throws:
 * failures come back as `{ ok: false, error }` with a message fit to show the user.
 */

/** Longest accepted payload (the base64url text after `c=`), in characters. */
export const MAX_LINK_BYTES = 8 * 1024;
/** Cap on the inflated JSON, so a small hostile link cannot expand without bound. */
export const MAX_INFLATED_BYTES = 1024 * 1024;
export const LINK_VERSION = 1;

export interface SharePayload {
  code: string;
  /** Small inline CSVs by file name. */
  files?: Record<string, string>;
}

export type EncodeResult =
  | { ok: true; fragment: string; bytes: number }
  | {
      ok: false;
      error: string;
      reason: 'too-big' | 'unsupported';
      /** True when the code alone would fit, so the UI can offer to share without data. */
      withoutDataFits: boolean;
    };

export type DecodeResult = { ok: true; payload: SharePayload } | { ok: false; error: string };

const enc = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates, aborting once the output passes `limit`. Returns null on corrupt input or overflow. */
async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function pack(p: SharePayload): Promise<string> {
  const body: Record<string, unknown> = { v: LINK_VERSION, code: p.code };
  if (p.files && Object.keys(p.files).length > 0) body.files = p.files;
  return toBase64Url(await deflate(enc.encode(JSON.stringify(body))));
}

/** Encodes a payload into the payload text for `#c=`. Refuses anything over MAX_LINK_BYTES. */
export async function encodeShare(p: SharePayload): Promise<EncodeResult> {
  try {
    const text = await pack(p);
    if (text.length <= MAX_LINK_BYTES) return { ok: true, fragment: text, bytes: text.length };
    const hasFiles = !!p.files && Object.keys(p.files).length > 0;
    const withoutDataFits = hasFiles && (await pack({ code: p.code })).length <= MAX_LINK_BYTES;
    const kb = (text.length / 1024).toFixed(1);
    return {
      ok: false,
      reason: 'too-big',
      withoutDataFits,
      error: withoutDataFits
        ? `This link would be ${kb} KB, over the ${MAX_LINK_BYTES / 1024} KB limit, because of the attached data. You can share the code without the data.`
        : `This link would be ${kb} KB, over the ${MAX_LINK_BYTES / 1024} KB limit. Shorten the code to share it.`,
    };
  } catch {
    return {
      ok: false,
      reason: 'unsupported',
      withoutDataFits: false,
      error: 'This browser cannot create share links (compression is not available).',
    };
  }
}

/** Decodes the payload text after `c=`. Never throws. */
export async function decodeShare(text: string): Promise<DecodeResult> {
  const bad = (error: string): DecodeResult => ({ ok: false, error });
  if (text.length === 0) return bad('The link has no code in it.');
  if (text.length > MAX_LINK_BYTES) {
    return bad(`The link is over the ${MAX_LINK_BYTES / 1024} KB limit, so it was not opened.`);
  }
  const raw = fromBase64Url(text);
  if (!raw)
    return bad('The link is damaged (it is not valid base64url). It may have been cut off.');
  let json: Uint8Array | null;
  try {
    json = await inflate(raw, MAX_INFLATED_BYTES);
  } catch {
    return bad('This browser cannot open share links (compression is not available).');
  }
  if (!json) return bad('The link is damaged or too large to open. It may have been cut off.');
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    return bad('The link is damaged (its contents could not be read).');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return bad('The link is damaged (unexpected contents).');
  }
  const d = data as Record<string, unknown>;
  if (d.v !== LINK_VERSION) {
    return bad(
      typeof d.v === 'number' && d.v > LINK_VERSION
        ? 'This link was made by a newer version of the tool. Reload the page or ask for a new link.'
        : 'The link is damaged (unknown version).',
    );
  }
  if (typeof d.code !== 'string') return bad('The link is damaged (no code).');
  const payload: SharePayload = { code: d.code };
  if (d.files !== undefined) {
    const f = d.files;
    if (
      typeof f !== 'object' ||
      f === null ||
      Array.isArray(f) ||
      !Object.values(f).every((x) => typeof x === 'string')
    ) {
      return bad('The link is damaged (bad data files).');
    }
    payload.files = { ...(f as Record<string, string>) };
  }
  return { ok: true, payload };
}

/** Pulls the payload text out of a location hash like `#c=...`; null when there is none. */
export function fragmentPayload(hash: string): string | null {
  const m = /^#?(?:.*&)?c=([^&]*)/.exec(hash);
  return m ? (m[1] as string) : null;
}

export function linkUrl(base: string, payload: string): string {
  return `${base.split('#')[0]}#c=${payload}`;
}
