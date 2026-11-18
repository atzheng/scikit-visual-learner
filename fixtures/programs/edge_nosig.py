# Exercises: callables whose signature can't be read (numpy ufuncs).
# Expected: inputs are labelled arg0, arg1, ...
import numpy as np
import pandas as pd

df = pd.read_csv("listings.csv").dropna()
logp = np.log(df["price"])
total = np.add(df["beds"], df["baths"])
big = np.maximum(df["sqft"], 1000)
print(logp.round(3).head(3).tolist(), total.head(3).tolist(), big.head(3).tolist())
