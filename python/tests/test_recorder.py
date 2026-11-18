"""Recorder tests (CONTRACTS.md section 4): small programs driven through instrument + Recorder."""

from __future__ import annotations

import contextlib
import io
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from machines import recorder as recorder_mod
from machines.recorder import Recorder, RunConfig
from machines.transform import instrument

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "fixtures" / "data"

PRELUDE = """
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import train_test_split, GridSearchCV
"""


@dataclass
class Result:
    rec: Recorder
    log: dict[str, Any]
    msgs: list[dict[str, Any]]
    ns: dict[str, Any]
    stdout: str
    err: BaseException | None

    @property
    def events(self) -> list[dict[str, Any]]:
        return self.log["events"]

    def by_name(self, name: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["name"] == name]

    def one(self, name: str) -> dict[str, Any]:
        found = self.by_name(name)
        assert len(found) == 1, [e["name"] for e in self.events]
        return found[0]

    def bound(self, name: str) -> str:
        return {n: t for _, n, t in self.log["scopes"][0]["bindings"]}[name]


def record(source: str, prelude: bool = True, **cfg: Any) -> Result:
    src = (PRELUDE if prelude else "") + source
    ins = instrument(src)
    msgs: list[dict[str, Any]] = []
    rec = Recorder(ins.sites, RunConfig(**cfg), msgs.append)
    rec.install()
    ns: dict[str, Any] = {"__name__": "__main__"}
    err: BaseException | None = None
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(ins.tree, "<student>", "exec"), ns)
    except BaseException as e:  # noqa: BLE001
        err = e
    finally:
        rec.close_open(err)
        rec.uninstall()
    status = "ok" if err is None else "error"
    return Result(rec, rec.log(status, None), msgs, ns, buf.getvalue(), err)


def plain(source: str, prelude: bool = True) -> Result:
    """The same program as plain Python: not instrumented at all."""
    src = (PRELUDE if prelude else "") + source
    ns: dict[str, Any] = {"__name__": "__main__"}
    err: BaseException | None = None
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(src, "<student>", "exec"), ns)
    except BaseException as e:  # noqa: BLE001
        err = e
    return Result(None, {}, [], ns, buf.getvalue(), err)  # type: ignore[arg-type]


def inp(ev: dict[str, Any], param: str) -> dict[str, Any]:
    found = [i for i in ev["inputs"] if i["param"] == param]
    assert len(found) == 1, (param, [i["param"] for i in ev["inputs"]])
    return found[0]


FRAME = """
df = pd.DataFrame({"a": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0], "b": [2.0, 1.0, 4.0, 3.0, 6.0, 5.0],
                   "y": [1.0, 2.0, 3.0, 4.0, 5.0, 7.0]})
"""


# -- the examples from the bead -------------------------------------------------------------------


def test_spec_example_split_outputs_and_names() -> None:
    r = record(
        FRAME
        + """
X = df[["a", "b"]]
y = df["y"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.5, random_state=0)
"""
    )
    assert r.err is None
    split = r.one("train_test_split")
    assert split["kind"] == "function" and split["module"].startswith("sklearn")
    assert len(split["outputs"]) == 4 and len(set(split["outputs"])) == 4
    assert [r.bound(n) for n in ("X_train", "X_test", "y_train", "y_test")] == split["outputs"]
    assert inp(split, "arrays[0]")["value"] == r.bound("X")
    assert inp(split, "arrays[1]")["value"] == r.bound("y")
    assert inp(split, "test_size") == {"param": "test_size", "origin": "const", "text": "0.5"}
    # X and y came from expression events (column selection) that read df
    ex = r.one('df[["a", "b"]]')
    assert ex["kind"] == "expr" and ex["outputs"] == [r.bound("X")]
    assert inp(ex, "df")["value"] == r.bound("df")
    for tok in split["outputs"]:
        assert tok in r.log["values"]
    assert r.log["values"][r.bound("X_train")]["type"] == "DF"


def test_fit_returns_self_and_mutates_and_chain_owner() -> None:
    r = record(
        FRAME
        + """
X = df[["a", "b"]]
y = df["y"]
model = LinearRegression()
preds = model.fit(X, y).predict(X)
"""
    )
    ctor = r.one("LinearRegression")
    assert ctor["kind"] == "constructor"
    t0 = ctor["outputs"][0]
    fit = r.one("LinearRegression.fit")
    assert fit["kind"] == "method" and fit["owner"] == t0
    assert fit["returns_self"] is True and fit["outputs"] == []
    assert len(fit["mutates"]) == 1 and fit["mutates"][0][0] == t0
    after = fit["mutates"][0][1]
    assert after != t0
    assert [i["param"] for i in fit["inputs"]] == ["X", "y"]  # machine owner: no `self` input
    pred = r.one("LinearRegression.predict")
    assert pred["owner"] == after  # chained: owner is the fitted model
    assert r.log["values"][after]["machine"] is True
    assert "coef_" in r.log["values"][after]["attrs"]
    assert "coef_" not in r.log["values"][t0].get("attrs", {})


