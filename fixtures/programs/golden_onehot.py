# Exercises: OneHotEncoder construct, fit, transform on train and test (sparse output).
# Expected: one encoder instance; fit on the train column, transform called twice
# (train and test). Outputs are sparse matrices. Train and test are never wired together.
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import OneHotEncoder

df = pd.read_csv("listings.csv")
X = df[["neighbourhood"]]
y = df["price"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=0)
enc = OneHotEncoder(handle_unknown="ignore")
enc.fit(X_train)
train_enc = enc.transform(X_train)
test_enc = enc.transform(X_test)
print(train_enc.shape, test_enc.shape)
