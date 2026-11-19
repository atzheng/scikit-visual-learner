from __future__ import annotations

import gc
import json
import struct
import subprocess
import sys
import weakref
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import scipy.sparse as sp
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler

import machines.values
from machines.values import ValueTable


@pytest.fixture
def vt() -> ValueTable:
    return ValueTable()


def small_df() -> pd.DataFrame:
    return pd.DataFrame({"a": [1.0, 2.0, 3.0, None], "b": ["x", "y", "z", "w"]})


# -- tokens ----------------------------------------------------------------------------------


def test_tokens_first_seen_order_and_identity(vt: ValueTable) -> None:
    a, b = small_df(), small_df()
    assert vt.token(a) == "v0.0"
    assert vt.token(b) == "v1.0"
    assert vt.token(a) == "v0.0"


def test_reused_id_gets_new_number(vt: ValueTable) -> None:
    seen = []
    ids = set()
    for _ in range(200):
        df = small_df()
        ids.add(id(df))
        seen.append(vt.token(df))
        del df
        gc.collect()
    assert len(set(seen)) == 200
    assert len(ids) < 200  # ids really were reused, so the test exercises the finalizer


def test_dead_weakref_entries_removed(vt: ValueTable) -> None:
    df = small_df()
    vt.token(df)
    del df
    gc.collect()
    assert vt._ids == {}


def test_non_weakrefable_kept_alive_within_bound_until_reset(vt: ValueTable) -> None:
    lst = [[1], [2]]
    with pytest.raises(TypeError):
        weakref.ref(lst)
    t = vt.token(lst)
    assert any(o is lst for o, _ in vt._keep.values())
    del lst
    gc.collect()
    assert len(vt._keep) == 1
    kept = next(iter(vt._keep.values()))[0]
    assert vt.token(kept) == t
    vt.reset()
    assert len(vt._keep) == 0


def test_keep_is_an_lru_and_eviction_drops_the_number(vt: ValueTable) -> None:
    from machines import values

    class A:
        deleted: list[int] = []

        def __init__(self, k: int) -> None:
            self.k = k

        def __del__(self) -> None:
            A.deleted.append(self.k)

    n = values._KEEP_MAX + 20
    tokens = []
    for k in range(n):
        lst = [A(k)]
        tokens.append(vt.token(lst))
        del lst
    gc.collect()
    assert len(vt._keep) == values._KEEP_MAX
    assert sorted(A.deleted) == list(range(20))  # the evicted ones were freed (`__del__` ran)
    assert len(vt._ids) == values._KEEP_MAX  # their id -> number entries went with them


def test_keep_has_a_byte_budget_and_always_holds_the_newest(vt: ValueTable) -> None:
    from machines import values

    # sys.getsizeof counts one pointer per item: 8 bytes on 64-bit, 4 on wasm32 (Pyodide)
    big = [0] * (values._KEEP_BYTES // (struct.calcsize("P") + values._KEY_BYTES) + 10)
    vt.token(big)
    assert len(vt._keep) == 1  # alone over the budget, still kept: its number must stay valid
    small = [1]
    vt.token(small)
    assert len(vt._keep) == 1 and next(iter(vt._keep.values()))[0] is small


def test_no_false_wire_after_eviction_and_id_reuse(vt: ValueTable) -> None:
    from machines import values

    first = [1, 2, 3]
    t_first = vt.token(first)
    first_id = id(first)
    others = [[i] for i in range(values._KEEP_MAX + 5)]
    for o in others:
        vt.token(o)
    assert first_id not in vt._ids  # evicted
    del first
    gc.collect()
    # new lists may reuse the freed id; none may inherit the old token
    seen = set()
    for _ in range(200):
        fresh = [9, 9]
        t = vt.token(fresh)
        assert t != t_first and t not in seen
        seen.add(t)
    still = others[-1]
    assert vt.token(still) == vt.token(still)  # a live, tracked object keeps its token


def test_evicted_but_alive_object_gets_a_fresh_token(vt: ValueTable) -> None:
    from machines import values

    keep = [0]
    t0 = vt.token(keep)
    for i in range(values._KEEP_MAX + 1):
        vt.token([i])
    assert vt.token(keep) != t0  # a missing wire, never a false one


def test_fresh_scalar_always_new(vt: ValueTable) -> None:
    assert [vt.fresh_scalar(5), vt.fresh_scalar(5), vt.fresh_scalar(5)] == ["s0", "s1", "s2"]


def test_reset_restarts_numbering(vt: ValueTable) -> None:
    vt.token(small_df())
    vt.reset()
    assert vt.token(small_df()) == "v0.0"


# -- classification --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "obj",
    [
        1, 1.5, True, "s", b"b", None, 1j, Ellipsis,
        np.int64(3), np.float64(2.0), np.bool_(True), np.True_, np.float32(1),
        pd.NA, pd.NaT, pd.Timestamp("2020-01-01"), pd.Timedelta(1, "D"), pd.Period("2020"),
        (1, "a", None), (), frozenset({1, 2}), ((1, 2), (3,)),
    ],
)  # fmt: skip
def test_scalar(vt: ValueTable, obj: object) -> None:
    assert vt.classify(obj) == "scalar"


