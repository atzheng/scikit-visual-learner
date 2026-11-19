import type { SummaryPart } from '@machines/log';

/** A step summary: text runs as text, names and source as code (monospace and a border, not colour alone). */
export function SummaryText({ parts }: { parts: readonly SummaryPart[] }) {
  return (
    <>
      {parts.map((p, k) =>
        p.kind === 'code' ? (
          <code key={k} className="summary-code">
            {p.text}
          </code>
        ) : (
          <span key={k}>{p.text}</span>
        ),
      )}
    </>
  );
}
