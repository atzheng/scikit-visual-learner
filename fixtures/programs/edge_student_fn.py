# Exercises: a student function and a student class used as opaque boxes;
# if __name__ == "__main__":.
# Expected: calls inside the function body and class methods are not recorded
# (bodies are uninstrumented); the function and class calls are opaque boxes.
import pandas as pd
from sklearn.linear_model import LinearRegression


def load(path):
    df = pd.read_csv(path).dropna()
    return df[["beds", "baths", "sqft"]], df["price"]


class Pipeline:
    def __init__(self):
        self.model = LinearRegression()

    def run(self, X, y):
        self.model.fit(X, y)
        return self.model.score(X, y)


if __name__ == "__main__":
    X, y = load("listings.csv")
    pipe = Pipeline()
    print(round(pipe.run(X, y), 3))
