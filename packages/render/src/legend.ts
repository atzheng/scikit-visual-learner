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
  /** Stable key, so later beads can add or look up an entry. */
  id: string;
  /** What the renderer draws that this entry explains: a node kind (`call`, `instance`, `expr`, `store`, `source`), `edge`, or a style name. */
  covers: string[];
  label: string;
  /** `basic` entries show at first; `more` entries sit behind the "More" expander (svl-1x4). */
  level: 'basic' | 'more';
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
    id: 'instance',
    covers: ['instance'],
    label: 'Class instance: its name and attributes, with its methods inside',
    level: 'basic',
    cls: 'md-node md-instance',
    draw: (mk) => [
      mk('rect', { x: 3, y: 2, width: 38, height: 20, rx: 6 }, 'md-inst-box'),
      mk('rect', { x: 6, y: 4, width: 32, height: 7, rx: 3.5 }, 'md-pill'),
    ],
  },
  {
    id: 'call',
    covers: ['call', 'store'],
    label: 'Function or method call: inputs above, outputs below',
    level: 'basic',
    cls: 'md-node md-call',
    draw: (mk) => [box(mk)],
  },
  {
    id: 'import',
    covers: ['import'],
    label: 'Import: a name an import statement placed on the board, with its module',
    level: 'more',
    cls: 'md-node md-import',
    draw: (mk) => [box(mk)],
  },
  {
    id: 'wire',
    covers: ['edge'],
    label: 'Wire: a value, labelled with its type and shape, then its name',
    level: 'more',
    cls: 'md-edge',
    draw: (mk) => [wire(mk, false)],
  },
  {
    id: 'dashed-wire',
    covers: ['edge-dashed'],
    label: 'Dashed wire: a value computed by an expression',
    level: 'more',
    cls: 'md-edge',
    draw: (mk) => [wire(mk, true)],
  },
  {
    id: 'expr',
    covers: ['expr'],
    label: 'Expression: italic text, no box',
    level: 'more',
    cls: 'md-node md-expr',
    draw: (mk) => [mk('text', { x: 22, y: 16 }, 'md-expr-text', 'a + b')],
  },
  {
    id: 'source',
    covers: ['source'],
    label: 'Value: data that came from outside the traced calls, as plain text',
    level: 'more',
    cls: 'md-node md-source',
    draw: (mk) => [mk('text', { x: 22, y: 16 }, 'md-source-text', 'X')],
  },
  {
    id: 'port',
    covers: ['port'],
    label: 'Port: a dot where a wire enters or leaves, with its type and name',
    level: 'more',
    cls: 'md-node md-call',
    draw: (mk) => [
      box(mk),
      mk('circle', { cx: 22, cy: 4, r: 3 }, 'md-port'),
      mk('circle', { cx: 22, cy: 20, r: 3 }, 'md-port'),
    ],
  },
  {
    id: 'const-port',
    covers: ['const-port'],
    label: 'Constant input: the literal value written above the box, no wire',
    level: 'more',
    cls: 'md-node md-call',
    draw: (mk) => [box(mk, { y: 8, height: 14 }), mk('text', { x: 22, y: 7 }, 'md-ptype', '0.5')],
  },
  {
    id: 'current',
    covers: ['current'],
    label: 'Current step: thick outline',
    level: 'more',
    cls: 'md-node md-call md-current',
    draw: (mk) => [box(mk)],
  },
  {
    id: 'error',
    covers: ['error', 'handled'],
    label: '⚠ Error: red outline, message under the box (also for an error the program caught)',
    level: 'more',
    cls: 'md-node md-call md-error',
    draw: (mk) => [box(mk)],
  },
  {
    id: 'stopped',
    covers: ['stopped'],
    label: '⏹ stopped here: dashed outline, the run was stopped',
    level: 'more',
    cls: 'md-node md-call md-stopped',
    draw: (mk) => [box(mk)],
  },
  {
    id: 'changed-attr',
    covers: ['changed'],
    label: '● Changed attribute: bold, set by the current call',
    level: 'more',
    cls: 'md-attr md-changed',
    draw: (mk) => [
      mk('text', { x: 4, y: 16 }, 'md-bullet', '●'),
      mk('text', { x: 16, y: 16 }, 'md-aname', 'w_'),
    ],
  },
  {
    id: 'uncalled',
    covers: ['uncalled'],
    label: 'not called yet: small text under the name of a method the program has not called yet',
    level: 'more',
    cls: 'md-node md-call md-uncalled',
    draw: (mk) => [
      box(mk),
      mk('rect', { x: 12, y: 13, width: 20, height: 3, rx: 1.5 }, 'md-uncalled-bar'),
    ],
  },
  {
    id: 'more-methods',
    covers: ['more-methods'],
    label: '▸ more methods (N): click or press Enter to list the other methods of the class',
    level: 'more',
    cls: 'md-more',
    draw: (mk) => [
      mk('rect', { x: 3, y: 4, width: 38, height: 16, rx: 5 }, 'md-more-bg'),
      mk('text', { x: 7, y: 16 }, 'md-more-text', '▸ more'),
    ],
  },
  {
    id: 'unused-port',
    covers: ['unused-port'],
    label: 'Faint port: an input or output this call did not use',
    level: 'more',
    cls: 'md-node md-call',
    draw: (mk) => [
      box(mk),
      mk('circle', { cx: 12, cy: 4, r: 3 }, 'md-port'),
      mk('circle', { cx: 32, cy: 4, r: 3, opacity: 0.4 }, 'md-port'),
    ],
  },
  {
    id: 'faint-wire',
    covers: ['edge-inactive'],
    label: 'Faint wire: used by an earlier call of the same box, not by the current one',
    level: 'more',
    cls: 'md-edge md-inactive',
    draw: (mk) => [wire(mk, false)],
  },
  {
    id: 'data-row',
    covers: ['data-row'],
    label: 'Data box row: shape, dtype or columns of a table, array or series',
    level: 'more',
    cls: 'md-attr md-data',
    draw: (mk) => [mk('text', { x: 3, y: 16 }, 'md-aname', 'shape')],
  },
  {
    id: 'badge',
    covers: ['badge'],
    label: '×3 or 2 of 3: a box that ran several times, as in a loop',
    level: 'more',
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
  root.append(summary, createLegendList(doc));
  return root;
}

/**
 * The legend body (no toggle), for hosts that bring their own button: a list of the `basic` entries (a class
 * instance, a function or method call) and under it a "More" expander with the rest (svl-1x4).
 */
export function createLegendList(doc: Document = document): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'md-legend-body';
  const basic = doc.createElement('ul');
  const more = doc.createElement('ul');
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
    (item.level === 'basic' ? basic : more).append(li);
  }
  const details = doc.createElement('details');
  details.className = 'md-legend-more';
  const summary = doc.createElement('summary');
  summary.textContent = 'More';
  details.append(summary, more);
  root.append(basic, details);
  return root;
}
