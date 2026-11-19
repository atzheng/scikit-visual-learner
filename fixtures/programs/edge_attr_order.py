# Exercises: an attribute read that a call already consumed (np.round(model.coef_)).
# Expected: the later `coefs = model.coef_` is no producer for the earlier call.
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression

df = pd.read_csv("listings.csv").dropna()
X = df[["beds", "baths", "sqft"]]
y = df["price"]
model = LinearRegression()
model.fit(X, y)
print(model.coef_.shape)
r = np.round(model.coef_)
coefs = model.coef_
for _ in range(3):
    c = model.coef_
    d = model.intercept_
print(coefs)