def test_dropna_inplace_bumps_version() -> None:
    r = record(
        """
df = pd.DataFrame({"a": [1.0, None, 3.0]})
before = df
df.dropna(inplace=True)
n = df.shape
"""
    )
    ev = r.one("DataFrame.dropna")
    assert ev["kind"] == "method" and ev["outputs"] == []
    ((b, a),) = ev["mutates"]
    assert b != a and b.split(".")[0] == a.split(".")[0]
    assert inp(ev, "self")["value"] == b
    assert inp(ev, "inplace") == {"param": "inplace", "origin": "const", "text": "True"}
    # bindings are time-indexed: both names were bound before the call, to the earlier version
    assert r.bound("df") == b and r.bound("before") == b


def test_store_forces_a_bump_and_records_inputs() -> None:
    r = record(
        FRAME
        + """
v = df["a"] * 2
df["c"] = v
df["d"] = 1
df["a"] = df["a"]
"""
    )
    stores = [e for e in r.events if e["kind"] == "store"]
    assert [s["name"] for s in stores] == ['df["c"] = v', 'df["d"] = 1', 'df["a"] = df["a"]']
    first = stores[0]
    assert first["outputs"][0] != inp(first, "target")["value"]
    assert inp(first, "value")["value"] == r.bound("v")
    assert inp(stores[1], "value") == {"param": "value", "origin": "const", "text": "1"}
    # an assignment that changes nothing still produces a new version
    toks = [s["outputs"][0] for s in stores]
    assert len(set(toks)) == 3
    assert inp(stores[2], "target")["value"] == toks[1]


def test_equal_literals_never_share_a_token() -> None:
    r = record(
        """
a = 5
b = 5
x = np.full(2, a)
y = np.full(2, b)
c = a
z = np.full(2, c)
m1 = np.isnan(1.0)
m2 = np.isnan(2.0)
s = np.add(m1, m2)
""",
    )
    assert r.err is None
    assert r.bound("a") != r.bound("b")
    fulls = r.by_name("full")
    ta, tb, tc = (inp(f, "fill_value")["value"] for f in fulls)
    assert ta == r.bound("a") and tb == r.bound("b")
    assert ta != tb
    assert tc == ta  # a name copied from another name is the same value
    isnan = r.by_name("isnan")
    assert isnan[0]["outputs"] != isnan[1]["outputs"]  # np.False_ is a singleton: fresh tokens
    add = r.one("add")
    assert inp(add, "x1")["value"] == isnan[0]["outputs"][0]
    assert inp(add, "x2")["value"] == isnan[1]["outputs"][0]


def test_identity_guard_after_unrecorded_rebinding() -> None:
    # `n := 7` rebinds n without a __bind__ hook; the guard stops the old token flowing on.
    r = record(
        """
n = 5
(n := 7)
x = np.full(2, n)
"""
    )
    full = r.one("full")
    assert inp(full, "fill_value")["value"] != r.bound("n")


def test_dict_of_models_owner_identity() -> None:
    r = record(
        FRAME
        + """
X = df[["a", "b"]]
y = df["y"]
models = {"lr": LinearRegression()}
models["lr"].fit(X, y)
m = models["lr"]
m.predict(X)
"""
    )
    ctor = r.one("LinearRegression")
    fit = r.one("LinearRegression.fit")
    assert fit["owner"] == ctor["outputs"][0]
    # `models["lr"]` is an expression whose value is already a token: no expr event
    assert not [e for e in r.events if e["kind"] == "expr" and "models" in e["name"]]
    pred = r.one("LinearRegression.predict")
    assert pred["owner"] == fit["mutates"][0][1]
    assert r.bound("m") == fit["mutates"][0][1]


def test_gridsearch_leaves_original_unfitted() -> None:
    r = record(
        FRAME
        + """
X = df[["a", "b"]]
y = df["y"]
est = LinearRegression()
gs = GridSearchCV(est, {"fit_intercept": [True, False]}, cv=2)
gs.fit(X, y)
"""
    )
    assert r.err is None
    est_tok = r.one("LinearRegression")["outputs"][0]
    fit = r.one("GridSearchCV.fit")
    assert [m[0].split(".")[0] for m in fit["mutates"]] == [
        r.one("GridSearchCV")["outputs"][0].split(".")[0]
    ]
    assert not any(m[0] == est_tok for m in fit["mutates"])
    assert "coef_" not in r.log["values"][est_tok].get("attrs", {})


