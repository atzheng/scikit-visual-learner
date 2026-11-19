# Exercises: names the recorder cannot follow are never shown as aliases.
# Expected: `df4` (deleted) and `keep` (rebound by a `global` write in a function) are not
# aliases; `df2` (plain) is.
import pandas as pd

df = pd.DataFrame({"a": [3, 1, 2], "b": [1.0, 2.0, 3.0]})
df2 = df
df4 = df
del df4
other = df.copy()
keep = df


def g():
    global keep
    keep = other


g()
print(keep.shape)
