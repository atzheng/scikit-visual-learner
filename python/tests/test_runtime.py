"""run()/record(): output tagging, warnings, errors, stop, recursion, figures, run isolation."""

from __future__ import annotations

import base64
import builtins
import json
import os
import subprocess
import sys
import warnings
from pathlib import Path
from typing import Any

import pytest

import machines
from machines import record, run
from machines.tracebacks import student_traceback

ROOT = Path(__file__).resolve().parents[2]
PROGRAMS = ROOT / "fixtures" / "programs"
DATA = ROOT / "fixtures" / "data"

CFG = {"draw_builtins": True}  # builtins on: print() and len() become events


@pytest.fixture
def in_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(DATA)


def program(name: str) -> str:
    return (PROGRAMS / f"{name}.py").read_text()


def plain(source: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", source],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        env={**os.environ, "MPLBACKEND": "Agg"},
    )


def test_exports() -> None:
    assert {"record", "run", "instrument", "Recorder"} <= set(machines.__all__)


def test_acceptance_golden_split(in_data: None) -> None:
    assert record(program("golden_split"))["status"] == "ok"


def test_print_event_tags_its_own_text() -> None:
    src = "x = len('abc')\nprint('between')\ny = len('de')\nprint('after', y)\n"
    log = record(src, CFG)
    prints = [e["i"] for e in log["events"] if e["name"] == "print"]
    assert [(o["i"], o["text"]) for o in log["output"]] == [
        (prints[0], "between\n"),
        (prints[1], "after 2\n"),
    ]


def test_print_between_calls_tagged_with_first_call() -> None:
    # print is not recorded (default config): its text belongs to the call before it
    src = (
        "import numpy as np\na = np.zeros(2)\nprint('x')\nprint('y')\nb = np.ones(2)\nprint('z')\n"
    )
    log = record(src)
    zeros = next(e["i"] for e in log["events"] if e["name"] == "zeros")
    ones = next(e["i"] for e in log["events"] if e["name"] == "ones")
    assert log["output"] == [
        {"i": zeros, "stream": "stdout", "text": "x\ny\n"},
        {"i": ones, "stream": "stdout", "text": "z\n"},
    ]


def test_output_before_any_event_and_streams_interleave() -> None:
    src = "import sys\nprint('a')\nprint('b', file=sys.stderr)\nprint('c')\n"
    log = record(src)
    assert [(o["i"], o["stream"], o["text"]) for o in log["output"]] == [
        (-1, "stdout", "a\n"),
        (-1, "stderr", "b\n"),
        (-1, "stdout", "c\n"),
    ]


def test_process_state_restored() -> None:
    out, err, inp, lim = sys.stdout, sys.stderr, builtins.input, sys.getrecursionlimit()
    main = sys.modules["__main__"]
    record("print(1)\nraise ValueError('x')\n")
    assert (sys.stdout, sys.stderr, builtins.input, sys.getrecursionlimit()) == (out, err, inp, lim)
    assert sys.modules["__main__"] is main


def test_student_stream_behaves_like_text_stream() -> None:
    src = (
        "import sys\n"
        "print(sys.stdout.write('ab'), sys.stdout.isatty(), sys.stdout.encoding)\n"
        "sys.stdout.flush()\n"
        "try:\n    sys.stdout.write(3)\nexcept TypeError as e:\n    print(e)\n"
    )
    log = record(src)
    text = "ab2 False utf-8\nwrite() argument must be str, not int\n"
    assert log["output"][0]["text"] == text
    assert plain(src).stdout == text


def test_warning_attribution_student_level() -> None:
    src = (
        "import warnings\nwarnings.simplefilter('always')\nx = 1\n"
        "warnings.warn('hey', FutureWarning)\n"
    )
    log = record(src)
    assert [o for o in log["output"] if o["stream"] == "warning"] == [
        {"i": -1, "stream": "warning", "text": "4: FutureWarning: hey"}
    ]


