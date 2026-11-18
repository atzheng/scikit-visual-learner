# Exercises: LinearRegression construct, fit, predict, score.
# Expected: one model instance with fit (returns self, no output wire), predict and
# score on the test set. Fit gets X_train and y_train only.
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import train_test_split

df = pd.read_csv("listings.csv").dropna()
X = df[["beds", "baths", "sqft", "year_built"]]
y = df["price"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=0)
model = LinearRegression()
model.fit(X_train, y_train)
pred = model.predict(X_test)
r2 = model.score(X_test, y_test)
print(len(pred), round(r2, 3))