@pytest.mark.parametrize(
    "obj",
    [lambda: 0, len, np.log1p, np.add, int, LinearRegression, np, pd, small_df, "".join,
     small_df().sum],
)  # fmt: skip
def test_label(vt: ValueTable, obj: object) -> None:
    assert vt.classify(obj) == "label"


@pytest.mark.parametrize(
    "obj",
    [small_df(), pd.Series([1]), np.zeros(3), LinearRegression(), [1], {"a": 1}, {1}, ([1], 2),
     sp.csr_matrix(np.eye(3)), object()],
)  # fmt: skip
def test_reference(vt: ValueTable, obj: object) -> None:
    assert vt.classify(obj) == "reference"


# -- fingerprints ----------------------------------------------------------------------------


def changed(vt: ValueTable, obj: object) -> bool:
    return vt.check(obj) is not None


def test_check_first_sight_and_reread(vt: ValueTable) -> None:
    df = small_df()
    assert vt.check(df) is None
    assert vt.token(df) == "v0.0"
    assert vt.check(df) is None
    _ = df["a"].sum(), df.shape, df.head()
    assert vt.check(df) is None
    assert vt.check(1) is None


def test_dataframe_mutations_bump(vt: ValueTable) -> None:
    df = small_df()
    vt.token(df)
    df.dropna(inplace=True)
    assert vt.check(df) == ("v0.0", "v0.1")
    df.sort_values("a", ascending=False, inplace=True)
    assert vt.check(df) == ("v0.1", "v0.2")
    df["c"] = 1
    assert vt.check(df) == ("v0.2", "v0.3")
    df.loc[df.index[0], "a"] = 99.0
    assert vt.check(df) == ("v0.3", "v0.4")
    assert vt.token(df) == "v0.4"


def test_array_mutation_bumps(vt: ValueTable) -> None:
    arr = np.zeros(4)
    vt.token(arr)
    assert vt.check(arr) is None
    arr[0] = 1
    assert vt.check(arr) == ("v0.0", "v0.1")


def test_series_and_sparse(vt: ValueTable) -> None:
    s = pd.Series([1, 2, 3])
    m = sp.csr_matrix(np.eye(3))
    vt.token(s), vt.token(m)
    assert vt.check(s) is None and vt.check(m) is None
    s[0] = 5
    m.data[0] = 7.0
    assert changed(vt, s) and changed(vt, m)


def test_estimator_fit_bumps_and_refit(vt: ValueTable) -> None:
    est = LinearRegression()
    vt.token(est)
    assert vt.check(est) is None
    est.set_params(fit_intercept=True)  # same value, no change
    assert vt.check(est) is None
    x, y = np.arange(6.0).reshape(3, 2), np.arange(3.0)
    est.fit(x, y)
    assert vt.check(est) == ("v0.0", "v0.1")
    assert vt.check(est) is None
    est.fit(x, y)  # new attribute objects
    assert vt.check(est) == ("v0.1", "v0.2")
    est.set_params(fit_intercept=False)
    assert changed(vt, est)


