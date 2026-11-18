"""The runtime (CONTRACTS.md section 6): `run()` and `record()`, the one entry point.

A run instruments the source, compiles it as `<student>`, executes it in a fresh `__main__` module
with a `Recorder` installed, captures stdout, stderr and warnings as output entries tagged with the
latest event, and ends with a `done` message. Everything the run changes outside the student's
namespace (streams, `input`, the recursion limit, `sys.modules["__main__"]`, warning filters and
hook, the matplotlib backend) is restored before `done` is emitted.
"""

from __future__ import annotations

import builtins
import io
import linecache
import sys
import types
import warnings
from collections.abc import Callable
from typing import Any

from .mpl import MplHook, close_figures
from .recorder import Recorder, RunConfig
from .tracebacks import STUDENT_FILE, student_traceback
from .transform import instrument

__all__ = ["after_reset_hooks", "record", "reset_between_runs", "run"]

_MESSAGE_MAX = 4000
_SKLEARN_DEFAULTS: dict[str, Any] = {
    "assume_finite": False,
    "working_memory": 1024,
    "print_changed_only": True,
    "display": "diagram",
    "pairwise_dist_chunk_size": 256,
    "enable_cython_pairwise_dist": True,
    "array_api_dispatch": False,
    "transform_output": "default",
    "enable_metadata_routing": False,
    "skip_parameter_validation": False,
}
# Called at the end of every reset_between_runs(): the worker re-applies the pandas options it
# sets at startup here, since reset_option("all") wipes them.
after_reset_hooks: list[Callable[[], None]] = []


def _safe_str(exc: BaseException) -> str:
    try:
        s = str(exc)
    except Exception:  # noqa: BLE001
        s = "<unprintable>"
    return s if len(s) <= _MESSAGE_MAX else s[: _MESSAGE_MAX - 1] + "…"


class _Output:
    """Collects writes into `OutputEntry`s tagged with the latest event.

    Consecutive writes to the same stream with the same tag are merged. The pending entry is
    committed when the stream or tag changes, when a recorded call starts (so streaming shows text
    printed before a long call), and at the end of the run, so the log never depends on timing.
    """

    def __init__(self, rec: Recorder) -> None:
        self.rec = rec
        self._pending: tuple[str, int, list[str]] | None = None

    def write(self, stream: str, text: str) -> None:
        if not text:
            return
        tag = self.rec.current_event
        p = self._pending
        if p is not None and p[0] == stream and p[1] == tag:
            p[2].append(text)
            return
        self.commit()
        self._pending = (stream, tag, [text])

    def commit(self) -> None:
        p, self._pending = self._pending, None
        if p is not None:
            self.rec.add_output({"i": p[1], "stream": p[0], "text": "".join(p[2])})

    def add(self, entry: dict[str, Any]) -> None:
        """A finished entry that is never merged (warning, figure), after any pending text."""
        self.commit()
        self.rec.add_output({"i": self.rec.current_event, **entry})


class _Stream(io.TextIOBase):
    encoding = "utf-8"
    errors = "strict"

    def __init__(self, out: _Output, name: str) -> None:
        self._out = out
        self._name = name
        self.name = f"<{name}>"

    def write(self, s: str, /) -> int:
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        self._out.write(self._name, s)
        return len(s)

    def writable(self) -> bool:
        return True

    def fileno(self) -> int:
        raise io.UnsupportedOperation("fileno")

    def isatty(self) -> bool:
        return False

    def flush(self) -> None:
        return None


def _input(prompt: object = "", /) -> str:
    raise RuntimeError("input() is not supported here")


def reset_between_runs() -> None:
    """Close matplotlib figures and reset pandas options. Imports nothing the student has not."""
    close_figures()
    pd = sys.modules.get("pandas")
    if pd is not None:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")  # resetting deprecated options warns
                pd.reset_option("all")
        except Exception:  # noqa: BLE001
            pass
    sk = sys.modules.get("sklearn")
    if sk is not None:  # transform_output and friends change what the program does
        try:
            current = sk.get_config()
            sk.set_config(**{k: v for k, v in _SKLEARN_DEFAULTS.items() if k in current})
        except Exception:  # noqa: BLE001
            pass
    for hook in after_reset_hooks:
        try:
            hook()
        except Exception:  # noqa: BLE001
            pass


def _run_error(exc: BaseException) -> dict[str, Any]:
    tb = student_traceback(exc)
    line = next((f["line"] for f in reversed(tb) if f["kind"] == "student"), None)
    return {"type": type(exc).__name__, "message": _safe_str(exc), "line": line, "traceback": tb}


def _syntax_error(exc: SyntaxError) -> dict[str, Any]:
    line = exc.lineno
    frames: list[dict[str, Any]] = []
    if line is not None:
        text = (exc.text or "").strip()
        frames.append({"kind": "student", "line": line, "text": text, "name": "<module>"})
    msg = exc.msg or _safe_str(exc)
    return {"type": type(exc).__name__, "message": msg, "line": line, "traceback": frames}