def test_nested_estimator_in_pipeline_is_checked() -> None:
    r = record(
        FRAME
        + """
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
sc = StandardScaler()
pipe = Pipeline([("sc", sc), ("lr", LinearRegression())])
pipe.fit(df[["a", "b"]], df["y"])
"""
    )
    fit = r.one("Pipeline.fit")
    sc_tok = r.one("StandardScaler")["outputs"][0]
    assert any(m[0] == sc_tok for m in fit["mutates"])  # the scaler changed inside the pipeline


def test_keyword_args_named_site_and_fn() -> None:
    r = record(
        """
def f(site, fn):
    return site + fn
total = f(site=1, fn=2)
d = dict(site=3, fn=4)
""",
        draw_builtins=True,
    )
    assert r.err is None
    assert r.ns["total"] == 3 and r.ns["d"] == {"site": 3, "fn": 4}
    f = r.one("f")
    assert f["kind"] == "student_function"
    assert [i["param"] for i in f["inputs"]] == ["site", "fn"]
    assert [i["param"] for i in r.one("dict")["inputs"]] == ["site", "fn"]


def test_super_in_class_body_method_called_from_module_level() -> None:
    src = """
class Base:
    def hello(self):
        return "base"

class Child(Base):
    def hello(self):
        return super().hello() + "!"

c = Child()
out = c.hello()
"""
    r = record(src, prelude=False)
    assert r.err is None and r.ns["out"] == "base!"
    assert r.one("Child")["kind"] == "constructor"
    hello = r.one("Child.hello")
    assert hello["kind"] == "method" and hello["owner"] == r.bound("c")
    assert r.log["values"][r.bound("c")]["machine"] is True


def test_student_repr_is_not_recorded() -> None:
    r = record(
        """
class T:
    def __init__(self, df):
        self.df = df
    def __repr__(self):
        return f"T({len(self.df)}, {self.df['a'].sum()})"

t = T(pd.DataFrame({"a": [1, 2]}))
s = str(t)
""",
    )
    assert r.err is None
    # `str(t)` is a hidden call (an expression event); nothing from inside __repr__ appears
    assert [(e["name"], e["kind"]) for e in r.events] == [
        ("DataFrame", "constructor"),
        ("T", "constructor"),
        ("str(t)", "expr"),
    ]
    assert not r.log["diagnostics"]


def test_ufunc_labels_arg0() -> None:
    r = record(
        """
a = np.array([1.0, 2.0])
b = np.log1p(a)
c = np.add(a, 1.5, out=None)
f = np.sqrt
d = np.vectorize(lambda x: x)(a)
"""
    )
    log1p = r.one("log1p")
    assert log1p["kind"] == "function" and log1p["module"].startswith("numpy")
    assert [(i["param"], i["origin"]) for i in log1p["inputs"]] == [("x", "name")]
    add = r.one("add")
    assert [i["param"] for i in add["inputs"]] == ["x1", "x2", "out"]
    assert inp(add, "x2") == {"param": "x2", "origin": "const", "text": "1.5"}
    # a callable whose signature cannot be read is labelled arg0, arg1, ... and still called
    r2 = record("m = max(3, 4, key=None)\nn = max([1, 2])\n", draw_builtins=True)
    assert r2.err is None and r2.ns["m"] == 4
    mx = r2.by_name("max")[0]
    assert [(i["param"], i.get("text")) for i in mx["inputs"]] == [
        ("arg0", "3"),
        ("arg1", "4"),
        ("key", "None"),
    ]
    assert mx["module"] == "builtins" and mx["kind"] == "function"


def test_label_values_are_text_on_the_port() -> None:
    r = record(
        """
f = np.log1p
x = np.array([1.0])
y = np.vectorize(f)(x)
"""
    )
    vec = r.one("vectorize")
    pyfunc = inp(vec, "pyfunc")
    assert pyfunc["text"] == "log1p" and "value" not in pyfunc
    assert "f" not in {n for _, n, _ in r.log["scopes"][0]["bindings"]}


# -- caps and slots -------------------------------------------------------------------------------