def test_list_dict_set_changes(vt: ValueTable) -> None:
    lst, d, s = [1, 2], {"a": 1}, {1}
    for o in (lst, d, s):
        vt.token(o)
    assert all(vt.check(o) is None for o in (lst, d, s))
    lst.append(3)
    d["b"] = 2
    s.add(2)
    assert all(changed(vt, o) for o in (lst, d, s))
    lst[0] = 10  # same length, different item
    assert changed(vt, lst)
    lst[0] = 10
    assert not changed(vt, lst)


def test_large_frame_same_shape_change_not_detected(vt: ValueTable) -> None:
    big = pd.DataFrame(np.zeros((1000, 200)))  # 200,000 cells > hash_cells
    vt.token(big)
    big.iloc[0, 0] = 5.0
    assert vt.check(big) is None  # documented limit
    big["new"] = 1.0  # structural change is still seen
    assert vt.check(big) is not None


def test_hash_cells_configurable() -> None:
    vt = ValueTable(hash_cells=10)
    df = pd.DataFrame(np.zeros((5, 5)))
    vt.token(df)
    df.iloc[0, 0] = 1.0
    assert vt.check(df) is None


def test_hash_falls_back_with_unhashable_cells(vt: ValueTable) -> None:
    df = pd.DataFrame({"a": [[1], [2]], "b": [1, 2]})
    vt.token(df)
    assert vt.check(df) is None
    df["c"] = 3  # structural change still found
    assert vt.check(df) is not None


def test_bump_always_bumps(vt: ValueTable) -> None:
    df = small_df()
    assert vt.bump(df) == ("v0.0", "v0.1")
    assert vt.bump(df) == ("v0.1", "v0.2")
    assert vt.check(df) is None
    assert vt.token(df) == "v0.2"


def test_self_referencing_object_can_die(vt: ValueTable) -> None:
    class Node:
        pass

    n = Node()
    n.me = n
    vt.token(n)
    r = weakref.ref(n)
    del n
    gc.collect()
    assert r() is None


# -- machines --------------------------------------------------------------------------------


class Student:
    def __init__(self) -> None:
        self.k = 3
        self._private = 1
        self.data = [1, 2]


def test_is_machine(vt: ValueTable) -> None:
    assert vt.is_machine(LinearRegression())
    assert vt.is_machine(StandardScaler())
    assert not vt.is_machine(small_df())
    assert not vt.is_machine(np.zeros(2))
    assert not vt.is_machine([1])
    assert not vt.is_machine(3)
    assert not vt.is_machine(LinearRegression)


def test_is_machine_main_class(vt: ValueTable) -> None:
    ns: dict[str, object] = {"__name__": "__main__"}
    exec("class Cleaner:\n    pass\n", ns)
    assert vt.is_machine(ns["Cleaner"]())  # type: ignore[operator]
    assert not vt.is_machine(Student())  # defined in tests.test_values, not __main__


def test_is_machine_configured_class() -> None:
    vt = ValueTable(machine_classes=[f"{Student.__module__}.Student"])
    assert vt.is_machine(Student())
    assert not vt.is_machine(object())


# -- summaries -------------------------------------------------------------------------------


def test_summary_dataframe(vt: ValueTable) -> None:
    df = pd.DataFrame(np.arange(40.0).reshape(4, 10), columns=list("abcdefghij"))
    df.iloc[1, 1] = np.nan
    t = vt.token(df)
    vt.summarize(t, df)
    s = vt.values[t]
    assert s["type"] == "DF" and s["shape"] == [4, 10]
    assert s["columns"] == list("abcdefghij")
    assert s["dtypes"] == ["float64"] * 10
    p = s["preview"]
    assert p["kind"] == "table" and p["columns"] == list("abcdefgh")
    assert p["index"] == ["0", "1", "2", "3"]
    assert len(p["rows"]) == 4 and len(p["rows"][0]) == 8
    assert p["rows"][1][1] == "NaN" and p["rows"][0][1] == "1.0"
    assert "dtype" not in s


def test_summary_dataframe_limits(vt: ValueTable) -> None:
    df = pd.DataFrame(np.zeros((20, 60)))
    t = vt.token(df)
    vt.summarize(t, df)
    s = vt.values[t]
    assert len(s["columns"]) == 50 and len(s["dtypes"]) == 50
    assert len(s["preview"]["rows"]) == 5 and len(s["preview"]["rows"][0]) == 8


