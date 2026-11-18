# Exercises: GridSearchCV (original stays unfitted), n_jobs=2.
# Expected: the clones made inside GridSearchCV are not drawn; the student's
# original Ridge instance stays unfitted. n_jobs falls back to sequential in the browser.
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.model_selection import GridSearchCV

df = pd.read_csv("listings.csv").dropna()
X = df[["beds", "baths", "sqft"]]
y = df["price"]
base = Ridge()
search = GridSearchCV(base, {"alpha": [0.1, 1.0, 10.0]}, cv=3, n_jobs=2)
search.fit(X, y)
print(search.best_params_)
print(hasattr(base, "coef_"))
