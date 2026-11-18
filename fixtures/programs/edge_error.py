# Exercises: an unhandled ValueError from sklearn.
# Expected: fails. The run ends with status "error"; fit is the raising event and the
# traceback points at the fit line. Output before the error is kept.
import pandas as pd
from sklearn.linear_model import LinearRegression

df = pd.read_csv("listings.csv")
X = df[["beds", "baths", "sqft"]]  # sqft has NaNs, so fit raises ValueError
y = df["price"]
print("fitting")
LinearRegression().fit(X, y)
print("never reached")
