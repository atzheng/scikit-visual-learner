import { create } from 'zustand';
import { DATASETS } from '../course';
import { currentRuntime } from '../runtime/instance';
import { useStore } from '../store';
import {
  countRows,
  replayFiles,
  rowWarning,
  validateUpload,
  withFile,
  type DataFile,
} from './upload';

export interface FileNote {
  kind: 'error' | 'warn';
  text: string;
}

interface FilesState {
  /** Data files besides the course datasets. They live here so a restart can write them again. */
  files: DataFile[];
  notes: FileNote[];
  dismissNotes(): void;
}

export const useFiles = create<FilesState>()((set) => ({
  files: [],
  notes: [],
  dismissNotes: () => set({ notes: [] }),
}));

function pushNotes(notes: FileNote[]): void {
  useFiles.setState((s) => ({ notes: [...s.notes, ...notes] }));
}

/** Registers files and writes them now when Python is up; otherwise the next onReady does. */
async function register(added: DataFile[]): Promise<void> {
  useFiles.setState((s) => ({ files: added.reduce(withFile, s.files), notes: s.notes }));
  const rt = currentRuntime();
  if (rt && (rt.state === 'ready' || rt.state === 'running')) {
    await replayFiles(added, (n, b) => rt.writeFile(n, b)); // failures (a restart) are replayed
  }
}

/** Reads CSV files chosen by the student (button or drop). Problems show as notes. */
export async function addUploads(list: File[]): Promise<void> {
  const notes: FileNote[] = [];
  const added: DataFile[] = [];
  for (const f of list) {
    const problem = validateUpload(f, DATASETS);
    if (problem) {
      notes.push({ kind: 'error', text: problem });
      continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const rows = countRows(new TextDecoder().decode(bytes));
    const warn = rowWarning(f.name, rows);
    if (warn) notes.push({ kind: 'warn', text: warn });
    added.push({ name: f.name, bytes, rows, origin: 'upload' });
  }
  if (notes.length) pushNotes(notes);
  if (added.length) await register(added);
}

/** Data that came with a share link (already validated by the link decoder). */
export async function addLinkFiles(files: Record<string, string>): Promise<void> {
  const enc = new TextEncoder();
  const added = Object.entries(files)
    .filter(([name]) => !(DATASETS as readonly string[]).includes(name))
    .map(([name, text]): DataFile => ({
      name,
      bytes: enc.encode(text),
      rows: countRows(text),
      origin: 'link',
    }));
  if (added.length) await register(added);
}

/** After every (re)start of the worker its filesystem is empty again: write the files back. */
export function startFileReplay(): void {
  useStore.subscribe((s, prev) => {
    if (s.runtime.versions && s.runtime.versions !== prev.runtime.versions) {
      const rt = currentRuntime();
      const files = useFiles.getState().files;
      if (rt && files.length) void replayFiles(files, (n, b) => rt.writeFile(n, b));
    }
  });
}