def test_loop_of_30_has_20_full_plus_one_slot() -> None:
    r = record(
        """
total = 0.0
for k in range(30):
    z = np.array([float(k)])
    total = total + 1.0
""",
    )
    arrays = r.by_name("array")
    assert len(arrays) == 21
    assert [e["count"] for e in arrays] == list(range(1, 21)) + [30]
    assert [e.get("slot") for e in arrays] == [None] * 20 + [True]
    assert len({e["i"] for e in r.events}) == len(r.events)
    # the last iteration's token is bound at the end
    assert r.bound("z") == arrays[-1]["outputs"][0]
    # bindings past the per-site cap are slots too: 20 + 1 for z, k, total
    zs = [b for b in r.log["scopes"][0]["bindings"] if b[1] == "z"]
    assert len(zs) == 21
    # and each slot row in the stream carries its key
    rows = [b for m in r.msgs for b in m["bindings"] if b[2] == "z"]
    assert sum(1 for b in rows if len(b) == 5) == 10 and rows[-1][4].endswith(".z")


def test_max_events_stops_recording_but_not_the_program() -> None:
    src = """
out = []
for k in range(50):
    out.append(np.array([k]))
x = np.array([1])
"""
    r = record(src, max_events=10, per_site=100, draw_container_methods=False)
    assert r.err is None and len(r.ns["out"]) == 50
    assert len(r.events) == 10
    assert r.log["status"] == "limit" and r.rec.final_status("ok") == "limit"
    assert r.rec.limit_hit is True
    assert plain(src).ns["x"] == r.ns["x"]


def test_hidden_calls_do_not_count_toward_the_cap() -> None:
    r = record(
        """
for k in range(5):
    n = len([k])
x = np.array([1])
""",
        max_events=3,
    )
    assert r.rec.limit_hit is False
    assert [e["name"] for e in r.events][-1] == "array"


# -- errors ---------------------------------------------------------------------------------------


def test_exception_in_library_call_same_error_and_recorded() -> None:
    src = """
df = pd.DataFrame({"a": [1, 2]})
x = df["missing"].sum()
"""
    r = record(src)
    p = plain(src)
    assert type(r.err) is type(p.err) is KeyError
    assert str(r.err) == str(p.err)
    sums = r.by_name("Series.sum")
    assert sums == []  # raised in the expression before the call
    src2 = """
from sklearn.linear_model import LinearRegression
m = LinearRegression()
m.fit([[1.0]], [1.0, 2.0])
"""
    r2 = record(src2)
    p2 = plain(src2)
    assert type(r2.err) is type(p2.err) is ValueError and str(r2.err) == str(p2.err)
    fit = r2.one("LinearRegression.fit")
    assert fit["error"] == {"type": "ValueError", "message": str(p2.err), "handled": False}
    assert fit["outputs"] == []
    assert r2.log["events"][-1] is fit


def test_error_propagates_to_enclosing_and_handled_flag() -> None:
    r = record(
        """
def boom(df):
    return df.nonexistent_column_op()

df = pd.DataFrame({"a": [1]})
try:
    boom(df)
except AttributeError:
    pass
x = np.array([1])
""",
    )
    assert r.err is None
    boom = r.one("boom")
    assert boom["error"]["type"] == "AttributeError" and boom["error"]["handled"] is True
    assert r.one("array")["error"] is None


def test_error_caught_with_no_later_hook_is_handled_at_the_end() -> None:
    r = record(
        """
try:
    pd.DataFrame({"a": [1]}).iloc[5]
except IndexError:
    pass
""",
    )
    ev = [e for e in r.events if e["error"]]
    # iloc is a property access, not a call: nothing raised through a hook
    assert ev == []
    r = record(
        """
try:
    pd.DataFrame({"a": [1]}).drop(columns=["nope"])
except KeyError:
    pass
""",
    )
    (ev2,) = [e for e in r.events if e["error"]]
    assert ev2["name"] == "DataFrame.drop" and ev2["error"]["handled"] is True


def test_nested_error_marks_outer_propagated() -> None:
    # a student function calls a library call whose failure escapes through two hooks
    r = record(
        """
df = pd.DataFrame({"a": [1]})
bad = df.drop(columns=["nope"])
""",
    )
    assert isinstance(r.err, KeyError)
    drop = r.one("DataFrame.drop")
    assert drop["error"]["handled"] is False and "propagated" not in drop["error"]


def test_keyboard_interrupt_closes_open_as_interrupted() -> None:
    r = record(
        """
def stopper(df):
    raise KeyboardInterrupt

df = pd.DataFrame({"a": [1]})
stopper(df)
x = 1
""",
    )
    assert isinstance(r.err, KeyboardInterrupt)
    ev = r.one("stopper")
    assert ev["interrupted"] is True and ev["error"] is None and ev["ret"] == ev["i"]
    assert ev["outputs"] == []
    last = r.msgs[-1]
    assert last["open"] == []


