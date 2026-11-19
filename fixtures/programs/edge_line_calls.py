# Exercises: several calls on one source line (svl-qol): one method at two sites, an owner that
# an earlier call used as an input and a later call as receiver, and ';' on one line.
# Expected: one line group per line; no call disappears from the stage within its line.
import pandas as pd
from sklearn.linear_model import LinearRegression

df = pd.DataFrame({"a": [1.0, 2.0, 3.0, 4.0], "b": [2.0, 4.0, 6.0, 9.0]})
X = df[["a"]]
y = df["b"]
m = LinearRegression().fit(X, y)
print(m.predict(X).sum(), m.predict(X).mean())
print(pd.concat([df, df]).shape, df.head(2).shape)
print(df.assign(c=df["a"]).shape)
s1 = df.sum(); s2 = df.mean()  # fmt: skip # noqa: E702
