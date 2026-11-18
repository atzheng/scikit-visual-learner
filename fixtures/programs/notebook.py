import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import OneHotEncoder

df = pd.read_csv("listings.csv")
df = df.dropna()
X = df[["beds", "baths", "sqft", "neighbourhood"]]
y = df["price"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=0)
enc = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
enc.fit(X_train[["neighbourhood"]])
hood_train = enc.transform(X_train[["neighbourhood"]])
hood_test = enc.transform(X_test[["neighbourhood"]])
model = LinearRegression()
model.fit(hood_train, y_train)
score = model.score(hood_test, y_test)
pred = model.predict(hood_test)
print("rows:", len(df))
print("first prediction:", round(pred[0], 1))
print("R^2:", round(score, 3))