def test_warning_from_library_uses_student_line(in_data: None) -> None:
    log = record(program("edge_warning"))
    warns = [o["text"] for o in log["output"] if o["stream"] == "warning"]
    assert warns[0] == "11: FutureWarning: legacy API"
    assert warns[1].startswith("15: ConvergenceWarning: lbfgs failed to converge")
    assert not [o for o in log["output"] if o["stream"] == "stderr"]
    assert log["status"] == "ok"


def test_warning_filters_and_hook_restored() -> None:
    before = list(warnings.filters)
    hook = warnings.showwarning
    record("import warnings\nwarnings.simplefilter('ignore')\nwarnings.filterwarnings('error')\n")
    assert warnings.filters == before
    assert warnings.showwarning is hook


def test_warning_with_explicit_file_goes_there() -> None:
    src = (
        "import io, warnings\nbuf = io.StringIO()\n"
        "warnings.showwarning('m', UserWarning, 'f.py', 3, buf)\nprint(buf.getvalue() != '')\n"
    )
    log = record(src)
    assert [o["stream"] for o in log["output"]] == ["stdout"]  # no warning entry


def test_warning_shown_again_on_rerun() -> None:
    src = "import warnings\nwarnings.warn('once')\n"
    a = record(src)["output"]
    b = record(src)["output"]
    assert a == b and len(a) == 1


def test_input_error() -> None:
    log = record("name = input('Name? ')\nprint(name)\n")
    assert log["status"] == "error"
    assert log["error"]["type"] == "RuntimeError"
    assert log["error"]["message"] == "input() is not supported here"
    assert log["error"]["line"] == 1
    assert log["output"] == []


def test_traceback_edge_error_only_student_frames_and_one_library(in_data: None) -> None:
    log = record(program("edge_error"))
    assert log["status"] == "error"
    err = log["error"]
    assert err["type"] == "ValueError"
    tb = err["traceback"]
    assert [f["kind"] for f in tb] == ["student", "library"]
    assert tb[0] == {
        "kind": "student",
        "line": 11,
        "text": "LinearRegression().fit(X, y)",
        "name": "<module>",
    }
    assert tb[1]["count"] >= 1 and tb[1]["modules"] == ["sklearn"]
    assert err["line"] == 11
    fit = next(e for e in log["events"] if e["name"] == "LinearRegression.fit")
    assert fit["error"]["type"] == "ValueError"
    assert [o["text"] for o in log["output"]] == ["fitting\n"]


def test_traceback_student_function_frames() -> None:
    src = "def f(n):\n    return g(n)\n\ndef g(n):\n    return 1 // n\n\nf(0)\n"
    log = record(src)
    tb = log["error"]["traceback"]
    assert [(f["name"], f["line"]) for f in tb] == [("<module>", 7), ("f", 2), ("g", 5)]
    assert tb[2]["text"] == "return 1 // n"
    assert log["error"]["line"] == 5
    assert log["error"]["type"] == "ZeroDivisionError"


def test_traceback_keeps_real_recursion_frames() -> None:
    src = "def f(n):\n    return f(n - 1) if n else 1 // n\n\nf(3)\n"
    tb = record(src)["error"]["traceback"]
    assert [f["name"] for f in tb] == ["<module>", "f", "f", "f", "f"]


def test_student_traceback_direct() -> None:
    with pytest.raises(ZeroDivisionError) as info:
        exec(compile("1/0", "<student>", "exec"), {})
    frames = [f for f in student_traceback(info.value) if f["kind"] == "student"]
    assert [(f["line"], f["name"]) for f in frames] == [(1, "<module>")]


def test_syntax_error_runs_nothing() -> None:
    msgs: list[dict[str, Any]] = []
    run("print('no')\nx = (1,\n", {}, msgs.append)
    assert [m["type"] for m in msgs] == ["started", "done"]
    assert msgs[0]["sites"] == []
    assert msgs[1]["status"] == "error"
    assert msgs[1]["error"]["type"] == "SyntaxError"
    assert msgs[1]["error"]["line"] == 2
    log = record("print('no')\nx = (1,\n")
    assert log["status"] == "error" and log["events"] == [] and log["output"] == []