def test_cell_truncation(vt: ValueTable) -> None:
    df = pd.DataFrame({"a": ["x" * 100]})
    t = vt.token(df)
    vt.summarize(t, df)
    assert len(vt.values[t]["preview"]["rows"][0][0]) == 40


def test_summary_series(vt: ValueTable) -> None:
    ser = pd.Series(range(10), name="n")
    t = vt.token(ser)
    vt.summarize(t, ser)
    s = vt.values[t]
    assert s["type"] == "Series" and s["shape"] == [10] and s["dtype"] == "int64"
    assert s["preview"]["columns"] == ["n"] and len(s["preview"]["rows"]) == 5


def test_summary_array(vt: ValueTable) -> None:
    a1, a2 = np.arange(10.0), np.arange(100.0).reshape(10, 10)
    t1, t2 = vt.token(a1), vt.token(a2)
    vt.summarize(t1, a1)
    vt.summarize(t2, a2)
    assert vt.values[t1]["preview"] == {
        "kind": "matrix",
        "rows": [["0.0", "1.0", "2.0", "3.0", "4.0"]],
    }
    assert vt.values[t1]["shape"] == [10] and vt.values[t1]["dtype"] == "float64"
    p2 = vt.values[t2]["preview"]["rows"]
    assert len(p2) == 5 and len(p2[0]) == 5 and p2[1][0] == "10.0"
    assert vt.values[t2]["type"] == "array"


def test_summary_sparse(vt: ValueTable) -> None:
    m = sp.csr_matrix(np.eye(10))
    t = vt.token(m)
    vt.summarize(t, m)
    s = vt.values[t]
    assert s["type"] == "sparse" and s["shape"] == [10, 10]
    assert s["preview"]["rows"][0][0] == "1.0" and len(s["preview"]["rows"]) == 5


def test_summary_scalars_and_containers(vt: ValueTable) -> None:
    cases = [
        (5, {"type": "int", "repr": "5"}),
        ("hi", {"type": "str", "repr": "'hi'"}),
        (None, {"type": "None", "repr": "None"}),
        (np.int64(3), {"type": "int64", "repr": "3"}),
        ([1, 2, 3], {"type": "list[3]", "repr": "[1, 2, 3]"}),
        ({"a": 1}, {"type": "dict[1]", "repr": "{'a': 1}"}),
        ((1, 2), {"type": "tuple[2]", "repr": "(1, 2)"}),
        ([[1], [2]], {"type": "list[2]", "repr": "[[1], [2]]"}),
    ]
    for i, (obj, want) in enumerate(cases):
        tok = f"s{i}" if vt.classify(obj) == "scalar" else vt.token(obj)
        vt.summarize(tok, obj)
        assert vt.values[tok] == want, obj
    long = "x" * 500
    vt.summarize("s99", long)
    assert len(vt.values["s99"]["repr"]) <= 40


def test_summary_object_repr_has_no_address(vt: ValueTable) -> None:
    o = object()
    t = vt.token(o)
    vt.summarize(t, o)
    assert "0x" not in vt.values[t]["repr"]


def test_summary_estimator(vt: ValueTable) -> None:
    est = LinearRegression()
    est.fit(np.arange(6.0).reshape(3, 2), np.arange(3.0))
    t = vt.token(est)
    vt.summarize(t, est)
    s = vt.values[t]
    assert s["type"] == "LinearRegression" and s["machine"] is True and "repr" not in s
    attrs = s["attrs"]
    assert "fit_intercept" in attrs and "coef_" in attrs and "intercept_" in attrs
    assert "n_features_in_" in attrs and "_private" not in attrs
    assert attrs["coef_"].startswith("v") and attrs["fit_intercept"].startswith("s")
    for tok in attrs.values():  # every token has a summary
        assert tok in vt.values
    assert vt.values[attrs["coef_"]]["type"] == "array"


def test_summary_student_instance(vt: ValueTable) -> None:
    ns: dict[str, object] = {"__name__": "__main__"}
    exec("class C:\n    def __init__(self):\n        self.k = 3\n        self._p = 1\n", ns)
    obj = ns["C"]()  # type: ignore[operator]
    t = vt.token(obj)
    vt.summarize(t, obj)
    s = vt.values[t]
    assert s["machine"] is True and list(s["attrs"]) == ["k"]
    assert vt.values[s["attrs"]["k"]]["repr"] == "3"