# -- degrade --------------------------------------------------------------------------------------


def test_broken_summary_degrades_to_diagnostics_and_program_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from machines.values import ValueTable

    def boom(self: ValueTable, token: str, obj: Any) -> None:
        raise RuntimeError("summary exploded")

    monkeypatch.setattr(ValueTable, "summarize", boom)
    src = FRAME + "x = df['a'].sum()\ny = np.array([1, 2]).sum()\nprint(x, y)\n"
    r = record(src)
    p = plain(src)
    assert r.err is None and r.stdout == p.stdout
    assert r.log["diagnostics"]
    assert all("RuntimeError: summary exploded" in d for d in r.log["diagnostics"])
    assert {d.split(":")[0] for d in r.log["diagnostics"]} <= {"rec", "bind", "store"}
    # each broken hook is reported once, then passes through
    assert len(r.log["diagnostics"]) == len(set(r.log["diagnostics"]))


def test_no_active_recorder_passes_through() -> None:
    src = FRAME + "x = df['a'].sum()\nprint(x)\n"
    r = record(src)
    p = plain(src)
    assert p.stdout == r.stdout and p.ns["x"] == r.ns["x"]
    recorder_mod.install_hooks()  # no recorder active: hooks are pass-throughs
    assert recorder_mod._active is None


# -- expression events ----------------------------------------------------------------------------


def test_expr_events_come_before_their_consumer() -> None:
    r = record(
        FRAME
        + """
mean = df["a"].mean()
z = df["a"] - mean
m = LinearRegression().fit(df[["a"]], z)
"""
    )
    evs = r.events
    names = [e["name"] for e in evs]
    assert names.index('df["a"]') < names.index("Series.mean")
    mean_ev = r.one("Series.mean")
    own = inp(mean_ev, "self")
    assert own["origin"] == "expr" and own["value"] in evs[names.index('df["a"]')]["outputs"]
    assert mean_ev["owner"] == own["value"]  # data method: `self` is an input too
    sub = r.one('df["a"] - mean')
    assert sub["kind"] == "expr"
    reads = {i["param"]: i["value"] for i in sub["inputs"]}
    assert reads["df"] == r.bound("df") and reads["mean"] == r.bound("mean")
    assert sub["outputs"] == [r.bound("z")]
    # every event precedes its consumers by i
    for e in evs:
        for i in e["inputs"]:
            if "value" in i:
                prod = [p for p in evs if i["value"] in p["outputs"] + [m[1] for m in p["mutates"]]]
                assert all(p["i"] < e["i"] for p in prod)


def test_hidden_call_becomes_expression_event() -> None:
    r = record(
        FRAME
        + """
score = round(df["a"].mean(), 3)
x = np.full(2, score)
"""
    )
    full = r.one("full")
    tok = inp(full, "fill_value")["value"]
    ex = r.one('round(df["a"].mean(), 3)')
    assert ex["kind"] == "expr" and ex["outputs"] == [tok]
    assert r.bound("score") == tok
    assert inp(ex, "df")["value"] == r.bound("df")


def test_hidden_call_scalar_passed_through_two_names_keeps_one_token() -> None:
    r = record(
        """
n = len([1, 2])
k = n
a = np.full(2, n)
b = np.full(2, k)
"""
    )
    fulls = r.by_name("full")
    assert inp(fulls[0], "fill_value")["value"] == inp(fulls[1], "fill_value")["value"]


def test_expr_inside_loop_uses_current_names() -> None:
    r = record(
        """
w = 1.0
for k in range(3):
    w = w * 2
    a = np.full(2, w)
"""
    )
    fulls = r.by_name("full")
    toks = [inp(f, "fill_value")["value"] for f in fulls]
    assert len(set(toks)) == 3
    exprs = r.by_name("w * 2")
    # each doubling reads the previous binding of w, never its own result
    for e in exprs:
        assert inp(e, "w")["value"] != e["outputs"][0]
    assert inp(exprs[1], "w")["value"] == exprs[0]["outputs"][0]


def test_augmented_assignment_in_place_is_an_expr_event_with_mutation() -> None:
    r = record(
        """
a = np.zeros(3)
a += 1
b = np.sum(a)
"""
    )
    aug = r.one("a += 1")
    assert aug["kind"] == "expr" and len(aug["mutates"]) == 1
    assert aug["mutates"][0][1] == r.bound("a")
    assert inp(r.one("sum"), "a")["value"] == r.bound("a")


def test_unrelated_calls_that_share_no_object_are_never_wired() -> None:
    r = record(
        """
a = np.array([1.0])
b = np.array([1.0])
c = np.array([1.0])
x = np.sum(b)
"""
    )
    arrs = r.by_name("array")
    assert len({e["outputs"][0] for e in arrs}) == 3
    assert inp(r.one("sum"), "a")["value"] == r.bound("b")


