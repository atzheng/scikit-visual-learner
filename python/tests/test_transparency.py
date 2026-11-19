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
import warnings
from collections.abc import Callable, Iterator
from dataclasses import dataclass
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
TIMING_ATTRS = frozenset({"refit_time_", "cv_results_"})  # final values: skip wall clock


@pytest.fixture(scope="module")
def env() -> Iterator[None]:
    with gf.fixture_env():
        yield


def describe(v: Any, depth: int = 0) -> Any:
    """A comparable, address-free description of a final value."""
    if depth > 6:
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
        raw = repr(v.tolist()).encode() if v.dtype == object else v.tobytes()  # no pointers
        return ("ndarray", v.shape, str(v.dtype), hashlib.sha256(raw).hexdigest())
    if sp.issparse(v):
        m = v.tocsr()
        return ("sparse", m.shape, m.nnz, hashlib.sha256(m.data.tobytes()).hexdigest())
    if isinstance(v, np.generic):
        return (type(v).__name__, repr(v))
    if isinstance(v, BaseEstimator):
        fitted = sorted(a for a in vars(v) if a.endswith("_") and not a.startswith("_"))
        # fitted arrays and scalars by value (coef_, intercept_, ...); wall-clock attributes skipped
        values = [
            (a, describe(getattr(v, a), depth + 1))
            for a in fitted
            if a not in TIMING_ATTRS
            and isinstance(getattr(v, a), (np.ndarray, np.generic, int, float, str, bool))
        ]
        return ("estimator", type(v).__name__, repr(v.get_params(deep=False)), fitted, values)
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


@dataclass
class Outcome:
    ns: dict[str, Any]
    stdout: str
    stderr: str
    warnings: list[tuple[str, str]]  # (category, message), in order
    err: tuple[str, str] | None


def run_plain(source: str, config: dict[str, Any] | None = None) -> Outcome:
    ns: dict[str, Any] = {"__name__": "__main__", "__file__": "<student>"}
    out, errbuf = io.StringIO(), io.StringIO()
    err: tuple[str, str] | None = None
    with (
        contextlib.redirect_stdout(out),
        contextlib.redirect_stderr(errbuf),
        warnings.catch_warnings(record=True) as caught,
    ):
        try:
            exec(compile(source, "<student>", "exec"), ns)
        except SystemExit as e:
            if e.code is not None and not isinstance(e.code, int):
                errbuf.write(f"{e.code}\n")
        except SyntaxError as e:
            err = ("SyntaxError", e.msg)
        except Exception as e:  # noqa: BLE001
            err = (type(e).__name__, str(e))
    warns = [(w.category.__name__, str(w.message)) for w in caught]
    return Outcome(ns, out.getvalue(), errbuf.getvalue(), warns, err)


def run_instrumented(source: str, config: dict[str, Any] | None = None) -> Outcome:
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
        runtime.run(source, config or {}, msgs.append)
    finally:
        runtime.Recorder = saved  # type: ignore[misc]
    done = msgs[-1]
    assert done["type"] == "done"
    entries = [o for m in msgs if m["type"] == "batch" for o in m["output"]]

    def text(stream: str) -> str:
        return "".join(o["text"] for o in entries if o["stream"] == stream)

    warns = []
    for o in entries:
        if o["stream"] == "warning":
            _line, category, message = o["text"].split(": ", 2)
            warns.append((category, message))
    err = (done["error"]["type"], done["error"]["message"]) if done["error"] else None
    return Outcome(
        (held[0].namespace if held else None) or {}, text("stdout"), text("stderr"), warns, err
    )


@pytest.mark.parametrize("name", PARAMS)
def test_plain_and_instrumented_agree(name: str, env: None) -> None:
    source, config = gf.source_of(name), gf.CONFIGS.get(name, {})
    plain, inst = run_plain(source, config), run_instrumented(source, config)
    assert inst.stdout == plain.stdout
    if name in INPUT_DIFFERS:
        # the exception differs by contract: plain input() raises EOFError on closed stdin
        assert plain.stdout == "Your name? "
        assert plain.err == ("EOFError", "EOF when reading a line")
        assert inst.err == ("RuntimeError", "input() is not supported here")
    else:
        assert inst.err == plain.err
    assert inst.stderr == plain.stderr
    if name == "edge_mpl":
        # plain `plt.show()` under Agg warns that the canvas is non-interactive; the runtime's
        # patched `show` captures the figure instead (CONTRACTS section 6), so no warning
        assert [c for c, _ in plain.warnings] == ["UserWarning"] and inst.warnings == []
    else:
        assert inst.warnings == plain.warnings
    assert describe_ns(inst.ns) == describe_ns(plain.ns)
    assert set(describe_ns(plain.ns)) == {k for k in plain.ns if not k.startswith("__")}


def test_warnings_are_compared_and_present(env: None) -> None:
    source = gf.source_of("edge_warning")
    plain, inst = run_plain(source), run_instrumented(source)
    assert [c for c, _ in plain.warnings] == ["FutureWarning", "ConvergenceWarning"]
    assert inst.warnings == plain.warnings


@pytest.mark.parametrize(
    "source",
    ["import sys\nprint('a')\nsys.exit('bye')\n", "exit(3)\n", "import sys\nsys.exit(None)\n"],
)
def test_system_exit_stdout_and_stderr(source: str, env: None) -> None:
    plain, inst = run_plain(source), run_instrumented(source)
    assert (inst.stdout, inst.stderr, inst.err) == (plain.stdout, plain.stderr, plain.err)
    assert plain.err is None


def test_expected_outcomes_of_the_failing_programs(env: None) -> None:
    """Guard against both sides failing for the wrong reason."""
    assert run_plain(gf.source_of("edge_error")).err[0] == "ValueError"  # type: ignore[index]
    assert run_plain(gf.source_of("edge_syntax")).err[0] == "SyntaxError"  # type: ignore[index]
    assert run_plain(gf.source_of("golden_linreg")).err is None
    assert run_plain(gf.source_of("golden_linreg")).stdout == "95 0.416\n"
