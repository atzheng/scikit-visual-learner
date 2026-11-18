# Exercises: df.dropna().reset_index().
# Expected: two boxes (dropna, reset_index); the intermediate DataFrame is an
# unlabelled wire between them.
import pandas as pd

df = pd.read_csv("listings.csv")
clean = df.dropna().reset_index()
print(df.shape, clean.shape)
