# Exercises: equal literals, small ints, numpy bool results, constant tuples.
# Expected: none of these are wired to each other, even though they are equal or
# the very same object.
import numpy as np
import pandas as pd

a = np.array([1, 2, 3])
b = np.array([1, 2, 3])
n1 = len(a)
n2 = len(b)
t1 = np.shape(a)
t2 = np.shape(b)
f1 = np.isnan(a).any()
f2 = np.isnan(b).any()
s = pd.Series([2, 2, 2])
x = s.nunique() + 2
y = s.count() - 1
print(n1, n2, t1, t2, f1, f2, x, y)
