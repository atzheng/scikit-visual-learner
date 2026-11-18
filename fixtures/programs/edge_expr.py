# Exercises: df["price"], X_train - mean, model.coef_.
# Expected: expression nodes with dashed wires from the names they read.
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import train_test_split

df = pd.read_csv("listings.csv").dropna()
X = df[["beds", "baths", "sqft"]]
y = df["price"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, random_state=1)
mean = X_train.mean()
centred = X_train - mean
model = LinearRegression()
model.fit(centred, y_train)
coefs = model.coef_
print(coefs.round(2))
