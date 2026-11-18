# Exercises: a student class with __repr__ and a property that call pandas.
# Expected: the calls made inside __repr__ and the property are not recorded
# (re-entry flag); the read_csv call and the Table construction are.
import pandas as pd


class Table:
    def __init__(self, df):
        self.df = df

    @property
    def total(self):
        return self.df["price"].sum()

    def __repr__(self):
        return f"Table(rows={len(self.df)}, mean={self.df['price'].mean():.2f})"


df = pd.read_csv("listings.csv")
t = Table(df)
print(repr(t))
print(round(t.total, 2))
print(t)