def test_summarize_once_and_take_new(vt: ValueTable) -> None:
    df = small_df()
    t = vt.token(df)
    vt.summarize(t, df)
    first = vt.values[t]
    df["z"] = 1
    vt.summarize(t, df)
    assert vt.values[t] is first
    assert list(vt.take_new_summaries()) == [t]
    assert vt.take_new_summaries() == {}


def test_label_has_no_summary(vt: ValueTable) -> None:
    vt.summarize("x", len)
    assert vt.values == {}


def test_preview_budget() -> None:
    vt = ValueTable(preview_bytes=600)
    frames = [pd.DataFrame(np.arange(100.0).reshape(10, 10)) for _ in range(10)]
    toks = [vt.token(f) for f in frames]
    for t, f in zip(toks, frames, strict=True):
        vt.summarize(t, f)
    with_preview = [t for t in toks if "preview" in vt.values[t]]
    assert 0 < len(with_preview) < 10
    last = vt.values[toks[-1]]
    assert "preview" not in last and last["type"] == "DF" and last["shape"] == [10, 10]
    assert vt._preview_used <= 600


def test_reentry_flag(vt: ValueTable) -> None:
    assert vt.in_reentry is False
    with vt.reentry():
        assert vt.in_reentry is True
        with vt.reentry():
            assert vt.in_reentry is True
        assert vt.in_reentry is True
    assert vt.in_reentry is False
    with pytest.raises(RuntimeError), vt.reentry():
        raise RuntimeError("boom")
    assert vt.in_reentry is False


def test_student_repr_errors_are_contained(vt: ValueTable) -> None:
    class Bad:
        def __repr__(self) -> str:
            raise ValueError("no")

    b = Bad()
    t = vt.token(b)
    vt.summarize(t, b)
    assert vt.values[t]["type"] == "Bad"


def build_and_summarize() -> str:
    vt = ValueTable()
    objs: list[object] = [
        small_df(),
        pd.Series([1.5, None]),
        np.arange(12).reshape(3, 4),
        sp.csr_matrix(np.eye(3)),
        LinearRegression().fit(np.arange(6.0).reshape(3, 2), np.arange(3.0)),
        [1, 2],
        {"a": object()},
        (small_df(), 1),
        {3, 1, 2},
    ]
    for o in objs:
        vt.summarize(vt.token(o), o)
    vt.summarize(vt.fresh_scalar(1), 1)
    return json.dumps(vt.values)


def test_determinism() -> None:
    assert build_and_summarize() == build_and_summarize()


@pytest.mark.no_pyodide(reason="spawns a subprocess; Pyodide has no processes")
def test_no_heavy_imports_on_bare_interpreter() -> None:
    root = str(Path(machines.values.__file__).parent.parent)
    code = (
        f"import sys; sys.path.insert(0, {root!r}); import machines.values\n"
        "bad = [m for m in ('pandas', 'numpy', 'sklearn', 'scipy') if m in sys.modules]\n"
        "assert not bad, bad\n"
    )
    r = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


# -- review fixes ----------------------------------------------------------------------------


def test_fingerprint_does_not_keep_cycles_alive(vt: ValueTable) -> None:
    log: list[str] = []

    class M:
        def run(self) -> None: ...

    class A:
        def __init__(self) -> None:
            self.m = M()
            self.cb = self.m.run  # bound method
            self.me = self
            self.kids = [self]

        def __del__(self) -> None:
            log.append("del")

    a = A()
    vt.token(a)
    vt.check(a)
    r = weakref.ref(a)
    del a
    gc.collect()
    assert log == ["del"] and r() is None


def test_cycle_through_bound_method_attribute(vt: ValueTable) -> None:
    log: list[str] = []

    class A:
        def __init__(self) -> None:
            self.cb = self.method  # self -> bound method -> self

        def method(self) -> None: ...

        def __del__(self) -> None:
            log.append("del")

    a = A()
    vt.token(a)
    del a
    gc.collect()
    assert log == ["del"]


