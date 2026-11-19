/**
 * Data files (SPEC "User experience" 2, "Hard limits"): validation, row counting and replay.
 * Pure; the store and UI are in files/filesStore.ts and files/FilesUI.tsx. Uploads never leave
 * the browser: they go from the File into the worker's filesystem and nowhere else.
 */

import { MAX_FILES_CHARS, checkFiles } from '../share/link';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** SPEC "Hard limits": warn above this many rows. */
export const ROW_WARN_LIMIT = 10_000;

export interface DataFile {
  name: string;
  bytes: Uint8Array;
  rows: number;
  /** 'upload': chosen by the student; 'link': came with a share link. */
  origin: 'upload' | 'link';
}

function shortName(n: string): string {
  return n.length > 40 ? `${n.slice(0, 39)}…` : n;
}

/** Returns why a file cannot be added, or null. `reserved` are names of course datasets. */
export function validateUpload(
  file: { name: string; size: number },
  reserved: readonly string[] = [],
): string | null {
  if (!/\.csv$/i.test(file.name)) return `${shortName(file.name)} is not a .csv file.`;
  if (checkFiles({ [file.name]: '' }) !== null) {
    return `${shortName(file.name)} has a name that cannot be used.`;
  }
  if (reserved.includes(file.name)) {
    return `${file.name} is a course dataset. Rename your file to upload it.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

/** Data rows: records minus the header. Newlines inside quoted fields do not start a record. */
export function countRows(text: string): number {
  let records = 0;
  let inQuotes = false;
  let lineHasContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes; // an escaped "" toggles twice
      lineHasContent = true;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (lineHasContent) records++;
      lineHasContent = false;
    } else if (ch !== ' ' && ch !== '\t') {
      lineHasContent = true;
    }
  }
  if (lineHasContent) records++;
  return Math.max(0, records - 1);
}

export function rowWarning(name: string, rows: number): string | null {
  return rows > ROW_WARN_LIMIT
    ? `${name} has ${rows.toLocaleString('en-US')} rows. Above ${ROW_WARN_LIMIT.toLocaleString('en-US')} rows the diagram and previews may be slow.`
    : null;
}

/**
 * Writes every file again, e.g. into a fresh worker. All writes are posted at once, before the
 * first ack: the worker handles messages in order, so a Run clicked meanwhile is posted after
 * every file. Returns the names that failed.
 */
export async function replayFiles(
  files: readonly DataFile[],
  write: (name: string, bytes: ArrayBuffer) => Promise<unknown>,
): Promise<string[]> {
  const results = await Promise.allSettled(
    files.map((f) => write(f.name, f.bytes.slice().buffer)), // a copy: postMessage transfers it
  );
  return files.filter((_, i) => results[i]?.status === 'rejected').map((f) => f.name);
}

export interface ShareFiles {
  files: Record<string, string>;
  /** Files too large to inline; their presence means the link cannot carry the data. */
  tooLarge: string[];
  /** Files that are not valid UTF-8 and so cannot be shared losslessly; left out. */
  skipped: string[];
}

/**
 * Text of the files for a share link (SPEC "Share links": small inline data). Sizes are checked
 * on the bytes first, so a large upload is never decoded just to be refused.
 */
export function sharableFiles(files: readonly DataFile[]): ShareFiles {
  const dec = new TextDecoder('utf-8', { fatal: true });
  const out: ShareFiles = { files: {}, tooLarge: [], skipped: [] };
  let total = 0;
  for (const f of files) {
    total += f.bytes.length; // characters never outnumber bytes, so this is an upper bound
    if (total > MAX_FILES_CHARS) {
      out.tooLarge.push(f.name);
      continue;
    }
    try {
      out.files[f.name] = dec.decode(f.bytes);
    } catch {
      out.skipped.push(f.name);
    }
  }
  return out;
}

/**
 * Files that came with a link must not replace or hide anything: a name already used by a
 * student's upload or a course dataset gets a "(link)" suffix. Identical content is not a clash.
 */
export function resolveLinkFiles(
  incoming: readonly DataFile[],
  existing: readonly DataFile[],
  reserved: readonly string[],
): { files: DataFile[]; renamed: { from: string; to: string }[] } {
  const mine = new Map(existing.filter((f) => f.origin === 'upload').map((f) => [f.name, f]));
  const taken = new Set([...reserved, ...existing.map((f) => f.name)]);
  const files: DataFile[] = [];
  const renamed: { from: string; to: string }[] = [];
  for (const f of incoming) {
    const clash = mine.get(f.name);
    if (clash && sameBytes(clash.bytes, f.bytes)) continue;
    if (!clash && !reserved.includes(f.name)) {
      files.push(f);
      continue;
    }
    const stem = f.name.replace(/\.csv$/i, '');
    let n = 1;
    let to = `${stem} (link).csv`;
    while (taken.has(to) || files.some((x) => x.name === to)) to = `${stem} (link ${++n}).csv`;
    renamed.push({ from: f.name, to });
    files.push({ ...f, name: to });
  }
  return { files, renamed };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Adds or replaces by name. */
export function withFile(files: readonly DataFile[], f: DataFile): DataFile[] {
  return [...files.filter((x) => x.name !== f.name), f];
}
