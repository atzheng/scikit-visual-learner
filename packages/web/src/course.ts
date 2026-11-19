/** Course defaults: run configuration (CONTRACTS.md section 4), datasets and the starter example. */

import type { RunConfig } from '@machines/log';

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

/** Course datasets, written into Pyodide's filesystem by the worker and served from /datasets/. */
export const DATASETS = ['listings.csv'] as const;

/** Placeholder; the real starter example arrives with the fixtures. */
export const STARTER_EXAMPLE = `import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression

df = pd.read_csv("listings.csv")
X_train, X_test, y_train, y_test = train_test_split(
    df[["beds", "sqft"]], df["price"], test_size=0.2, random_state=0
)
model = LinearRegression()
model.fit(X_train, y_train)
print(model.score(X_test, y_test))
`;
