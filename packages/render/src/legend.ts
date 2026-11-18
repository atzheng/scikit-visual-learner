// Legend: explains shapes and colours (SPEC "Accessibility": every distinction also by shape, icon or text).
// Swatches reuse the diagram's own classes inside a wrapper group, so they follow the theme and its states.
import { SVG_NS } from './svg';

type Mk = (
  tag: string,
  attrs: Record<string, string | number>,
  cls?: string,
  text?: string,
) => SVGElement;

export interface LegendItem {
  label: string;
  /** Classes of the wrapper `<g>`: e.g. `md-node md-call md-error` styles the swatch like an error box. */
  cls: string;
  draw: (mk: Mk) => SVGElement[];
}

const W = 44;
const H = 24;
const box = (mk: Mk, extra: Record<string, string | number> = {}): SVGElement =>
  mk('rect', { x: 3, y: 4, width: 38, height: 16, rx: 5, ...extra }, 'md-box');
const wire = (mk: Mk, dashed: boolean): SVGElement =>
  mk(
    'path',
    { d: 'M3 12H40', 'marker-end': 'url(#md-arrow-legend-0)' },
    dashed ? 'md-wire md-dashed' : 'md-wire',
  );

export const LEGEND_ITEMS: LegendItem[] = [
  {
    label: 'Function or method call: inputs above, outputs below',
    cls: 'md-node md-call',
    draw: (mk) => [box(mk)],
  },
  {
    label: 'Machine with memory: name pill, attributes underneath',
    cls: 'md-node md-instance',
    draw: (mk) => [
      mk('rect', { x: 3, y: 2, width: 38, height: 20, rx: 6 }, 'md-inst-box'),
      mk('rect', { x: 6, y: 4, width: 32, height: 7, rx: 3.5 }, 'md-pill'),
    ],
  },
  {
    label: 'Wire: a value, labelled with its type and shape, then its name',
    cls: 'md-edge',
    draw: (mk) => [wire(mk, false)],
  },
  {
    label: 'Dashed wire: a value computed by an expression',
    cls: 'md-edge',
    draw: (mk) => [wire(mk, true)],
  },
  {
    label: 'Expression: italic text, no box',
    cls: 'md-node md-expr',
    draw: (mk) => [mk('text', { x: 22, y: 16 }, 'md-expr-text', 'a + b')],
  },
  {
    label: 'Store: an assignment into a container',
    cls: 'md-node md-store',
    draw: (mk) => [box(mk, { rx: 4 })],
  },
  {
    label: 'Current step: thick outline',
    cls: 'md-node md-call md-current',
    draw: (mk) => [box(mk)],
  },
  {
    label: '⚠ Error: red outline, message under the box',
    cls: 'md-node md-call md-error',
    draw: (mk) => [box(mk)],
  },
  {
    label: '⚠ handled: amber outline, the exception was caught',
    cls: 'md-node md-call md-handled',
    draw: (mk) => [box(mk)],
  },
  {
    label: '⏹ stopped here: dashed outline, the run was stopped',
    cls: 'md-node md-call md-stopped',
    draw: (mk) => [box(mk)],
  },
  {
    label: '● Changed attribute: bold, set by the current call',
    cls: 'md-attr md-changed',
    draw: (mk) => [
      mk('text', { x: 4, y: 16 }, 'md-bullet', '●'),
      mk('text', { x: 16, y: 16 }, 'md-aname', 'w_'),
    ],
  },
  {
    label: '×3 or 2 of 3: a box that ran several times, as in a loop',
    cls: 'md-badge',
    draw: (mk) => [
      mk('rect', { x: 3, y: 4, width: 38, height: 16, rx: 8 }, 'md-badge-bg'),
      mk('text', { x: 22, y: 16 }, 'md-badge-text', '×3'),
    ],
  },
];

/** A collapsible legend. Place it anywhere; it needs `theme.css`. */
export function createLegend(doc: Document = document, open = false): HTMLElement {
  const root = doc.createElement('details');
  root.className = 'md-legend';
  root.open = open;
  const summary = doc.createElement('summary');
  summary.textContent = 'Legend';
  root.append(summary);
  const list = doc.createElement('ul');
  const mk: Mk = (tag, attrs, cls, text) => {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (cls) el.setAttribute('class', cls);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  for (const [k, item] of LEGEND_ITEMS.entries()) {
    const li = doc.createElement('li');
    const svg = mk(
      'svg',
      { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' },
      'md-diagram',
    );
    // each swatch carries its own arrow marker: a marker inside a closed <details> would not render
    const id = `md-arrow-legend-${k}`;
    const marker = mk('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 8,
      markerHeight: 8,
      orient: 'auto',
      markerUnits: 'userSpaceOnUse',
    });
    marker.append(mk('path', { d: 'M0 1L10 5L0 9z' }, 'md-arrow'));
    const defs = mk('defs', {});
    defs.append(marker);
    svg.append(defs);
    const g = mk('g', {}, item.cls);
    g.append(...item.draw(mk));
    for (const w of g.querySelectorAll('[marker-end]')) w.setAttribute('marker-end', `url(#${id})`);
    svg.append(g);
    const span = doc.createElement('span');
    span.textContent = item.label;
    li.append(svg, span);
    list.append(li);
  }
  root.append(list);
  return root;
}