def test_message_sequence_and_done() -> None:
    msgs: list[dict[str, Any]] = []
    run("import numpy as np\nprint(np.zeros(2))\n", {}, msgs.append)
    kinds = [m["type"] for m in msgs]
    assert kinds[0] == "started" and kinds[-1] == "done" and set(kinds[1:-1]) == {"batch"}
    assert msgs[-1] == {"type": "done", "status": "ok", "error": None}
    outputs = [o for m in msgs if m["type"] == "batch" for o in m["output"]]
    assert [o["text"] for o in outputs] == ["[0. 0.]\n"]


def test_limit_status() -> None:
    src = "import numpy as np\nfor i in range(10):\n    np.zeros(1)\n"
    assert record(src, {"max_events": 3})["status"] == "limit"


def test_main_module_and_name() -> None:
    src = (
        "import sys\nclass A:\n    pass\n"
        "print(__name__, A.__module__, sys.modules['__main__'].A is A)\n"
    )
    log = record(src)
    assert log["output"][0]["text"] == "__main__ __main__ True\n"
    assert plain(src).stdout == log["output"][0]["text"]


def test_system_exit_is_ok() -> None:
    log = record("print('a')\nraise SystemExit(1)\nprint('b')\n")
    assert log["status"] == "ok" and log["error"] is None
    assert [o["text"] for o in log["output"]] == ["a\n"]


def test_recursion_depth_400_works_when_plain_works() -> None:
    src = "def f(n):\n    return 0 if n == 0 else 1 + f(n - 1)\nprint(f(400))\n"
    assert plain(src).stdout == "400\n"
    log = record(src)
    assert log["status"] == "ok" and log["output"][0]["text"] == "400\n"


def test_recursion_limit_still_applies() -> None:
    src = "def f(n):\n    return f(n + 1)\nf(0)\n"
    assert record(src)["error"]["type"] == "RecursionError"
    assert plain(src).returncode != 0


def test_keyboard_interrupt_from_hook_is_stopped_with_interrupted_event() -> None:
    src = "import numpy as np\na = np.zeros(2)\nb = np.ones(2)\nprint('never')\n"
    n = 0

    def on_enter(i: int, site: int) -> None:
        nonlocal n
        n += 1
        if n == 2:
            raise KeyboardInterrupt

    msgs: list[dict[str, Any]] = []
    run(src, {}, msgs.append, on_enter=on_enter)
    assert msgs[-1] == {"type": "done", "status": "stopped", "error": None}
    events = [e for m in msgs if m["type"] == "batch" for e in m["events"]]
    assert [(e["name"], e.get("interrupted")) for e in events] == [("zeros", None), ("ones", True)]
    assert events[1]["error"] is None and events[1]["ret"] == events[1]["i"]
    texts = [o["text"] for m in msgs if m["type"] == "batch" for o in m["output"]]
    assert "never\n" not in texts
    assert record("print(1)\n")["status"] == "ok"  # the next run is unaffected


def test_keyboard_interrupt_in_student_code() -> None:
    log = record("print('a')\nraise KeyboardInterrupt\n")
    assert log["status"] == "stopped" and log["error"] is None
    assert log["output"][0]["text"] == "a\n"


def test_on_enter_on_exit_called() -> None:
    seen: list[tuple[str, int]] = []
    run(
        "import numpy as np\nnp.zeros(1)\n",
        {},
        lambda m: None,
        on_enter=lambda i, s: seen.append(("in", i)),
        on_exit=lambda i: seen.append(("out", i)),
    )
    assert seen == [("in", 0), ("out", 0)]


