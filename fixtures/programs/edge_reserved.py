# Exercises: keyword args named site and fn; locals(); super() in a class; shadowed print.
# Expected: all of it behaves as in plain Python and the output is identical.
import builtins

import pandas as pd


def show(*args, site=None, fn=None):
    return (site, fn, len(args))


class Base:
    def label(self):
        return "base"


class Child(Base):
    def label(self):
        return "child+" + super().label()


def count_locals():
    a = 1
    b = 2
    return sorted(locals())


def print(*args, **kwargs):  # shadows the builtin on purpose
    builtins.print("[shadowed]", *args, **kwargs)


df = pd.DataFrame({"site": [1, 2], "fn": [3, 4]})
print(show(df, site="a", fn="b"))
print(Child().label(), count_locals())
print(df.assign(site=df["fn"], fn=df["site"]).sum().to_dict())
