# Exercises: alias names (`r = m.fit(...)`, `df2 = df`, a rebinding) and a loop-carried object
# (`cur = prev.sort_values(...)`, `prev = cur`).
# Expected: a box shows the names bound to its object after the first; a rebound alias drops
# off; later passes' new objects get a creation wire only when the producer is certain.
import pandas as pd
from sklearn.linear_model import LinearRegression

df = pd.DataFrame({"a": [3, 1, 2], "b": [1.0, 2.0, 3.0]})
df2 = df
print(df2.shape)
other = df.copy()
df2 = other
m = LinearRegression()
r = m.fit(df[["a"]], df["b"])
print(r.coef_)
prev = df
for k in range(3):
    cur = prev.sort_values("a", ascending=bool(k % 2))
    prev = cur
print(prev.shape)