def test_figure_entry_for_edge_mpl(in_data: None) -> None:
    cfg = {"draw_modules": ["sklearn", "pandas", "numpy", "matplotlib"]}
    log = record(program("edge_mpl"), cfg)
    assert log["status"] == "ok", log["error"]
    figs = [o for o in log["output"] if o["stream"] == "figure"]
    assert len(figs) == 1
    png = base64.b64decode(figs[0]["png"])
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 1000
    assert (figs[0]["width"], figs[0]["height"]) == (640, 480)
    assert len(log["output"]) == 1  # edge_mpl prints nothing
    names = [e["name"] for e in log["events"]]
    assert "show" in names and "plot" in names


def test_figures_closed_after_show() -> None:
    src = (
        "import matplotlib.pyplot as plt\n"
        "plt.figure(); plt.plot([1, 2])\nplt.figure(); plt.plot([2, 1])\nplt.show()\n"
        "print(len(plt.get_fignums()))\nplt.show()\n"
    )
    log = record(src)
    assert [o["stream"] for o in log["output"]] == ["figure", "figure", "stdout"]
    assert log["output"][2]["text"] == "0\n"


def test_no_matplotlib_import_unless_student_does() -> None:
    saved = {k: v for k, v in sys.modules.items() if k.startswith("matplotlib")}
    for k in saved:
        del sys.modules[k]
    try:
        record("print(1)\n")
        assert not any(k.startswith("matplotlib") for k in sys.modules)
    finally:
        sys.modules.update(saved)


def test_mpl_env_restored() -> None:
    before = os.environ.get("MPLBACKEND")
    record("import matplotlib.pyplot as plt\n")
    assert os.environ.get("MPLBACKEND") == before


def test_runs_share_no_state() -> None:
    a = record("import pandas as pd\npd.set_option('display.max_rows', 7)\nx = pd.Series([1])\n")
    b = record(
        "import pandas as pd\nprint(pd.get_option('display.max_rows'))\nx = pd.Series([1])\n"
    )
    assert b["output"][0]["text"] == "60\n"
    assert list(a["values"]) == ["v1.0"]  # object numbers restart in each run
    assert list(b["values"]) == ["s0", "v1.0"]
    c = record("print('x' in globals())\n")
    assert c["output"][0]["text"] == "False\n"


def test_two_identical_runs_give_identical_logs(in_data: None) -> None:
    src = program("golden_split")
    assert record(src) == record(src)


@pytest.mark.slow
@pytest.mark.parametrize("name", sorted(p.stem for p in PROGRAMS.glob("*.py") if p.stem != "heavy"))
def test_every_fixture_records_like_plain_python(name: str) -> None:
    """Whole-fixture subprocess check: status and stdout match plain Python."""
    code = (
        "import json, sys, machines\n"
        "log = machines.record(open(sys.argv[1]).read())\n"
        "print(json.dumps({'s': log['status'], 'd': log['diagnostics'], "
        "'o': ''.join(o['text'] for o in log['output'] if o['stream'] == 'stdout')}))\n"
    )
    env = {
        **os.environ,
        "PYTHONHASHSEED": "0",
        "MPLBACKEND": "Agg",
        "PYTHONPATH": str(ROOT / "python"),
    }
    kw: dict[str, Any] = {
        "cwd": DATA,
        "capture_output": True,
        "text": True,
        "stdin": subprocess.DEVNULL,
        "env": env,
        "timeout": 300,
    }
    rec = subprocess.run([sys.executable, "-c", code, str(PROGRAMS / f"{name}.py")], **kw)
    assert rec.returncode == 0, rec.stderr
    got = json.loads(rec.stdout.splitlines()[-1])
    base = subprocess.run([sys.executable, str(PROGRAMS / f"{name}.py")], **kw)
    assert got["d"] == []
    if name == "edge_input":  # plain gives EOFError; the runtime gives its own message
        assert got["s"] == "error"
        return
    assert (got["s"] in ("ok", "limit")) == (base.returncode == 0)
    assert got["o"] == base.stdout
