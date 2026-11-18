# Exercises: the heaviest plausible course example: RandomForestRegressor +
# GridSearchCV on 10,000 rows (listings_10k.csv).
# Expected: completes; the search fits clones internally (not drawn); only the
# student's own calls (read_csv, split, search.fit, score) are boxes.
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import GridSearchCV, train_test_split

df = pd.read_csv("listings_10k.csv").dropna()
X = pd.get_dummies(df[["beds", "baths", "sqft", "year_built", "neighbourhood", "room_type"]])
y = df["price"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=0)
forest = RandomForestRegressor(random_state=0)
grid = {"n_estimators": [50, 100], "max_depth": [8, 12]}
search = GridSearchCV(forest, grid, cv=3)
search.fit(X_train, y_train)
print(search.best_params_)
print("R^2:", round(search.score(X_test, y_test), 3))