# -- origins and bindings --------------------------------------------------------------------------


def test_unpack_with_scalar_outputs_binds_positionally() -> None:
    r = record(
        """
def two():
    return 5, 5

a, b = two()
x = np.full(2, a)
y = np.full(2, b)
"""
    )
    two = r.one("two")
    assert len(two["outputs"]) == 2 and two["outputs"][0] != two["outputs"][1]
    assert r.bound("a") == two["outputs"][0] and r.bound("b") == two["outputs"][1]
    fulls = r.by_name("full")
    assert inp(fulls[0], "fill_value")["value"] == r.bound("a")
    assert inp(fulls[1], "fill_value")["value"] == r.bound("b")


def test_destructuring_binds_without_false_wires() -> None:
    r = record(
        """
pair = (np.array([1.0]), np.array([2.0]))
p, q = pair
"""
    )
    # a, b = tuple-of-references: each name holds its own element, identity tokens
    arrs = r.by_name("array")
    assert r.bound("p") == arrs[0]["outputs"][0]
    assert r.bound("q") == arrs[1]["outputs"][0]


def test_tuple_return_not_split_without_unpack() -> None:
    r = record(
        FRAME
        + """
parts = train_test_split(df, test_size=0.5, random_state=0)
"""
    )
    split = r.one("train_test_split")
    assert len(split["outputs"]) == 1
    assert r.log["values"][split["outputs"][0]]["type"] == "list[2]"


def test_classmethod_is_a_function() -> None:
    r = record('df = pd.DataFrame.from_dict({"a": [1]})\n')
    ev = r.one("DataFrame.from_dict")
    assert ev["kind"] == "function" and ev["owner"] is None


def test_arguments_the_student_did_not_pass_are_not_listed() -> None:
    r = record("a = np.array([1, 2])\nb = np.sort(a)\n")
    assert [i["param"] for i in r.one("sort")["inputs"]] == ["a"]


def test_starred_arguments_have_unknown_origin_and_still_run() -> None:
    r = record(
        """
args = (np.array([1.0]), np.array([2.0]))
c = np.concatenate(args)
d = np.hstack([*args])
"""
    )
    assert r.err is None
    cat = r.one("concatenate")
    assert inp(cat, "arrays")["origin"] in ("name", "unknown")


def test_student_function_mutating_an_input_records_mutation() -> None:
    r = record(
        FRAME
        + """
def clean(frame):
    frame.dropna(inplace=True)
    frame["z"] = 1

clean(df)
"""
    )
    ev = r.one("clean")
    assert ev["kind"] == "student_function" and len(ev["mutates"]) == 1
    assert ev["outputs"] == []


def test_machine_attribute_summaries_and_scalar_attrs() -> None:
    r = record(
        """
class Counter:
    def __init__(self):
        self.n = 3
        self.label = "x"
c = Counter()
"""
    )
    summ = r.log["values"][r.bound("c")]
    assert summ["machine"] is True and set(summ["attrs"]) == {"label", "n"}
    assert r.log["values"][summ["attrs"]["n"]]["repr"] == "3"


# -- trampoline: warnings -------------------------------------------------------------------------


def test_warning_points_at_student_line_and_registry_is_the_students() -> None:
    src = """import warnings
import numpy as np
warnings.simplefilter("default")
warnings.warn("once", FutureWarning, stacklevel=1)
x = np.array([1.0])
warnings.warn("once", FutureWarning, stacklevel=1)
"""
    with warnings.catch_warnings(record=True) as got:
        record(src, prelude=False)
    with warnings.catch_warnings(record=True) as want:
        plain(src, prelude=False)
    key = [(w.filename, w.lineno, str(w.message)) for w in got]
    assert key == [(w.filename, w.lineno, str(w.message)) for w in want]
    assert [lineno for _, lineno, _ in key] == [4, 6]  # different lines, so both are shown


def test_warning_with_stacklevel_two_from_student_function() -> None:
    src = """import warnings
def f():
    warnings.warn("hey", UserWarning, stacklevel=2)
f()
"""
    with warnings.catch_warnings(record=True) as got:
        warnings.simplefilter("always")
        record(src, prelude=False)
    assert [(w.filename, w.lineno) for w in got] == [("<student>", 4)]


