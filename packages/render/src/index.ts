import { LOG_PACKAGE } from '@machines/log';

/** Placeholder: ELK layout and SVG renderer (CONTRACTS.md section 1). */
export const RENDER_PACKAGE = '@machines/render';
export const RENDER_DEPENDS_ON = LOG_PACKAGE;

export {
  layout,
  buildElkGraph,
  buildElk,
  createElk,
  defaultMeasure,
  FONT_MONO,
  FONT_NAME,
  placeLabels,
  tierFor,
  longEdgeLoad,
  M as LAYOUT_METRICS,
} from './layout';
export type { Laid, LaidLabel, LaidNode, LaidPort, LayoutOptions, Measure } from './layout';
export { mount } from './mount';
export type { DiagramController, MountOptions } from './mount';
export { createLegend, LEGEND_ITEMS } from './legend';
export {
  attrRowsFor,
  edgeLabelsFor,
  badgeText,
  buildSvg,
  applyState,
  changedAttrs,
  instanceRowModels,
  labelAnchor,
  roundedPath,
  statusOf,
  summaryLabel,
} from './svg';
