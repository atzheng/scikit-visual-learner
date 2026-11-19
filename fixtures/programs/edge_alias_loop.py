# Exercises: alias names in a loop whose box holds one object per pass.
# Expected: `prev` and `alias` show on box `cur` only on the pass whose object they are bound to;
# `keep` (bound on pass 1 only) shows on pass 1 and not later; `first` stays on the df box.
import pandas as pd

df = pd.DataFrame({"a": [3, 1, 2], "b": [1.0, 2.0, 3.0]})
first = df
prev = df
for k in range(3):
    cur = prev.sort_values("a", ascending=bool(k % 2))
    alias = cur
    if k == 0:
        keep = cur
    prev = cur
print(prev.shape)
