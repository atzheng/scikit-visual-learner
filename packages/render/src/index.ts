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
  M as LAYOUT_METRICS,
} from './layout';
export type { Laid, LaidNode, LaidPort, LayoutOptions, Measure } from './layout';
