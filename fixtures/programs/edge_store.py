# Exercises: df["c"] = v, df.loc[m, "c"] = 0.
# Expected: two store events; df gets a new version after each.
import pandas as pd

df = pd.read_csv("listings.csv")
df["price_per_sqft"] = df["price"] / df["sqft"]
mask = df["sqft"].isna()
df.loc[mask, "price_per_sqft"] = 0
print(df["price_per_sqft"].round(3).head())