def test_current_line_is_the_innermost_open_call() -> None:
    ins = instrument("def g():\n    return probe()\n\n\ny = g()\n")
    rec = Recorder(ins.sites, RunConfig(), None)
    ns: dict[str, Any] = {"probe": lambda: rec.current_line(), "__name__": "__main__"}
    assert rec.current_line() is None
    rec.install()
    try:
        exec(compile(ins.tree, "<student>", "exec"), ns)
    finally:
        rec.uninstall()
    assert ns["y"] == 5  # the call `g()` on line 5 was open while probe ran
    assert rec.current_line() is None


# -- streaming ------------------------------------------------------------------------------------


def assemble(rec_msgs: list[dict[str, Any]], sites: list[dict[str, Any]]) -> dict[str, Any]:
    """A Python port of the assembler's batch handling (packages/log/src/assemble.ts)."""
    events: list[dict[str, Any]] = []
    values: dict[str, Any] = {}
    bindings: list[tuple[int, list[Any], str | None]] = []
    output: list[Any] = []
    diagnostics: list[str] = []
    for m in rec_msgs:
        for ev in m["events"]:
            if ev.get("slot"):
                if any(
                    e.get("slot") and e["merge_key"] == ev["merge_key"] and e["i"] > ev["i"]
                    for e in events
                ):
                    continue
                events = [
                    e for e in events if not (e.get("slot") and e["merge_key"] == ev["merge_key"])
                ]
            events = [e for e in events if e["i"] != ev["i"]]
            events.append(ev)
        values.update(m["values"])
        for _scope, event, name, token, *rest in m["bindings"]:
            key = rest[0] if rest else None
            if key is not None:
                if any(k == key and b[0] > event for _, b, k in bindings):
                    continue
                bindings = [x for x in bindings if x[2] != key]
            bindings.append((0, [event, name, token], key))
        output.extend(m["output"])
        diagnostics.extend(m["diagnostics"])
    events.sort(key=lambda e: e["i"])
    order = sorted(range(len(bindings)), key=lambda k: (bindings[k][1][0], k))
    return {
        "events": events,
        "values": values,
        "bindings": [bindings[k][1] for k in order],
        "output": output,
        "diagnostics": diagnostics,
        "sites": sites,
    }


def test_stream_assembles_to_the_log() -> None:
    r = record(
        FRAME
        + """
X = df[["a", "b"]]
y = df["y"]
m = LinearRegression()
for k in range(25):
    m.fit(X, y)
    s = m.score(X, y)
df["c"] = df["a"] * 2
"""
    )
    a = assemble(r.msgs, r.log["sites"])
    assert a["events"] == r.log["events"]
    assert a["values"] == r.log["values"]
    assert a["bindings"] == r.log["scopes"][0]["bindings"]
    # every token that is referenced has a values entry
    for e in r.events:
        toks = e["outputs"] + [x for m in e["mutates"] for x in m] + [e["owner"] or ""]
        toks += [i["value"] for i in e["inputs"] if "value" in i]
        assert all(t in r.log["values"] for t in toks if t)
    for _, _, tok in r.log["scopes"][0]["bindings"]:
        assert tok in r.log["values"]
    # `i` is monotonic and unique
    assert len({e["i"] for e in r.events}) == len(r.events)


def test_open_stack_and_callbacks_and_time_flush(monkeypatch: pytest.MonkeyPatch) -> None:
    ins = instrument("import numpy as np\nx = np.array([1])\ny = np.sum(x)\n")
    msgs: list[dict[str, Any]] = []
    entered: list[tuple[int, int]] = []
    exited: list[int] = []
    clock = iter(range(0, 1000))
    monkeypatch.setattr(recorder_mod.time, "monotonic", lambda: next(clock))  # each tick = 1 s
    rec = Recorder(
        ins.sites, RunConfig(), msgs.append,
        on_enter=lambda i, s: entered.append((i, s)), on_exit=exited.append,
    )  # fmt: skip
    rec.install()
    try:
        exec(compile(ins.tree, "<student>", "exec"), {"__name__": "__main__"})
    finally:
        rec.close_open(None)
        rec.uninstall()
    assert [e for e, _ in entered] == [0, 1] and exited == [0, 1]
    assert len(msgs) >= 3  # flush at (almost) every hook entry with this clock, plus the close
    assert any(m["open"] for m in msgs)  # a started call shows in the open stack
    assert msgs[-1]["open"] == []
    assert [o["name"] for m in msgs for o in m["open"]][:1] == ["array"]
    assert msgs[0]["type"] == "batch"
    assert set(msgs[0]) == {"type", "events", "open", "values", "bindings", "output", "diagnostics"}
    a = assemble(msgs, ins.sites)
    assert [e["name"] for e in a["events"]] == ["array", "sum"]


