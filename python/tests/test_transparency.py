"""Transparency: instrumented code behaves exactly like plain Python (SPEC "Testing").

Each fixture program runs twice in this process: plain (`compile` + `exec`, no recorder) and
through `machines.runtime.run`. They must give the same stdout, the same exception type and
message, and the same final namespace (scalars by repr, arrays and frames by shape and hash,
estimators by `get_params` and fitted attribute names).

Known, documented difference: `input()` raises `RuntimeError("input() is not supported here")`
under the runtime but `EOFError` in plain Python with stdin closed (CONTRACTS section 6).
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import types
from collections.abc import Callable, Iterator
from typing import Any

import numpy as np
import pandas as pd
import pytest
import scipy.sparse as sp
from sklearn.base import BaseEstimator

from machines import runtime
from machines.tools import gen_fixtures as gf

NAMES = gf.program_names()
PARAMS = [
    pytest.param(n, marks=[] if n.startswith("golden") else [pytest.mark.slow], id=n) for n in NAMES
]
INPUT_DIFFERS = {"edge_input"}


@pytest.fixture(scope="module")
def env() -> Iterator[None]:
    with gf.fixture_env():
        yield


def describe(v: Any, depth: int = 0) -> Any:
    """A comparable, address-free description of a final value."""
    if depth > 3:
        return ("deep", type(v).__name__)
    if v is None or isinstance(v, (bool, int, float, complex, str, bytes)):
        return (type(v).__name__, repr(v))
    if isinstance(v, types.ModuleType):
        return ("module", v.__name__)
    if isinstance(v, type):
        return ("class", v.__qualname__)
    if isinstance(v, (types.FunctionType, types.BuiltinFunctionType)):
        return ("function", getattr(v, "__qualname__", repr(v)))
    if isinstance(v, pd.DataFrame):
        h = int(pd.util.hash_pandas_object(v, index=True).sum())
        return ("DataFrame", v.shape, list(map(str, v.columns)), h)
    if isinstance(v, pd.Series):
        h = int(pd.util.hash_pandas_object(v, index=True).sum())
        return ("Series", v.shape, str(v.dtype), h)
    if isinstance(v, np.ndarray):
        return ("ndarray", v.shape, str(v.dtype), hashlib.sha256(v.tobytes()).hexdigest())
    if sp.issparse(v):
        m = v.tocsr()
        return ("sparse", m.shape, m.nnz, hashlib.sha256(m.data.tobytes()).hexdigest())
    if isinstance(v, np.generic):
        return (type(v).__name__, repr(v))
    if isinstance(v, BaseEstimator):
        fitted = sorted(a for a in vars(v) if a.endswith("_") and not a.startswith("_"))
        return ("estimator", type(v).__name__, repr(v.get_params(deep=False)), fitted)
    if isinstance(v, (list, tuple, set, frozenset)):
        items = [describe(x, depth + 1) for x in v]
        return (
            type(v).__name__,
            items if not isinstance(v, (set, frozenset)) else sorted(map(repr, items)),
        )
    if isinstance(v, dict):
        return ("dict", [(repr(k), describe(x, depth + 1)) for k, x in v.items()])
    if hasattr(v, "__dict__") and not callable(v):
        return (
            "object",
            type(v).__qualname__,
            [(k, describe(x, depth + 1)) for k, x in vars(v).items()],
        )
    return ("other", type(v).__qualname__)


def describe_ns(ns: dict[str, Any]) -> dict[str, Any]:
    return {k: describe(v) for k, v in sorted(ns.items()) if not k.startswith("__")}


def run_plain(name: str) -> tuple[dict[str, Any], str, tuple[str, str] | None]:
    source = gf.source_of(name)
    ns: dict[str, Any] = {"__name__": "__main__", "__file__": "<student>"}
    out = io.StringIO()
    err: tuple[str, str] | None = None
    with contextlib.redirect_stdout(out):
        try:
            exec(compile(source, "<student>", "exec"), ns)
        except SyntaxError as e:
            err = ("SyntaxError", e.msg)
        except Exception as e:  # noqa: BLE001
            err = (type(e).__name__, str(e))
    return ns, out.getvalue(), err


def run_instrumented(name: str) -> tuple[dict[str, Any], str, tuple[str, str] | None]:
    """The same program through `runtime.run`, with the namespace of the run captured."""
    held: list[runtime.Recorder] = []

    class Capturing(runtime.Recorder):  # type: ignore[misc]
        def __init__(self, *a: Any, **k: Any) -> None:
            super().__init__(*a, **k)
            held.append(self)

    msgs: list[dict[str, Any]] = []
    saved: Callable[..., Any] = runtime.Recorder
    runtime.Recorder = Capturing  # type: ignore[misc,assignment]
    try:
        runtime.run(gf.source_of(name), gf.CONFIGS.get(name, {}), msgs.append)
    finally:
        runtime.Recorder = saved  # type: ignore[misc]
    done = msgs[-1]
    assert done["type"] == "done"
    stdout = "".join(
        o["text"]
        for m in msgs
        if m["type"] == "batch"
        for o in m["output"]
        if o["stream"] == "stdout"
    )
    err = None
    if done["error"]:
        err = (done["error"]["type"], done["error"]["message"])
    ns = held[0].namespace or {}
    return ns, stdout, err


@pytest.mark.parametrize("name", PARAMS)
def test_plain_and_instrumented_agree(name: str, env: None) -> None:
    plain_ns, plain_out, plain_err = run_plain(name)
    inst_ns, inst_out, inst_err = run_instrumented(name)
    if name not in INPUT_DIFFERS:
        assert inst_out == plain_out
    if name in INPUT_DIFFERS:
        # plain input() writes its prompt before hitting EOF; the runtime raises without writing it
        assert plain_out == "Your name? " and inst_out == ""
        assert plain_err == ("EOFError", "EOF when reading a line")
        assert inst_err == ("RuntimeError", "input() is not supported here")
    else:
        assert inst_err == plain_err
    assert describe_ns(inst_ns) == describe_ns(plain_ns)
    assert set(describe_ns(plain_ns)) == {k for k in plain_ns if not k.startswith("__")}


def test_expected_outcomes_of_the_failing_programs(env: None) -> None:
    """Guard against both sides failing for the wrong reason."""
    assert run_plain("edge_error")[2][0] == "ValueError"  # type: ignore[index]
    assert run_plain("edge_syntax")[2] is not None
    assert run_plain("golden_linreg")[2] is None
    assert run_plain("golden_linreg")[1] == "95 0.416\n"
