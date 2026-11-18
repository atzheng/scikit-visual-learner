# Exercises: model.fit(X, y).predict(Z).
# Expected: fit returns self, so predict is drawn on the same model instance; no
# output wire from fit.
import pandas as pd
from sklearn.linear_model import LinearRegression

df = pd.read_csv("listings.csv").dropna()
X = df[["beds", "baths", "sqft"]]
y = df["price"]
Z = X.head(5)
model = LinearRegression()
preds = model.fit(X, y).predict(Z)
print(preds.round(2))