def _execute(
    source: str,
    config: dict[str, Any] | RunConfig | None,
    emit: Callable[[dict[str, Any]], None],
    on_enter: Callable[[int, int], None] | None,
    on_exit: Callable[[int], None] | None,
) -> tuple[Recorder, str, dict[str, Any] | None]:
    """Run the program; returns the recorder, the final status and the RunError (before `done`)."""
    reset_between_runs()
    try:
        inst = instrument(source)
        code = compile(inst.tree, STUDENT_FILE, "exec")
    except SyntaxError as e:
        rec = Recorder([], config, emit)
        err = _syntax_error(e)
        emit({"type": "started", "sites": []})
        emit({"type": "done", "status": "error", "error": err})
        return rec, "error", err

    # The original source, so tracebacks and `inspect.getsource` show what the student typed.
    lines = source.splitlines(keepends=True)
    linecache.cache[STUDENT_FILE] = (len(source), None, lines, STUDENT_FILE)

    main = types.ModuleType("__main__")
    ns = main.__dict__
    ns["__builtins__"] = builtins
    ns["__file__"] = STUDENT_FILE

    holder: list[_Output] = []

    def enter(i: int, site: int) -> None:
        holder[0].commit()  # text printed so far is shown before the call that follows it
        if on_enter is not None:
            on_enter(i, site)

    rec = Recorder(inst.sites, config, emit, on_enter=enter, on_exit=on_exit, namespace=ns)
    out = _Output(rec)
    holder.append(out)
    mpl = MplHook(
        lambda png, w, h: out.add({"stream": "figure", "png": png, "width": w, "height": h})
    )

    def showwarning(
        message: Any, category: Any, filename: str, lineno: int, file: Any = None, line: Any = None
    ) -> None:
        if file is not None and not isinstance(file, _Stream):
            write_to_file(message, category, filename, lineno, file, line)
            return
        where = lineno
        if filename != STUDENT_FILE:
            where = rec.current_line() or lineno
        out.add({"stream": "warning", "text": f"{where}: {category.__name__}: {message}"})

    status = "ok"
    error: dict[str, Any] | None = None
    exc: BaseException | None = None
    emit({"type": "started", "sites": inst.sites})
    undo: list[Callable[[], None]] = []  # restores, registered before each change, run in reverse
    cw = warnings.catch_warnings()
    cw_state = {"entered": False}
    write_to_file = getattr(warnings, "_showwarning_orig", warnings.showwarning)
    saved_main = sys.modules.get("__main__")
    saved_in = (sys.stdout, sys.stderr, builtins.input, sys.getrecursionlimit())

    def exit_warnings() -> None:
        if cw_state["entered"]:
            cw_state["entered"] = False
            cw.__exit__(None, None, None)

    def restore_main() -> None:
        if saved_main is not None:
            sys.modules["__main__"] = saved_main
        else:
            sys.modules.pop("__main__", None)

    def restore_streams() -> None:
        sys.stdout, sys.stderr, builtins.input = saved_in[:3]

    try:
        undo.append(exit_warnings)
        cw.__enter__()
        cw_state["entered"] = True
        warnings.showwarning = showwarning
        undo.append(restore_streams)
        sys.stdout = _Stream(out, "stdout")
        sys.stderr = _Stream(out, "stderr")
        builtins.input = _input
        undo.append(lambda: sys.setrecursionlimit(saved_in[3]))
        sys.setrecursionlimit(saved_in[3] * 2)
        undo.append(restore_main)
        sys.modules["__main__"] = main
        undo.append(mpl.uninstall)
        mpl.install()
        undo.append(rec.uninstall)
        rec.install()
        exec(code, ns)
    except SystemExit as e:
        exc = e
        _exit_message(e, out)
    except BaseException as e:  # noqa: BLE001 - everything the program raises ends the run
        exc = e
    late = _guarded(out.commit)
    late = _teardown(undo) or late
    late = _guarded(reset_between_runs) or late
    if isinstance(late, KeyboardInterrupt) and exc is None:
        exc = late
    if exc is not None:
        if isinstance(exc, KeyboardInterrupt):
            status = "stopped"
        elif isinstance(exc, SystemExit):
            status = "ok"  # exit() ends the program, as in plain Python
        else:
            status = "error"
            error = _run_error(exc)
    closed = _guarded(lambda: rec.close_open(exc))
    if isinstance(closed, KeyboardInterrupt) and status == "ok":
        status = "stopped"
    status = rec.final_status(status)
    for _ in range(3):  # a late interrupt must still end in `done`
        try:
            emit({"type": "done", "status": status, "error": error})
            break
        except KeyboardInterrupt:
            if error is None and status == "ok":
                status = "stopped"
    return rec, status, error


def _guarded(fn: Callable[[], object]) -> BaseException | None:
    """Run `fn`, retrying once after an interrupt; return what it raised, if anything."""
    caught: BaseException | None = None
    for _ in range(2):
        try:
            fn()
            return caught
        except BaseException as e:  # noqa: BLE001 - teardown must not stop half way
            caught = caught or e
    return caught


def _teardown(undo: list[Callable[[], None]]) -> BaseException | None:
    """Run every restore, last registered first, each in its own guard."""
    first: BaseException | None = None
    while undo:
        err = _guarded(undo.pop())
        if err is not None and (first is None or isinstance(err, KeyboardInterrupt)):
            first = err
    return first


def _exit_message(e: SystemExit, out: _Output) -> None:
    """What plain Python writes to stderr for `sys.exit(arg)`: the text of a non-int argument."""
    code = e.code
    if code is None or isinstance(code, int):
        return
    try:
        out.write("stderr", f"{code}\n")
    except Exception:  # noqa: BLE001
        pass


def run(
    source: str,
    config: dict[str, Any],
    emit: Callable[[dict[str, Any]], None],
    *,
    on_enter: Callable[[int, int], None] | None = None,
    on_exit: Callable[[int], None] | None = None,
) -> None:
    """Run `source` and stream `started`, `batch`es and `done` (section 7, without `runId`)."""
    _execute(source, config, emit, on_enter, on_exit)


def record(source: str, config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run `source` and return the full EventLog (CPython and test path)."""
    rec, status, error = _execute(source, config, lambda _msg: None, None, None)
    return rec.log(status, error)
