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
        # `def` / `class` steps (svl-jl3) are left out: these tests are about calls and the like;
        # python/tests/test_defs.py covers the def events.
        return [e for e in self.log["events"] if e["kind"] != "def"]

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
    assert [(e["name"], e["kind"]) for e in r.events if e["kind"] != "import"] == [
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
        max_events=7,  # the four prelude imports count, the hidden `len` calls do not
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


_BOOM = """
def f():
    raise ValueError("boom")

def g():
    return np.array([1])
"""


def _flags(src: str) -> tuple[Result, Result, dict[str, Any]]:
    r = record(_BOOM + src)
    p = plain(_BOOM + src)
    assert r.stdout == p.stdout and type(r.err) is type(p.err)
    assert str(r.err) == str(p.err)
    (f,) = r.by_name("f")
    return r, p, f["error"]


def test_call_in_finally_does_not_mark_propagating_error_handled() -> None:
    r, _, err = _flags("try:\n    f()\nfinally:\n    g()\n    print('fin')\n")
    assert isinstance(r.err, ValueError)
    assert err["handled"] is False
    assert r.one("g")["error"] is None


def test_call_in_finally_inside_outer_except_is_handled() -> None:
    r, _, err = _flags(
        "try:\n    try:\n        f()\n    finally:\n        g()\n"
        "except ValueError:\n    print('caught')\nx = g()\n"
    )
    assert r.err is None and err["handled"] is True


def test_outer_except_with_no_later_call_is_handled_at_the_end() -> None:
    r, _, err = _flags(
        "try:\n    try:\n        f()\n    finally:\n        g()\nexcept ValueError:\n    pass\n"
    )
    assert r.err is None and err["handled"] is True


def test_call_in_except_block_and_later_calls_is_handled() -> None:
    r, _, err = _flags("try:\n    f()\nexcept ValueError:\n    g()\ng()\n")
    assert r.err is None and err["handled"] is True
    r, _, err = _flags("try:\n    f()\nexcept ValueError:\n    pass\ng()\n")
    assert err["handled"] is True


def test_nested_finally_with_reraise_stays_unhandled() -> None:
    src = (
        "try:\n    try:\n        f()\n    finally:\n        g()\n"
        "finally:\n    try:\n        g()\n    finally:\n        g()\n"
    )
    r, _, err = _flags(src)
    assert isinstance(r.err, ValueError) and err["handled"] is False
    r, _, err = _flags(
        "try:\n    try:\n        f()\n    finally:\n        g()\nexcept ValueError:\n    raise\n"
    )
    assert isinstance(r.err, ValueError) and err["handled"] is False


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


def test_attribute_read_of_machine_attr_is_expr_event_with_existing_token() -> None:
    r = record(
        FRAME
        + """
df = pd.DataFrame({"a": [1.0, 2.0, 4.0], "b": [1.0, 0.0, 3.0]})
m = LinearRegression().fit(df[["a"]], df["b"])
coefs = m.coef_
again = m.coef_
models = {"rf": m}
alias = models["rf"]
"""
    )
    evs = [e for e in r.events if e["name"] == "m.coef_"]
    assert len(evs) == 1  # the second read is an alias: the token has a producer now
    ev = evs[0]
    assert ev["kind"] == "expr" and ev["outputs"] == [r.bound("coefs")]
    assert r.bound("again") == r.bound("coefs")
    assert [(i["param"], i["value"]) for i in ev["inputs"]] == [("m", r.bound("m"))]
    assert not [e for e in r.events if e["name"] == 'models["rf"]']  # plain aliasing: no node


def test_attribute_read_after_a_call_consumed_the_value_stays_an_alias() -> None:
    r = record(
        FRAME
        + """
df = pd.DataFrame({"a": [1.0, 2.0, 4.0], "b": [1.0, 0.0, 3.0]})
m = LinearRegression().fit(df[["a"]], df["b"])
rr = np.round(m.coef_)
coefs = m.coef_
"""
    )
    assert not [e for e in r.events if e["name"] == "m.coef_" and e["outputs"]]
    assert r.bound("coefs") in [i["value"] for e in r.events for i in e["inputs"] if "value" in i]


def test_attribute_read_with_no_tokened_name_emits_nothing() -> None:
    rec = Recorder([], RunConfig())
    ev_before = len(rec._events)
    assert rec._expr_event(0, "k", "m.coef_", ["m"], object(), (), reuse="v1.0") == "v1.0"
    assert len(rec._events) == ev_before


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
    assert [e for e, _ in entered] == [1, 2] and exited == [1, 2]  # event 0 is the import step
    assert len(msgs) >= 3  # flush at (almost) every hook entry with this clock, plus the close
    assert any(m["open"] for m in msgs)  # a started call shows in the open stack
    assert msgs[-1]["open"] == []
    assert [o["name"] for m in msgs for o in m["open"]][:1] == ["array"]
    assert msgs[0]["type"] == "batch"
    assert set(msgs[0]) == {"type", "events", "open", "values", "bindings", "output", "diagnostics"}
    a = assemble(msgs, ins.sites)
    assert [e["name"] for e in a["events"]] == ["import numpy as np", "array", "sum"]


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


# -- review fixes (PR #13) -------------------------------------------------------------------------


def _same_as_plain(src: str, prelude: bool = False) -> tuple[Result, Result]:
    r = record(src, prelude=prelude)
    p = plain(src, prelude=prelude)
    assert type(r.err) is type(p.err), (r.err, p.err)
    assert r.stdout == p.stdout
    assert r.rec.diagnostics == []
    return r, p


def test_query_with_at_sees_the_callers_locals() -> None:
    src = """
import pandas as pd
df = pd.DataFrame({'a': [1, 2, 3]})
t = 1
print(len(df.query('a > @t')))
print([len(df.query('a > @t')) for t in (0, 1, 2)])
print(list(df.eval('a + @t')))
print(list(pd.eval('df.a + t')))
print([list(df.eval('a * @k')) for k in (2, 3)])
class K:
    t = 1
    n = len(df.query('a > @t'))
    m = [len(df.query('a > @u')) for u in (0, 1)]
print(K.n, K.m)
gen = (len(df.query('a > @g')) for g in (0, 2))
print(list(gen))
"""
    r, p = _same_as_plain(src)
    assert r.err is None and "UndefinedVariableError" not in r.stdout


def test_callee_sees_the_students_frame() -> None:
    src = """
import sys
def who():
    f = sys._getframe(1)
    return f.f_locals is globals(), f.f_globals is globals(), f.f_code.co_name, f.f_code.co_filename
print(who())
print([who() for _ in range(1)])
class C:
    r = who()
print(C.r)
"""
    r, p = _same_as_plain(src)
    assert "(True, True, '<module>', '<student>')" in r.stdout


def test_aliased_eval_exec_locals_see_the_callers_namespace() -> None:
    src = """
e = eval
x = 5
print(e("x + 1"))
ex = exec
ex("y = 7")
print(y)
lc = locals
print(sorted(k for k in lc() if k in ("x", "y")))
def f():
    return [e("x * 2") for _ in range(1)]
print(f())
"""
    r, _ = _same_as_plain(src)
    assert r.err is None


def test_pandas_stack_level_is_the_student_frame() -> None:
    # pandas walks out of its own package to blame a frame: it must be `<student>`, not the hook
    src = """import warnings
import pandas as pd
warnings.simplefilter("always")
s = pd.Series([1, 2, 3])
x = s.rank(
    method="average")
"""
    with warnings.catch_warnings(record=True) as got:
        record(src, prelude=False)
    with warnings.catch_warnings(record=True) as want:
        plain(src, prelude=False)
    assert [(w.filename, w.lineno) for w in got] == [(w.filename, w.lineno) for w in want]


def test_store_with_call_rhs_keeps_its_wire() -> None:
    r = record(
        """
df = pd.DataFrame({'a': [1., 2, 3], 'b': [4., 5, 6]})
m = LinearRegression().fit(df[['a']], df['b'])
df['pred'] = m.predict(df[['a']])
df['z'] = pd.Series([1, 2, 3])
d = {}
d['k'] = m.predict(df[['a']])
"""
    )
    preds = r.by_name("LinearRegression.predict")
    stores = [e for e in r.events if e["kind"] == "store"]
    assert [s["name"] for s in stores] == [
        "df['pred'] = m.predict(df[['a']])",
        "df['z'] = pd.Series([1, 2, 3])",
        "d['k'] = m.predict(df[['a']])",
    ]
    assert inp(stores[0], "value") == {
        "param": "value",
        "origin": "call",
        "value": preds[0]["outputs"][0],
    }
    assert inp(stores[1], "value")["value"] == r.by_name("Series")[0]["outputs"][0]
    assert inp(stores[2], "value")["value"] == preds[1]["outputs"][0]


def test_unrecorded_execution_of_a_site_never_reuses_an_earlier_output() -> None:
    src = """
arr = np.array([3.0, 1.0, 2.0])
df = pd.DataFrame({'a': [1, 2, 3]})
d = {}
for f in (np.sort, sorted):
    df['x'] = f(arr)
    d['k'] = f(arr)
    y = f(arr)
    z = np.full(2, len(f(arr)))
"""
    r = record(src)
    assert r.err is None
    sort_out = [e["outputs"][0] for e in r.by_name("sort")]
    stores = [e for e in r.events if e["kind"] == "store"]
    # first iteration: np.sort is recorded and wired; second: `sorted` is hidden, no wire
    wired = [
        inp(s, "value")["value"] for s in stores if any(i["param"] == "value" for i in s["inputs"])
    ]
    assert set(wired) <= set(sort_out) and len(wired) == 2 * 1
    second = stores[2:]
    assert all(not any(i["param"] == "value" for i in s["inputs"]) for s in second)
    # bind: `y` in the second iteration is not the np.sort output
    assert r.bound("y") not in sort_out
    assert r.log["values"][r.bound("y")]["type"] in ("list[3]", "list")


def test_student_global_named_rc_does_not_break_calls() -> None:
    src = """
__rc__ = 1
import numpy as np
x = np.zeros(2)
print(__rc__, sorted(k for k in globals() if "rc" in k))
"""
    r = record(src, prelude=False)
    p = plain(src, prelude=False)
    assert r.err is None and r.stdout == p.stdout


def test_warning_line_in_a_multiline_method_chain_matches_cpython() -> None:
    src = """import warnings
class A:
    def m(self, *a):
        warnings.warn("w", stacklevel=2)
        return self
a = A()
warnings.simplefilter("default")
(a
   .m()
   .m())
a.m(
    1,
    2)
a.m(1).m(
    2).m(3)
x = [a.m(i)
     for i in range(2)]
"""
    with warnings.catch_warnings(record=True) as got:
        r = record(src, prelude=False)
    with warnings.catch_warnings(record=True) as want:
        plain(src, prelude=False)
    assert [(w.filename, w.lineno) for w in got] == [("<student>", w.lineno) for w in want]
    assert len(got) >= 4
    assert r.log["sites"][[s["text"] for s in r.log["sites"]].index("a\n   .m()")]["func_line"] == 9


def test_positional_only_name_and_var_keyword_do_not_clash() -> None:
    r = record(
        """
def f(a, /, **kw):
    return (a, kw)

out = f(1, a=2, b=3)
""",
        prelude=False,
    )
    assert r.ns["out"] == (1, {"a": 2, "b": 3})
    ev = r.one("f")
    assert [i["param"] for i in ev["inputs"]] == ["a", "kw[a]", "b"]


def test_plan_cache_does_not_keep_callables_alive() -> None:
    import gc

    src = """
import weakref
refs = []
for k in range(5):
    f = lambda x, k=k: x
    refs.append(weakref.ref(f))
    f(1)
"""
    r = record(src, prelude=False)
    del r.ns["f"]
    gc.collect()
    assert len(r.ns["refs"]) == 5 and all(w() is None for w in r.ns["refs"])
    assert len(r.rec._strong) == 0


def test_each_input_is_fingerprinted_at_most_twice_per_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from machines.values import ValueTable

    calls: list[int] = []
    orig = ValueTable._fingerprint

    def counting(self: ValueTable, obj: Any) -> Any:
        if isinstance(obj, pd.DataFrame):
            calls.append(id(obj))
        return orig(self, obj)

    monkeypatch.setattr(ValueTable, "_fingerprint", counting)
    r = record(FRAME + "x = df.mean()\n")
    assert r.err is None
    # one baseline (first sight) at the frame's creation, then pre- and post-call for `mean`
    assert len(calls) <= 3, calls


def test_deleted_list_runs_del_even_in_a_loop_of_big_lists() -> None:
    src = """
import numpy as np
for i in range(30):
    data = list(range(200000))
    arr = np.array(data)
    s = np.sum(arr)
"""
    r = record(src, prelude=False)
    assert r.err is None
    assert len(r.rec.vt._keep) <= 2  # 16 MiB budget; a 200k list weighs about 21 MB with keys


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


# -- svl-8r4: index operands of stores and calls inside expression origins ------------------------


def test_store_index_operand_is_wired() -> None:
    r = record(
        FRAME
        + """
mask = df["a"] > 2
df.loc[mask, "c"] = 0
"""
    )
    (st,) = [e for e in r.events if e["kind"] == "store"]
    assert inp(st, "index[mask]") == {
        "param": "index[mask]",
        "origin": "name",
        "value": r.bound("mask"),
    }
    assert inp(st, "target")["value"] != r.bound("mask")
    # the constant column label and the value draw nothing extra
    assert {i["param"] for i in st["inputs"]} == {"target", "index[mask]", "value"}


def test_store_index_expression_and_call_are_wired() -> None:
    r = record(
        FRAME
        + """
t = 2
df[df["a"] > t] = 0
df.loc[np.isnan(df["a"])] = 1
"""
    )
    s1, s2 = [e for e in r.events if e["kind"] == "store"]
    assert [i["param"] for i in s1["inputs"] if i["param"].startswith("index")] == ["index[t]"]
    nan = r.by_name("isnan")[0]
    assert inp(s2, "index[np.isnan]") == {
        "param": "index[np.isnan]",
        "origin": "call",
        "value": nan["outputs"][0],
    }


def test_store_index_rebound_by_the_statement_gives_no_wire() -> None:
    r = record(
        """
a = [0, 1, 2]
i = 0
a[i], i = 5, 2
j = 1
a[j] = j = 2
""",
        prelude=False,
    )
    assert r.err is None
    for st in [e for e in r.events if e["kind"] == "store"]:
        assert not [i for i in st["inputs"] if i["param"].startswith("index")]


def test_store_index_evaluated_once_and_behaviour_unchanged() -> None:
    src = """
log = []
def pick(k):
    log.append(k)
    return k
d = {}
mask = pd.Series([True, False, True])
df = pd.DataFrame({"a": [1, 2, 3]})
d[pick("x")] = pick(1)
df.loc[mask, "c"] = pick(0)
df[df["a"] > pick(1)] = pick(9)
x = [d, df["c"].tolist(), df["a"].tolist()]
"""
    a, b = record(src), plain(src)
    assert a.err is None and b.err is None
    assert a.ns["log"] == b.ns["log"]
    assert repr(a.ns["x"]) == repr(b.ns["x"])


def test_list_literal_with_inline_calls_wires_the_instances() -> None:
    r = record(
        """
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
pipe = Pipeline([("s", StandardScaler()), ("m", LinearRegression())])
"""
    )
    (ex,) = [e for e in r.events if e["kind"] == "expr"]
    sc, lr = r.one("StandardScaler"), r.one("LinearRegression")
    assert inp(ex, "StandardScaler")["value"] == sc["outputs"][0]
    assert inp(ex, "LinearRegression")["value"] == lr["outputs"][0]
    pl = r.one("Pipeline")
    assert inp(pl, "steps")["value"] == ex["outputs"][0]


def test_nested_call_in_expr_is_wired() -> None:
    r = record(
        FRAME
        + """
mask = df["a"] > df["a"].median()
"""
    )
    med = [e for e in r.events if e["name"].endswith("median")]
    assert len(med) == 1
    ex = [e for e in r.events if e["kind"] == "expr" and e["name"].startswith('df["a"] >')]
    assert len(ex) == 1
    assert inp(ex[0], 'df["a"].median')["value"] == med[0]["outputs"][0]


def test_conditional_and_lambda_calls_in_exprs_give_no_call_wire() -> None:
    src = """
out = []
for f in [True, False]:
    a = np.array([1.0, 2.0])
    out.append([np.sum(a) if f else 0, f and np.max(a), (lambda: np.min(a))()])
    out.append([np.abs(a) for _ in a])
    v = [1, f or np.mean(a), (np.sum(a) if f else 7)]
"""
    r, p = record(src), plain(src)
    assert r.err is None
    for e in r.events:
        if e["kind"] == "expr":
            assert not [i for i in e["inputs"] if i["origin"] == "call"], e["name"]
    assert repr(r.ns["out"]) == repr(p.ns["out"]) and repr(r.ns["v"]) == repr(p.ns["v"])


REBIND_SRC = """
mask = df["a"] > 2
other = df["b"] > 2
def f():
    global mask
    mask = other
    return 0
df.loc[mask, "y"] = f()
w = df["a"] * 2
def g():
    global w
    w = df["b"] * 3
    return 0
df["z"] = w + g()
"""


def test_store_names_rebound_during_the_statement_give_no_wire() -> None:
    r = record(FRAME + REBIND_SRC)
    assert r.err is None
    s1, s2 = [e for e in r.events if e["kind"] == "store"]
    assert not [i for i in s1["inputs"] if i["param"].startswith("index")]
    assert not [i for i in s2["inputs"] if i["param"] == "value[w]"]
    # and a normal store still wires
    ok = record(FRAME + 'mask = df["a"] > 2\ndf.loc[mask, "y"] = 0\n')
    assert any(i["param"] == "index[mask]" for e in ok.events for i in e["inputs"])


def test_store_rebind_case_is_transparent() -> None:
    a, b = record(FRAME + REBIND_SRC), plain(FRAME + REBIND_SRC)
    assert a.err is None and b.err is None
    assert a.ns["df"].equals(b.ns["df"])
    assert a.ns["mask"].equals(b.ns["mask"])


# -- a name rebound to something untracked closes its binding (svl-o6m) ----------------------------


def test_rebinding_a_tracked_name_to_a_function_closes_the_binding() -> None:
    src = """
a = np.array([1, 2, 3])
k = a.mean()
k = print
j = print
f = k
"""
    r = record(src)
    rows = [(n, t) for _, n, t in r.log["scopes"][0]["bindings"] if n in ("k", "j", "f")]
    # k held a float, then a function: an empty token ends the first binding.
    # j was never tracked: no row
    assert rows[0][0] == "k" and rows[0][1].startswith("s")
    assert ("k", "") in rows
    assert not any(n == "j" for n, _ in rows)
    assert not any(
        n == "f" for n, _ in rows
    )  # `f = k` binds a function too: not tracked, never was
    # transparency: instrumented code ends with the same values as plain Python
    p = plain(src)
    assert r.err is None and p.err is None
    assert r.ns["k"] is print and r.ns["f"] is print and r.ns["j"] is print
    assert p.ns["k"] is print and p.stdout == r.stdout


def test_value_rebinding_behaves_as_plain_python() -> None:
    src = """
a = np.array([1.0, 2.0, 3.0])
n = a.sum()
m = n
n = a.max()
n += 1
for v in a:
    n = n + v
t = (n, m)
n = None
"""
    r = record(src)
    p = plain(src)
    assert r.err is None and p.err is None
    assert (r.ns["n"], r.ns["m"], r.ns["t"], r.ns["v"]) == (
        p.ns["n"],
        p.ns["m"],
        p.ns["t"],
        p.ns["v"],
    )
    toks = [(n, t) for _, n, t in r.log["scopes"][0]["bindings"] if n in ("n", "m")]
    # m = n shares the value's token; n = a.max() is another value, as is every rebinding of n
    assert dict(toks)["m"] == toks[0][1]
    ns_tokens = [t for n, t in toks if n == "n"]
    assert len(set(ns_tokens)) == len(ns_tokens)
