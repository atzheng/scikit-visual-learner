"""run(): exception safety of setup/teardown, recursion folding, SystemExit, stream, __file__."""

from __future__ import annotations

import builtins
import json
import os
import subprocess
import sys
import warnings
from typing import Any

import pytest

from machines import record, run, runtime
from machines.mpl import MplHook
from machines.recorder import Recorder


def plain(source: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", source],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
    )


def _snapshot() -> tuple[Any, ...]:
    return (
        sys.stdout,
        sys.stderr,
        builtins.input,
        sys.getrecursionlimit(),
        sys.modules["__main__"],
        warnings.showwarning,
        list(warnings.filters),
        os.environ.get("MPLBACKEND"),
        sys.meta_path[:],
    )


@pytest.mark.parametrize("where", ["mpl_install", "rec_install", "rec_uninstall", "mpl_uninstall"])
@pytest.mark.parametrize("error", [KeyboardInterrupt, RuntimeError])
def test_setup_teardown_failures_restore_everything(
    monkeypatch: pytest.MonkeyPatch, where: str, error: type[BaseException]
) -> None:
    target, name = {
        "mpl_install": (MplHook, "install"),
        "mpl_uninstall": (MplHook, "uninstall"),
        "rec_install": (Recorder, "install"),
        "rec_uninstall": (Recorder, "uninstall"),
    }[where]
    orig = getattr(target, name)
    calls = {"n": 0}

    def boom(self: Any) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            if name == "uninstall":
                orig(self)  # the first attempt did its work and then raised
            raise error("boom")
        orig(self)

    monkeypatch.setattr(target, name, boom)
    before = _snapshot()
    msgs: list[dict[str, Any]] = []
    run("print('hi')\n", {}, msgs.append)
    monkeypatch.undo()
    assert _snapshot() == before
    assert msgs[-1]["type"] == "done"
    if name == "install":
        assert msgs[-1]["status"] == ("stopped" if error is KeyboardInterrupt else "error")
    # a later run is unaffected
    assert record("print('later')\n")["output"][0]["text"] == "later\n"


def test_uninstall_raising_every_time_still_restores(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(self: Any) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(MplHook, "uninstall", boom)
    before = _snapshot()
    msgs: list[dict[str, Any]] = []
    run("print('hi')\n", {}, msgs.append)
    monkeypatch.undo()
    os.environ.pop("MPLBACKEND", None)  # that hook's own state, left because uninstall always fails
    sys.meta_path[:] = before[8]
    assert msgs[-1]["status"] == "stopped"
    after = _snapshot()
    assert after[:7] == before[:7]  # everything but the mpl hook's own state


def test_late_interrupt_in_close_open(monkeypatch: pytest.MonkeyPatch) -> None:
    orig = Recorder.close_open
    n = {"c": 0}

    def close_open(self: Recorder, exc: BaseException | None) -> None:
        n["c"] += 1
        if n["c"] == 1:
            raise KeyboardInterrupt
        orig(self, exc)

    monkeypatch.setattr(Recorder, "close_open", close_open)
    before = _snapshot()
    msgs: list[dict[str, Any]] = []
    run("print('x')\n", {}, msgs.append)
    assert msgs[-1] == {"type": "done", "status": "stopped", "error": None}
    assert _snapshot() == before


def test_late_interrupt_in_done_emit() -> None:
    k = {"n": 0}
    got: list[dict[str, Any]] = []

    def emit(m: dict[str, Any]) -> None:
        if m["type"] == "done" and k["n"] == 0:
            k["n"] += 1
            raise KeyboardInterrupt
        got.append(m)

    run("print('x')\n", {}, emit)
    assert got[-1]["type"] == "done" and got[-1]["status"] == "stopped"


def test_traceback_folds_recursion_frames() -> None:
    src = "def f(n):\n    return f(n - 1) if n else 1 // n\n\nf(3)\n"
    tb = record(src)["error"]["traceback"]
    assert [(f["name"], f.get("repeat")) for f in tb] == [("<module>", None), ("f", 3)]


def test_infinite_recursion_gives_small_log() -> None:
    log = record("def f(n):\n    return f(n + 1)\nf(0)\n")
    tb = log["error"]["traceback"]
    assert [f["name"] for f in tb] == ["<module>", "f"]
    assert tb[1]["repeat"] > 500
    assert len(json.dumps(log)) < 20_000


@pytest.mark.parametrize("arg", ["'bye'", "3", "None"])
def test_sys_exit_stderr_matches_plain(arg: str) -> None:
    src = f"import sys\nprint('a')\nsys.exit({arg})\n"
    p = plain(src)
    log = record(src)
    assert log["status"] == "ok"
    out = "".join(o["text"] for o in log["output"] if o["stream"] == "stdout")
    err = "".join(o["text"] for o in log["output"] if o["stream"] == "stderr")
    assert (out, err) == (p.stdout, p.stderr)


def test_stream_attributes_and_file() -> None:
    src = (
        "import sys, io\n"
        "print(sys.stdout.name, sys.stderr.name, sys.stdout.encoding, sys.stdout.isatty())\n"
        "try:\n    sys.stdout.fileno()\nexcept io.UnsupportedOperation:\n    print('unsup')\n"
        "print(__file__)\n"
    )
    log = record(src)
    assert log["output"][0]["text"] == "<stdout> <stderr> utf-8 False\nunsup\n<student>\n"


def test_sklearn_config_reset_between_runs() -> None:
    record("import sklearn\nsklearn.set_config(transform_output='pandas')\n")
    log = record("import sklearn\nprint(sklearn.get_config()['transform_output'])\n")
    assert log["output"][0]["text"] == "default\n"


def test_after_reset_hooks_run() -> None:
    runtime.after_reset_hooks.append(
        lambda: __import__("pandas").set_option("display.max_rows", 11)
    )
    try:
        log = record("import pandas as pd\nprint(pd.get_option('display.max_rows'))\n")
        assert log["output"][0]["text"] == "11\n"
    finally:
        runtime.after_reset_hooks.clear()
        record("pass\n")
