# Exercises: module globals rebound reflectively (sys.modules, setattr, __dict__, __main__).
# Expected: no alias names are shown for any name in this program.
import __main__  # noqa: I001
import pandas as pd
import sys

df = pd.DataFrame({"a": [3, 1, 2]})
other = df.copy()
k1 = k2 = k3 = k4 = df
sys.modules[__name__].k1 = other
setattr(sys.modules["__main__"], "k2", other)  # noqa: B010
sys.modules["__main__"].__dict__["k3"] = other
__main__.k4 = other
print(k1.shape, k2.shape, k3.shape, k4.shape)
