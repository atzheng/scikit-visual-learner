# Exercises: a 30-iteration loop calling fit and score (per-site cap and slot).
# Expected: fit and score each merge into one box; the first 20 executions plus the
# latest are recorded in full, the rest are counted only.
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.model_selection import train_test_split

df = pd.read_csv("listings.csv").dropna()
X = df[["beds", "baths", "sqft", "year_built"]]
y = df["price"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=0)
scores = []
for i in range(30):
    model = Ridge(alpha=0.1 * (i + 1))
    model.fit(X_train, y_train)
    scores.append(model.score(X_test, y_test))
print(round(max(scores), 4))
