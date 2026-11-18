# Exercises: a caught exception, then the run continues.
# Expected: the failed fit is recorded with an error; the run goes on and ends ok.
import pandas as pd
from sklearn.linear_model import LinearRegression

df = pd.read_csv("listings.csv")
X = df[["beds", "baths", "sqft"]]
y = df["price"]
model = LinearRegression()
try:
    model.fit(X, y)
except ValueError:
    print("NaNs in X, dropping them")
    df = df.dropna()
    model.fit(df[["beds", "baths", "sqft"]], df["price"])
print(round(model.score(df[["beds", "baths", "sqft"]], df["price"]), 3))