def test_attribute_replaced_by_new_object_is_detected(vt: ValueTable) -> None:
    class Holder:
        pass

    h = Holder()
    h.arr = np.zeros(3)
    vt.token(h)
    h.arr = np.zeros(3)  # old array died, new one may reuse the address
    assert vt.check(h) is not None


def test_slots_object_mutation_detected(vt: ValueTable) -> None:
    class S:
        __slots__ = ("x", "y")

        def __init__(self) -> None:
            self.x = [1]

    s = S()
    vt.token(s)
    assert vt.check(s) is None
    s.x = [2]
    assert vt.check(s) is not None
    s.y = 1  # slot set for the first time
    assert vt.check(s) is not None


def make_node_class() -> type:
    ns: dict[str, object] = {"__name__": "__main__"}
    src = (
        "class Node:\n    def __init__(self, nxt=None):\n"
        "        self.nxt = nxt\n        self.v = 1\n"
    )
    exec(src, ns)
    return ns["Node"]  # type: ignore[return-value]


def test_machine_attrs_one_level_and_long_chain() -> None:
    node = make_node_class()

    def run() -> dict[str, dict[str, object]]:
        vt = ValueTable()
        head = None
        # Pyodide's wasm stack overflows when CPython frees a nested chain of about 3000 plain
        # objects, with no recorder involved, so the chain is shorter there.
        for _ in range(800 if sys.platform == "emscripten" else 3000):
            head = node(head)
        t = vt.token(head)
        vt.summarize(t, head)
        return vt.values

    v1, v2 = run(), run()
    assert json.dumps(v1) == json.dumps(v2)
    assert len(v1) <= 4
    top = v1["v0.0"]
    assert top["machine"] is True and set(top["attrs"]) == {"nxt", "v"}  # type: ignore[call-overload]
    child = v1[top["attrs"]["nxt"]]  # type: ignore[index]
    assert "attrs" not in child and child["machine"] is True


def test_attr_cap_is_sorted_and_deterministic() -> None:
    ns: dict[str, object] = {"__name__": "__main__"}
    body = "".join(f"        self.a{i:03d} = {i}\n" for i in range(100))
    exec("class W:\n    def __init__(self):\n" + body, ns)
    vt = ValueTable()
    w = ns["W"]()  # type: ignore[operator]
    t = vt.token(w)
    vt.summarize(t, w)
    assert list(vt.values[t]["attrs"]) == [f"a{i:03d}" for i in range(64)]


def test_base_exception_in_repr_propagates_with_minimal_entry(vt: ValueTable) -> None:
    class Boom:
        def __repr__(self) -> str:
            raise KeyboardInterrupt

    b = Boom()
    t = vt.token(b)
    with pytest.raises(KeyboardInterrupt):
        vt.summarize(t, b)
    assert vt.values[t] == {"type": "Boom"}


def test_address_stripping_only_in_angle_reprs(vt: ValueTable) -> None:
    class R2:
        def __repr__(self) -> str:
            return "<R2 id 0x7f00bb>"

    r = R2()
    t = vt.token(r)
    vt.summarize(t, r)
    assert vt.values[t]["repr"] == "<R2 id>"
    vt.summarize("s0", "at 0x1f is a string")
    assert vt.values["s0"]["repr"] == "'at 0x1f is a string'"
    df = pd.DataFrame({"a": ["at 0x1f <x 0x2>"]})
    t = vt.token(df)
    vt.summarize(t, df)
    assert vt.values[t]["preview"]["rows"][0][0] == "at 0x1f <x 0x2>"


def test_numpy_scalar_type_is_class_name(vt: ValueTable) -> None:
    vt.summarize("s0", np.float64(2.5))
    assert vt.values["s0"] == {"type": "float64", "repr": "2.5"}


def test_seen_reports_whether_an_object_has_a_token(vt: ValueTable) -> None:
    a = [1, 2]
    assert not vt.seen(a)
    vt.token(a)
    assert vt.seen(a)
    assert not vt.seen([1, 2])


def test_timing_values_have_a_stable_repr(vt: ValueTable) -> None:
    from machines.values import TIMING_REPR

    d = {"mean_fit_time": [0.123456]}
    vt.summarize("v1.0", d)
    r = vt.take_new_summaries()["v1.0"]["repr"]  # clipped to 40 characters
    assert r.startswith("{'mean_fit_time': <varies") and "0.123456" not in r
    assert TIMING_REPR.startswith("<varies")
    assert d["mean_fit_time"] == [0.123456]  # the program's dict is untouched
    vt.summarize("v2.0", {"a": 1})
    assert vt.take_new_summaries()["v2.0"]["repr"] == "{'a': 1}"


