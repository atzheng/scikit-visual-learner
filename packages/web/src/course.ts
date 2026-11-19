/** Course defaults: run configuration (CONTRACTS.md section 4), datasets and the starter example. */

import type { RunConfig } from '@machines/log';
import notebookSource from '../../../fixtures/programs/notebook.py?raw';

export const DEFAULT_RUN_CONFIG: RunConfig = {
  draw_modules: ['sklearn', 'pandas', 'numpy'],
  draw_builtins: false,
  draw_container_methods: false,
  machine_classes: [],
  wall_ms: 30_000,
  max_events: 5_000,
  per_site: 20,
  preview_bytes: 1_000_000,
  hash_cells: 100_000,
};

/** Course datasets (stand-in: synthetic fixtures/data; real ones come with svl-3jf.5), written into Pyodide's filesystem by the worker and served from /datasets/. */
export const DATASETS = ['listings.csv'] as const;

/**
 * Starter example. Stand-in: the synthetic fixture program. The course's real example is owned
 * by svl-3jf.5; replace the import (or this constant) when it exists.
 */
export const STARTER_EXAMPLE: string = notebookSource;
