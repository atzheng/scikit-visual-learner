import { useStore } from '../store';

/** Placeholder: svl-bwv.3 replaces this with CodeMirror. */
export function Editor() {
  const source = useStore((s) => s.source);
  const setSource = useStore((s) => s.setSource);
  return (
    <textarea
      className="editor-placeholder"
      aria-label="Python code"
      spellCheck={false}
      value={source}
      onChange={(e) => setSource(e.target.value)}
    />
  );
}