def test_methods_listed_once_per_class_and_deterministic() -> None:
    def run() -> dict[str, dict[str, object]]:
        vt = ValueTable()
        a, b = LinearRegression(), LinearRegression()
        for o in (a, b):
            vt.summarize(vt.token(o), o)
        return vt.values

    v1, v2 = run(), run()
    assert json.dumps(v1) == json.dumps(v2)
    with_methods = [v for v in v1.values() if "methods" in v]
    assert len(with_methods) == 1  # cached per class: the second instance has none
    ms = with_methods[0]["methods"]
    names = [m["name"] for m in ms]  # type: ignore[attr-defined]
    assert names == sorted(names) and len(names) <= 40
    assert {"fit", "predict", "score", "get_params", "set_params"} <= set(names)
    docs = {m["name"]: m["doc"] for m in ms}  # type: ignore[attr-defined]
    assert docs["fit"] and "\n" not in docs["fit"] and len(docs["fit"]) <= 80
    assert not any(n.startswith("_") for n in names)


def test_methods_run_no_student_code() -> None:
    ns: dict[str, object] = {"__name__": "__main__"}
    src = '''
calls = []
class D:
    def __get__(self, o, t=None):
        calls.append('get')
        raise RuntimeError('boom')
class M:
    d = D()
    @property
    def p(self):
        calls.append('prop')
        raise RuntimeError('boom')
    def __getattr__(self, n):
        calls.append('getattr')
        raise RuntimeError('boom')
    def zed(self):
        """
           Last one.
        more"""
    def alpha(self): pass
    @staticmethod
    def st(): "Static."
    @classmethod
    def cm(cls): "Class."
    def _private(self): pass
class Sub(M):
    def alpha(self): "Over."
    p = 3
'''
    exec(src, ns)
    vt = ValueTable()
    obj = ns["Sub"]()  # type: ignore[operator]
    vt.summarize(vt.token(obj), obj)
    assert ns["calls"] == []
    s = vt.values["v0.0"]
    assert s["methods"] == [
        {"name": "alpha", "doc": "Over."},
        {"name": "cm", "doc": "Class."},
        {"name": "st", "doc": "Static."},
        {"name": "zed", "doc": "Last one."},
    ]


def test_methods_cap() -> None:
    ns: dict[str, object] = {"__name__": "__main__"}
    exec("class Big:\n" + "".join(f"    def m{i:03d}(self): pass\n" for i in range(100)), ns)
    vt = ValueTable()
    obj = ns["Big"]()  # type: ignore[operator]
    vt.summarize(vt.token(obj), obj)
    names = [m["name"] for m in vt.values["v0.0"]["methods"]]  # type: ignore[attr-defined]
    assert len(names) == 40 and names == sorted(names)


def test_lazy_pandas_cache_is_not_a_change(vt: ValueTable) -> None:
    df = pd.DataFrame({"a": [1, 2, 1], "p": [1.0, 2.0, 3.0]})
    objs = [
        df.groupby("a"),
        df.groupby("a")["p"],
        df["p"].rolling(2),
        df.set_index(pd.date_range("2020", periods=3)).resample("D"),
    ]
    for o in objs:
        vt.token(o)
        assert vt.check(o) is None
        o.mean()  # first evaluation fills pandas' internal `_cache`
        assert vt.check(o) is None, type(o).__name__


def test_cache_attribute_on_other_objects_still_counts(vt: ValueTable) -> None:
    class Box:
        pass

    b = Box()
    vt.token(b)
    b._cache = [1]  # type: ignore[attr-defined]
    assert changed(vt, b)


def test_real_change_to_groupby_still_counts(vt: ValueTable) -> None:
    df = pd.DataFrame({"a": [1, 2, 1], "p": [1.0, 2.0, 3.0]})
    g = df.groupby("a")
    vt.token(g)
    g.foo = 1  # type: ignore[attr-defined]
    assert changed(vt, g)
