# Exercises: plain named values on the shelf (svl-o6m).
# Expected: n, m, k and z are value cards, and n goes into the clip call as an input.
# `n = a.max()` and `n += 1` give n new values (new cards, never the same object as the
# old one), `m = n` is a second name for one value, and `k = print` ends k's card (a
# function is not a plain value). A line with no call (`m = n`, `n += 1`) is no step:
# its card shows up on the shelf at the next step.
import numpy as np

a = np.array([1, 2, 3])
n = a.sum()
m = n
n = a.max()
n += 1
k = a.mean()
k = print
c = a.clip(0, n)
z = a.min()
