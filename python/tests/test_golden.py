"""Golden logs and streams (CONTRACTS.md section 9) and per-fixture properties.

Every fixtures/programs/<name>.py is re-recorded and compared with the checked-in
fixtures/logs/<name>.json and fixtures/streams/<name>.jsonl (regenerate with `pnpm fixtures`).
Then each edge-case row's own claim (the header comment of the program) is asserted on the log.

Re-recording happens in this process (cwd fixtures/data, Agg backend, stdin closed, flush forced
as in the generator). The three golden programs run in the default suite; the others, which take
about half a minute together, and `heavy`, which takes ten seconds alone, run under `-m slow`.
"""

from __future__ import annotations

import difflib
import json
from collections.abc import Iterator
from typing import Any

import pytest
from test_recorder import assemble

from machines.tools import gen_fixtures as gf

GOLDEN = ["golden_split", "golden_onehot", "golden_linreg"]
NAMES = gf.program_names()


@pytest.fixture(scope="module")
def env() -> Iterator[None]:
    with gf.fixture_env():
        yield


_cache: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] = {}


def recorded(name: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if name not in _cache:
        _cache[name] = (gf.record_fixture(name), gf.run_fixture(name))
    return _cache[name]


def checked_in_log(name: str) -> dict[str, Any]:
    return json.loads((gf.LOGS / f"{name}.json").read_text())


def checked_in_stream(name: str) -> list[dict[str, Any]]:
    return [json.loads(ln) for ln in (gf.STREAMS / f"{name}.jsonl").read_text().splitlines()]


def readable_diff(expected: str, actual: str, name: str) -> str:
    lines = difflib.unified_diff(
        expected.splitlines(),
        actual.splitlines(),
        f"fixtures/{name} (checked in)",
        f"{name} (re-recorded)",
        lineterm="",
        n=2,
    )
    out = list(lines)
    return "\n".join(out[:80] + (["... (diff truncated)"] if len(out) > 80 else []))


def marks(name: str) -> list[Any]:
    return [] if name in GOLDEN else [pytest.mark.slow]


PARAMS = [pytest.param(n, marks=marks(n), id=n) for n in NAMES]


# -- the checked-in files are what the recorder produces -------------------------------------------


@pytest.mark.parametrize("name", PARAMS)
def test_log_matches_golden(name: str, env: None) -> None:
    log, _ = recorded(name)
    expected = (gf.LOGS / f"{name}.json").read_text()
    actual = gf.dumps_log(log)
    assert actual == expected, "run `pnpm fixtures` if intended\n" + readable_diff(
        expected, actual, f"logs/{name}.json"
    )


@pytest.mark.parametrize("name", PARAMS)
def test_stream_matches_golden(name: str, env: None) -> None:
    _, stream = recorded(name)
    expected = (gf.STREAMS / f"{name}.jsonl").read_text()
    actual = gf.dumps_stream(stream)
    assert actual == expected, "run `pnpm fixtures` if intended\n" + readable_diff(
        expected, actual, f"streams/{name}.jsonl"
    )


@pytest.mark.parametrize("name", PARAMS)
def test_stream_shape_and_assembles_to_log(name: str) -> None:
    """Checked-in files only (no re-run): `started` first, `done` last, and the batches add up."""
    log, stream = checked_in_log(name), checked_in_stream(name)
    assert stream[0]["type"] == "started" and stream[0]["sites"] == log["sites"]
    assert stream[-1] == {"type": "done", "status": log["status"], "error": log["error"]}
    batches = [m for m in stream if m["type"] == "batch"]
    assert [m["type"] for m in stream[1:-1]] == ["batch"] * len(batches)
    assert all("runId" not in m for m in stream)
    a = assemble(batches, log["sites"])
    assert a["events"] == log["events"]
    assert a["values"] == log["values"]
    assert a["bindings"] == log["scopes"][0]["bindings"]
    assert a["output"] == log["output"]
    assert a["diagnostics"] == log["diagnostics"]
    # a stream that is flushed at every change has stubs for calls still open
    if len(log["events"]) > 1:
        assert any(m["open"] for m in batches)


@pytest.mark.parametrize("name", PARAMS)
def test_log_invariants(name: str) -> None:
    log = checked_in_log(name)
    assert log["version"] == 2 and log["diagnostics"] == []
    ids = [e["i"] for e in log["events"]]
    assert ids == sorted(set(ids))
    values = log["values"]
    for e in log["events"]:
        toks = e["outputs"] + [x for pair in e["mutates"] for x in pair]
        toks += [i["value"] for i in e["inputs"] if "value" in i]
        toks += [e["owner"]] if e["owner"] else []
        assert all(t in values for t in toks), (name, e["i"])
        assert not e["returns_self"] or e["outputs"] == []
    for _, _, tok in log["scopes"][0]["bindings"]:
        assert tok in values
    text = json.dumps({**log, "output": [o for o in log["output"] if o["stream"] != "figure"]})
    assert " at 0x" not in text  # no memory addresses


# -- helpers for the property tests ----------------------------------------------------------------


def events_named(log: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [e for e in log["events"] if e["name"] == name]


def one(log: dict[str, Any], name: str) -> dict[str, Any]:
    found = events_named(log, name)
    assert len(found) == 1, [e["name"] for e in log["events"]]
    return found[0]


def bound(log: dict[str, Any]) -> dict[str, str]:
    return {n: t for _, n, t in log["scopes"][0]["bindings"]}  # the last binding of each name


def inp(ev: dict[str, Any], param: str) -> dict[str, Any]:
    found = [i for i in ev["inputs"] if i["param"] == param]
    assert len(found) == 1, (param, [i["param"] for i in ev["inputs"]])
    return found[0]


def obj(token: str) -> str:
    """The object part of a reference token: v12.1 -> v12."""
    return token.split(".")[0]


def is_scalar(token: str) -> bool:
    return token.startswith("s")


def names(log: dict[str, Any]) -> list[str]:
    return [e["name"] for e in log["events"]]


def line_of(log: dict[str, Any], ev: dict[str, Any]) -> int:
    return int(log["sites"][ev["site"]]["line"])


# -- golden examples (what the slides show) --------------------------------------------------------


def test_golden_split() -> None:
    log = checked_in_log("golden_split")
    split = one(log, "train_test_split")
    assert len(split["outputs"]) == 4
    b = bound(log)
    assert [b[n] for n in ("X_train", "X_test", "y_train", "y_test")] == split["outputs"]
    assert inp(split, "arrays[0]")["value"] == b["X"] and inp(split, "arrays[1]")["value"] == b["y"]
    assert inp(split, "test_size")["text"] == "0.2"
    # X_train and X_test never wired to each other: nothing consumes either of them
    assert not any(
        i.get("value") in (b["X_train"], b["X_test"]) for e in log["events"] for i in e["inputs"]
    )
    assert len(set(split["outputs"])) == 4
    assert log["output"][0]["text"] == "(376, 4) (95, 4)\n"


def test_golden_onehot() -> None:
    log = checked_in_log("golden_onehot")
    b = bound(log)
    ctor, fit = one(log, "OneHotEncoder"), one(log, "OneHotEncoder.fit")
    transforms = events_named(log, "OneHotEncoder.transform")
    assert len(transforms) == 2
    assert fit["returns_self"] and fit["outputs"] == []
    assert obj(fit["owner"]) == obj(ctor["outputs"][0]) == obj(b["enc"])
    assert fit["mutates"] == [[ctor["outputs"][0], transforms[0]["owner"]]]
    assert transforms[0]["owner"] == transforms[1]["owner"]  # both use the fitted version
    assert inp(fit, "X")["value"] == b["X_train"]
    assert inp(transforms[0], "X")["value"] == b["X_train"]
    assert inp(transforms[1], "X")["value"] == b["X_test"]
    assert log["values"][b["train_enc"]]["type"] == "sparse"
    assert log["values"][b["test_enc"]]["type"] == "sparse"
    assert b["train_enc"] != b["test_enc"]
    # train and test are never wired together
    assert not any(
        {i.get("value") for i in e["inputs"]} >= {b["X_train"], b["X_test"]} for e in log["events"]
    )


def test_golden_linreg() -> None:
    log = checked_in_log("golden_linreg")
    b = bound(log)
    ctor, fit = one(log, "LinearRegression"), one(log, "LinearRegression.fit")
    pred, score = one(log, "LinearRegression.predict"), one(log, "LinearRegression.score")
    assert fit["returns_self"] and fit["outputs"] == []
    assert [i["param"] for i in fit["inputs"]] == ["X", "y"]  # X_train and y_train only
    assert inp(fit, "X")["value"] == b["X_train"] and inp(fit, "y")["value"] == b["y_train"]
    assert fit["owner"] == ctor["outputs"][0]
    assert fit["mutates"][0][0] == ctor["outputs"][0]
    after = fit["mutates"][0][1]
    assert pred["owner"] == score["owner"] == after
    assert inp(pred, "X")["value"] == b["X_test"]
    assert inp(score, "X")["value"] == b["X_test"] and inp(score, "y")["value"] == b["y_test"]
    assert b["pred"] == pred["outputs"][0] and b["r2"] == score["outputs"][0]
    assert {"coef_", "intercept_"} <= set(log["values"][after]["attrs"])
    assert "coef_" not in log["values"][ctor["outputs"][0]]["attrs"]  # unfitted before


# -- edge cases: the claim in each program's header comment ----------------------------------------


def test_edge_literals_never_wired() -> None:
    log = checked_in_log("edge_literals")
    # no scalar token is ever the input of an event: nothing here consumes one
    assert not any(
        is_scalar(i["value"]) for e in log["events"] for i in e["inputs"] if "value" in i
    )
    produced = [t for e in log["events"] for t in e["outputs"]]
    assert len(produced) == len(set(produced))  # no token is the output of two events
    b = bound(log)
    for pair in (("n1", "n2"), ("t1", "t2"), ("f1", "f2")):
        assert b[pair[0]] != b[pair[1]]  # equal (or identical) values, separate tokens
    assert len({b[n] for n in ("n1", "n2", "t1", "t2", "f1", "f2", "x", "y")}) == 8
    # a and b hold equal arrays but are different objects
    assert obj(b["a"]) != obj(b["b"])
    # the arrays feed their own calls only
    assert {i["value"] for i in one_of(log, 2)["inputs"]} == {b["a"]}
    assert {i["value"] for i in one_of(log, 3)["inputs"]} == {b["b"]}


def one_of(log: dict[str, Any], i: int) -> dict[str, Any]:
    return next(e for e in log["events"] if e["i"] == i)


def test_edge_gridsearch_original_unfitted() -> None:
    log = checked_in_log("edge_gridsearch")
    base = bound(log)["base"]
    assert base.endswith(".0")
    assert not any(obj(t) == obj(base) and not t.endswith(".0") for t in log["values"])
    assert all(obj(a) != obj(base) for e in log["events"] for a, _ in e["mutates"])
    assert names(log).count("GridSearchCV.fit") == 1  # the clones' fits are not drawn
    assert not any("Ridge." in n for n in names(log))
    ctor = one(log, "GridSearchCV")
    assert inp(ctor, "estimator")["value"] == base
    assert "coef_" not in log["values"][base]["attrs"]
    assert log["output"][0]["text"].endswith("False\n")  # hasattr(base, "coef_")


def test_edge_fit_chain_predict_on_same_model() -> None:
    log = checked_in_log("edge_fit_chain")
    fit, pred = one(log, "LinearRegression.fit"), one(log, "LinearRegression.predict")
    assert fit["returns_self"] and fit["outputs"] == []
    assert pred["owner"] == fit["mutates"][0][1]
    assert pred["i"] == fit["i"] + 1


def test_edge_df_chain_intermediate_is_unlabelled_wire() -> None:
    log = checked_in_log("edge_df_chain")
    dropna, reset = one(log, "DataFrame.dropna"), one(log, "DataFrame.reset_index")
    assert reset["owner"] == dropna["outputs"][0]
    assert inp(reset, "self")["value"] == dropna["outputs"][0]
    assert dropna["outputs"][0] not in bound(log).values()  # no name on it


def test_edge_nested_inner_output_wires_to_outer_call() -> None:
    log = checked_in_log("edge_nested")
    head = events_named(log, "DataFrame.head")[0]
    describe = one(log, "NDFrame.describe")
    s = inp(describe, "self")
    assert s["origin"] == "call" and s["value"] == head["outputs"][0]
    assert head["outputs"][0] not in bound(log).values()


def test_edge_expr_nodes_and_their_reads() -> None:
    log = checked_in_log("edge_expr")
    b = bound(log)
    sub = one(log, "X_train - mean")
    assert sub["kind"] == "expr" and sub["module"] is None
    assert {i["param"]: i["value"] for i in sub["inputs"]} == {
        "X_train": b["X_train"],
        "mean": b["mean"],
    }
    assert sub["outputs"] == [b["centred"]]
    assert one(log, 'df["price"]')["kind"] == "expr"
    # `coefs = model.coef_`: the value already has a token (an attribute of the fitted model), so
    # the contract gives no expr event for it; the bind refers to that attribute's token.
    fitted = one(log, "LinearRegression.fit")["mutates"][0][1]
    assert b["coefs"] == log["values"][fitted]["attrs"]["coef_"]


def test_edge_store_two_store_events_new_versions() -> None:
    log = checked_in_log("edge_store")
    stores = [e for e in log["events"] if e["kind"] == "store"]
    assert len(stores) == 2
    first, second = stores
    assert inp(first, "target")["value"].endswith(".0") and first["outputs"][0].endswith(".1")
    assert inp(second, "target")["value"] == first["outputs"][0]
    assert second["outputs"][0].endswith(".2")
    assert len({obj(t) for e in stores for t in e["outputs"] + [inp(e, "target")["value"]]}) == 1
    assert inp(second, "value")["text"] == "0"


def test_edge_loop_cap_and_slot() -> None:
    log = checked_in_log("edge_loop")
    by_key: dict[str, list[dict[str, Any]]] = {}
    for e in log["events"]:
        by_key.setdefault(e["merge_key"], []).append(e)
    loop_keys = [k for k, v in by_key.items() if len(v) > 1]
    assert len(loop_keys) == 4  # alpha expression, Ridge(), fit, score
    for k in loop_keys:
        evs = by_key[k]
        assert [e["count"] for e in evs] == list(range(1, 21)) + [30]
        assert [bool(e.get("slot")) for e in evs] == [False] * 20 + [True]
    assert log["output"][0]["text"] == "0.4165\n"


def test_edge_dict_models_owner_by_identity() -> None:
    log = checked_in_log("edge_dict_models")
    rf = one(log, "RandomForestRegressor")["outputs"][0]
    ridge = one(log, "Ridge")["outputs"][0]
    fit = one(log, "RandomForestRegressor.fit")
    assert obj(fit["owner"]) == obj(rf) != obj(ridge)
    assert not any(e["name"].startswith("Ridge.") for e in log["events"])
    assert obj(one(log, "RandomForestRegressor.score")["owner"]) == obj(rf)


def test_edge_reserved_all_recorded_and_run_ok() -> None:
    log = checked_in_log("edge_reserved")
    assert log["status"] == "ok"
    show = one(log, "show")
    assert show["kind"] == "student_function"
    assert [i["param"] for i in show["inputs"]] == ["args[0]", "site", "fn"]
    assign = one(log, "DataFrame.assign")
    assert [i["param"] for i in assign["inputs"]] == ["self", "site", "fn"]
    # the shadowing print is the student's function, so it is a box, and prints through builtins
    assert all(e["kind"] == "student_function" for e in events_named(log, "print"))
    assert log["output"][0]["text"] == "[shadowed] ('a', 'b', 1)\n"


def test_edge_repr_calls_inside_repr_and_property_not_recorded() -> None:
    log = checked_in_log("edge_repr")
    assert names(log) == ["read_csv", "Table"]
    assert log["output"][0]["text"].startswith("Table(rows=500")


def test_edge_generator_bodies_are_opaque() -> None:
    log = checked_in_log("edge_generator")
    assert names(log)[:1] == ["read_csv"]
    assert [e["kind"] for e in log["events"] if e["name"] in ("chunks", "total_price")] == [
        "student_function",
        "student_function",
    ]
    assert not any(e["name"] in ("DataFrame.iloc", "Series.sum") for e in log["events"])
    assert log["status"] == "ok"


def test_edge_nosig_every_input_has_a_label() -> None:
    # numpy 2.x ufuncs carry a readable signature, so labels are x, x1, x2 rather than arg0, arg1
    # (the arg0 fallback is covered by test_recorder.test_ufunc_labels_arg0).
    log = checked_in_log("edge_nosig")
    add = one(log, "add")
    assert [i["param"] for i in add["inputs"]] == ["x1", "x2"]
    assert all(i["param"] for e in log["events"] for i in e["inputs"])
    maximum = one(log, "maximum")
    assert inp(maximum, "x2") == {"param": "x2", "origin": "const", "text": "1000"}


def test_edge_inplace_new_version_same_object() -> None:
    log = checked_in_log("edge_inplace")
    dropna, sort = one(log, "DataFrame.dropna"), one(log, "DataFrame.sort_values")
    assert dropna["outputs"] == [] and sort["outputs"] == []
    (a, b), (c, d) = dropna["mutates"][0], sort["mutates"][0]
    assert (a, b, c, d) == ("v0.0", "v0.1", "v0.1", "v0.2")
    assert sort["owner"] == b


def test_edge_input_is_an_error() -> None:
    log = checked_in_log("edge_input")
    assert log["status"] == "error" and log["events"] == []
    assert log["error"]["type"] == "RuntimeError"
    assert log["error"]["message"] == "input() is not supported here"
    assert log["error"]["line"] == 4 and log["output"] == []


def test_edge_error_fit_raises() -> None:
    log = checked_in_log("edge_error")
    assert log["status"] == "error" and log["error"]["type"] == "ValueError"
    fit = one(log, "LinearRegression.fit")
    assert fit["error"]["type"] == "ValueError" and fit["error"]["handled"] is False
    assert fit["i"] == log["events"][-1]["i"]
    assert log["error"]["line"] == line_of(log, fit)
    frames = log["error"]["traceback"]
    assert frames[-1]["kind"] == "library"  # the ValueError is raised inside sklearn, folded
    assert [f for f in frames if f["kind"] == "student"][-1]["line"] == log["error"]["line"]
    assert [o["text"] for o in log["output"]] == ["fitting\n"]  # output before the error is kept


def test_edge_handled_error_recorded_and_run_continues() -> None:
    log = checked_in_log("edge_handled")
    assert log["status"] == "ok" and log["error"] is None
    fits = events_named(log, "LinearRegression.fit")
    assert len(fits) == 2
    assert fits[0]["error"]["handled"] is True and fits[1]["error"] is None
    assert one(log, "LinearRegression.score")["error"] is None


def test_edge_warning_goes_to_the_warning_stream_with_student_line() -> None:
    log = checked_in_log("edge_warning")
    warns = [o for o in log["output"] if o["stream"] == "warning"]
    assert [w["text"].split(": ")[1] for w in warns] == ["FutureWarning", "ConvergenceWarning"]
    src = (gf.PROGRAMS / "edge_warning.py").read_text().splitlines()
    for w in warns:
        line = int(w["text"].split(":")[0])
        assert "warn(" in src[line - 1] or "fit(" in src[line - 1]
    assert [o["text"] for o in log["output"] if o["stream"] == "stdout"] == ["done\n"]


def test_edge_syntax_nothing_runs() -> None:
    log = checked_in_log("edge_syntax")
    assert log["status"] == "error" and log["sites"] == [] and log["events"] == []
    assert log["error"]["type"] == "SyntaxError" and log["error"]["line"] == 5
    assert [f["kind"] for f in log["error"]["traceback"]] == ["student"]
    assert checked_in_stream("edge_syntax")[0] == {"type": "started", "sites": []}


def test_edge_mpl_plot_show_and_figure() -> None:
    log = checked_in_log("edge_mpl")
    assert [e["name"] for e in log["events"] if e["kind"] != "expr"][-2:] == ["plot", "show"]
    figs = [o for o in log["output"] if o["stream"] == "figure"]
    assert len(figs) == 1 and figs[0]["i"] == one(log, "show")["i"]
    assert figs[0]["png"] and figs[0]["width"] > 0
    assert not any(o["stream"] == "stdout" for o in log["output"])


def test_edge_student_fn_opaque_boxes() -> None:
    log = checked_in_log("edge_student_fn")
    assert names(log) == ["load", "Pipeline", "Pipeline.run"]
    assert events_named(log, "load")[0]["kind"] == "student_function"
    assert len(events_named(log, "load")[0]["outputs"]) == 2
    run = one(log, "Pipeline.run")
    assert run["kind"] == "method" and run["owner"] == one(log, "Pipeline")["outputs"][0]


def test_heavy_only_students_own_calls_are_boxes() -> None:
    log = checked_in_log("heavy")
    assert names(log) == [
        "read_csv",
        "DataFrame.dropna",
        'df[["beds", "baths", "sqft", "year_built", "neighbourhood", "room_type"]]',
        "get_dummies",
        'df["price"]',
        "train_test_split",
        "RandomForestRegressor",
        "GridSearchCV",
        "GridSearchCV.fit",
        "GridSearchCV.score",
    ]
    assert log["status"] == "ok"


def test_timing_normalisation_covers_the_only_nondeterminism() -> None:
    for name in ("edge_gridsearch", "heavy"):
        reprs = [v["repr"] for v in checked_in_log(name)["values"].values() if "repr" in v]
        assert gf.TIMING_REPR in reprs


def test_caught_error_is_corrected_in_the_stream(env: None) -> None:
    """Regression: an event streamed with `handled: false` is re-sent once the run shows the
    exception was caught, so the assembled log (and the live view) agree with `record()`."""
    stream = gf.run_fixture("edge_handled")
    sent = [e for m in stream if m["type"] == "batch" for e in m["events"] if e["error"]]
    assert [e["error"]["handled"] for e in sent] == [False, True]  # same event i, twice
    assert sent[0]["i"] == sent[1]["i"]
    log = gf.record_fixture("edge_handled")
    a = assemble([m for m in stream if m["type"] == "batch"], log["sites"])
    assert a["events"] == log["events"]
