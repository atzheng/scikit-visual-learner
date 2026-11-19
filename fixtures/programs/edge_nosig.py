# Exercises: numpy ufuncs (np.log, np.add, np.maximum) as library calls.
# Expected: numpy 2 ufuncs have a readable signature, so inputs are labelled x, x1, x2.
# (The arg0, arg1 fallback for callables whose signature can't be read is covered by
# test_recorder.test_ufunc_labels_arg0.)
import numpy as np
import pandas as pd

df = pd.read_csv("listings.csv").dropna()
logp = np.log(df["price"])
total = np.add(df["beds"], df["baths"])
big = np.maximum(df["sqft"], 1000)
print(logp.round(3).head(3).tolist(), total.head(3).tolist(), big.head(3).tolist())
