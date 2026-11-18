# Exercises: f(g(x)) with library calls.
# Expected: the output of the inner call (head) wires straight into the outer call
# (describe) with no name label; len(...) of a nested call likewise.
import pandas as pd

df = pd.read_csv("listings.csv")
summary = pd.DataFrame.describe(df.dropna().head(50))
n = len(df.dropna().head(10))
print(summary.shape, n)
