# Exercises: models["rf"].fit(X, y).
# Expected: the owner is resolved by identity, so fit is drawn on the RandomForest
# instance, not on the Ridge one.
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge

df = pd.read_csv("listings.csv").dropna()
X = df[["beds", "baths", "sqft"]]
y = df["price"]
models = {
    "ridge": Ridge(),
    "rf": RandomForestRegressor(n_estimators=10, random_state=0),
}
models["rf"].fit(X, y)
print(models["rf"].score(X, y) > 0.5)
