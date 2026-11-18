# Exercises: df.dropna(inplace=True), df.sort_values(..., inplace=True).
# Expected: the calls return None; df is detected as changed by fingerprint and
# drawn as a new version of the same name.
import pandas as pd

df = pd.read_csv("listings.csv")
before = len(df)
df.dropna(inplace=True)
df.sort_values("price", inplace=True)
print(before, len(df), df["price"].iloc[0])
