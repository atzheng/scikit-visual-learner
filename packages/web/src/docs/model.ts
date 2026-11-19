import type { DocTarget, EventLog, GraphModel, StepState } from '@machines/log';
import { summaryLabel } from '@machines/render';

/**
 * The request for a box's docs. Student definitions (module `__main__`) are read from the program text
 * of the run, which the log's sites refer to.
 */
export function docRequest(
  t: { module: string | null; name: string; attr?: boolean },
  runSource: string | null,
): DocTarget {
  const out: DocTarget = { module: t.module, name: t.name };
  if (t.attr) out.attr = true;
  if (t.module === '__main__' && runSource !== null) out.source = runSource;
  return out;
}

/** pandas signatures can run to dozens of keyword arguments: collapse past `max` characters. */
export function shortSignature(
  sig: string | null,
  max = 120,
): { text: string; cut: boolean } | null {
  if (sig === null) return null;
  const one = sig.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return { text: one, cut: false };
  const open = one.indexOf('(');
  const head = open >= 0 ? one.slice(0, open + 1) : '';
  return { text: `${head}…)`, cut: true };
}

/** Parameter names an entry documents: `x, y` gives both; `*args` gives `args`. */
export function entryNames(name: string): string[] {
  return name
    .split(',')
    .map((p) => p.trim().replace(/^\*+/, ''))
    .filter((p) => p !== '');
}

/**
 * The parameters this box's call passed, with their values at the shown step. Only when the box is the one
 * being documented (a "more methods" entry is a method this box does not have). The text of a constant is
 * what the student wrote; any other value is its type and shape.
 */
export function passedParams(
  model: GraphModel,
  log: EventLog,
  state: StepState | null,
  nodeId: string,
  target: { name: string },
): Map<string, string> {
  const out = new Map<string, string>();
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) return out;
  if (node.kind === 'instance') {
    if (node.className !== target.name) return out;
    for (const p of node.params) out.set(p.name, p.text);
    return out;
  }
  if (node.kind !== 'call' || node.name !== target.name) return out;
  const ex = state?.activeExecution.get(nodeId);
  if (!ex) return out;
  // Constants are not in `inputs` (the port carries their text); wired values are, by port id.
  for (const port of node.inPorts) {
    const param = port.param;
    if (param === 'self') continue;
    const prefix = `${param} = `;
    let text: string | undefined;
    if (port.constText !== undefined)
      text = port.constText.startsWith(prefix)
        ? port.constText.slice(prefix.length)
        : port.constText;
    else {
      const token = ex.inputs[port.id];
      if (token !== undefined) text = summaryLabel(log.values[token]);
    }
    if (text === undefined) continue;
    out.set(param, text);
    // `*arrays` of train_test_split is drawn as arrays[0], arrays[1]: the entry is `arrays`.
    const base = /^(.+)\[\d+\]$/.exec(param)?.[1];
    if (base !== undefined) out.set(base, out.has(base) ? `${out.get(base)}, ${text}` : text);
  }
  return out;
}

/**
 * The current value of the attribute a docs target names, at the shown step: a constructor parameter shows the
 * text the student wrote, a fitted attribute or data property its type and shape, an attribute-read box what
 * the read gave. Null when the target is not an attribute or the value is not known yet at this step.
 */
export function attributeValue(
  model: GraphModel,
  log: EventLog,
  state: StepState | null,
  nodeId: string,
  target: { name: string; attr?: boolean },
): string | null {
  if (!target.attr || !state) return null;
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const attr = target.name.slice(target.name.lastIndexOf('.') + 1);
  if (node.kind === 'instance') {
    const p = node.params.find((q) => q.name === attr);
    if (p) return p.text;
    const tok = state.activeVersion.get(nodeId);
    const t = tok !== undefined ? log.values[tok]?.attrs?.[attr] : undefined;
    if (t !== undefined) return summaryLabel(log.values[t]);
    const s = tok !== undefined ? log.values[tok] : undefined;
    if (attr === 'shape' && s?.shape) return `(${s.shape.join(', ')})`;
    if (attr === 'dtype' && s?.dtype) return s.dtype;
    if (attr === 'columns' && s?.columns) return s.columns.join(', ');
    return null;
  }
  if (node.kind === 'expr') {
    const out = state.activeExecution.get(nodeId)?.outputs['out:0'];
    return out !== undefined ? summaryLabel(log.values[out]) : null;
  }
  return null;
}

/** Splits text into plain and `code` pieces (single backticks mark code). */
export function inlinePieces(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  text.split(/(`[^`\n]+`)/).forEach((part, i) => {
    if (part === '') return;
    out.push(i % 2 === 1 ? { code: true, text: part.slice(1, -1) } : { code: false, text: part });
  });
  return out;
}
export const paragraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