def test_output_entries_flow_through_batches() -> None:
    ins = instrument("x = 1\n")
    msgs: list[dict[str, Any]] = []
    rec = Recorder(ins.sites, RunConfig(), msgs.append)
    rec.add_output({"i": -1, "stream": "stdout", "text": "hi"})
    rec.close_open(None)
    assert msgs[-1]["output"] == [{"i": -1, "stream": "stdout", "text": "hi"}]
    assert rec.log("ok", None)["output"] == [{"i": -1, "stream": "stdout", "text": "hi"}]


def test_loop_over_models_keeps_owner_identity() -> None:
    r = record(
        FRAME
        + """
X = df[["a", "b"]]
y = df["y"]
models = [LinearRegression(), LinearRegression()]
for m in models:
    m.fit(X, y)
"""
    )
    fits = r.by_name("LinearRegression.fit")
    ctors = r.by_name("LinearRegression")
    assert [f["count"] for f in fits] == [1, 2] and fits[0]["merge_key"] == fits[1]["merge_key"]
    assert [f["owner"] for f in fits] == [c["outputs"][0] for c in ctors]
    assert fits[0]["owner"] != fits[1]["owner"]


def test_binding_rows_are_capped_so_loops_cannot_grow_the_log() -> None:
    src = "for i in range(20000):\n    n = len([i])\n"
    r = record(src, prelude=False, max_events=50)
    assert r.err is None and r.ns["i"] == 19999  # the program ran to the end
    assert r.rec.limit_hit and r.log["status"] == "limit"
    assert len(r.log["values"]) < 1000


def test_expr_event_keys_do_not_collide_with_their_consumer() -> None:
    r = record(FRAME + 'out = np.full(df["a"].shape, df["a"].mean())\n')
    keys = [e["merge_key"] for e in r.events]
    assert len(keys) == len(set(keys))
    full = r.one("full")
    assert full["merge_key"].startswith("s") and "." not in full["merge_key"]


# -- determinism ----------------------------------------------------------------------------------


def test_log_is_deterministic_and_has_no_addresses() -> None:
    src = (
        FRAME
        + """
X = df[["a", "b"]]
m = LinearRegression().fit(X, df["y"])
"""
    )
    a = record(src).log
    b = record(src).log
    assert a == b
    assert "0x" not in repr(a)


# -- transparency over the fixture programs -------------------------------------------------------

PROGRAMS = sorted((ROOT / "fixtures" / "programs").glob("*.py"))


def _ns_summary(ns: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in ns.items():
        if k.startswith("__"):
            continue
        if isinstance(v, pd.DataFrame | pd.Series | np.ndarray):
            out[k] = f"{type(v).__name__}{v.shape}"
        elif isinstance(v, int | float | str | bool | bytes | type(None) | np.generic):
            out[k] = repr(v)
        else:
            out[k] = type(v).__name__
    return out


def _run_fixture(
    path: Path, recorded: bool
) -> tuple[str, str | None, dict[str, str], Result | None]:
    src = path.read_text()
    buf = io.StringIO()
    ns: dict[str, Any] = {"__name__": "__main__"}
    err: str | None = None
    rec = None
    with contextlib.chdir(DATA), contextlib.redirect_stdout(buf), warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            if recorded:
                ins = instrument(src)
                rec = Recorder(ins.sites, RunConfig(), lambda m: None)
                rec.install()
                try:
                    exec(compile(ins.tree, "<student>", "exec"), ns)
                finally:
                    rec.close_open(None)
                    rec.uninstall()
            else:
                exec(compile(src, "<student>", "exec"), ns)
        except SyntaxError as e:
            err = f"SyntaxError: {e.msg}"
        except BaseException as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
    result = None
    if rec is not None:
        result = Result(rec, rec.log("ok", None), [], ns, buf.getvalue(), None)
    return buf.getvalue(), err, _ns_summary(ns), result


@pytest.mark.slow
@pytest.mark.parametrize("path", PROGRAMS, ids=lambda p: p.name)
def test_fixture_transparency(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def no_input(*_: Any) -> str:
        raise RuntimeError("input() is not supported here")

    monkeypatch.setattr("builtins.input", no_input)
    monkeypatch.setenv("MPLBACKEND", "Agg")
    want = _run_fixture(path, recorded=False)
    got = _run_fixture(path, recorded=True)
    assert got[0] == want[0], "stdout differs"
    assert got[1] == want[1], "exception differs"
    assert got[2] == want[2], "final namespace differs"
    result = got[3]
    if result is not None:
        assert result.log["diagnostics"] == []
        for ev in result.log["events"]:
            for tok in ev["outputs"]:
                assert tok in result.log["values"]
