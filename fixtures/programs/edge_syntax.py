# Exercises: a syntax error.
# Expected: fails. Nothing runs; the error is reported with its line.
import pandas as pd

df = pd.read_csv("listings.csv"
print(df.shape)
