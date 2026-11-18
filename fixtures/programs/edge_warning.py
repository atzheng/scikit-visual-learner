# Exercises: a FutureWarning raised by warnings.warn / sklearn ConvergenceWarning.
# Expected: warnings go to the output pane (stderr), attributed to the student's
# line. stdout is unaffected and deterministic.
import warnings

import pandas as pd
from sklearn.linear_model import LogisticRegression

warnings.simplefilter("always")
df = pd.read_csv("listings.csv").dropna()
warnings.warn("legacy API", FutureWarning, stacklevel=1)
X = df[["beds", "baths", "sqft", "year_built"]]
y = df["price"] > df["price"].median()
clf = LogisticRegression(max_iter=2)  # too few iterations: ConvergenceWarning
clf.fit(X, y)
print("done")
