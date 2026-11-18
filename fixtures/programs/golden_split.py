# Exercises: read_csv -> X, y -> train_test_split(X, y, test_size=0.2).
# Expected: one split box with four outputs (X_train, X_test, y_train, y_test),
# fed by X and y. X_train and X_test are never wired to each other.
import pandas as pd
from sklearn.model_selection import train_test_split

df = pd.read_csv("listings.csv")
df = df.dropna()
X = df[["beds", "baths", "sqft", "year_built"]]
y = df["price"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=0)
print(X_train.shape, X_test.shape)
