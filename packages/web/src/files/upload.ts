/**
 * Data files (SPEC "User experience" 2, "Hard limits"): validation, row counting and replay.
 * Pure; the store and UI are in files/filesStore.ts and files/FilesUI.tsx. Uploads never leave
 * the browser: they go from the File into the worker's filesystem and nowhere else.
 */

import { checkFiles } from '../share/link';

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

/** Writes every file again, e.g. into a fresh worker. Returns the names that failed. */
export async function replayFiles(
  files: readonly DataFile[],
  write: (name: string, bytes: ArrayBuffer) => Promise<unknown>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files) {
    try {
      await write(f.name, f.bytes.slice().buffer); // a copy: postMessage transfers the buffer
    } catch {
      failed.push(f.name);
    }
  }
  return failed;
}

/** Text of the files for a share link (SPEC "Share links": small inline data). */
export function sharableFiles(files: readonly DataFile[]): Record<string, string> {
  const dec = new TextDecoder();
  return Object.fromEntries(files.map((f) => [f.name, dec.decode(f.bytes)]));
}

/** Adds or replaces by name. */
export function withFile(files: readonly DataFile[], f: DataFile): DataFile[] {
  return [...files.filter((x) => x.name !== f.name), f];
}
