"""Student-only tracebacks (CONTRACTS.md section 6).

`student_traceback(exc)` turns `exc.__traceback__` into the `TracebackFrame` list of section 2:
`<student>` frames with their source text, the recorder's own frames removed, and every run of
other frames folded into one `library` entry.
"""

from __future__ import annotations

import linecache
import os
from typing import Any

__all__ = ["STUDENT_FILE", "student_traceback"]

STUDENT_FILE = "<student>"
_MACHINES_DIR = os.path.dirname(os.path.abspath(__file__))


def _is_recorder_file(filename: str) -> bool:
    try:
        return os.path.dirname(os.path.abspath(filename)) == _MACHINES_DIR
    except TypeError, ValueError:  # pragma: no cover - odd filenames
        return False


def student_traceback(exc: BaseException) -> list[dict[str, Any]]:
    """Student frames (with text), recorder frames dropped, library frames folded.

    Each recorded call adds recorder frames and a second `<student>` frame at the same line; when
    recorder frames were dropped between two identical student frames, they are merged into one.
    Real recursion (identical frames with nothing dropped between) is folded into one frame whose
    `repeat` is the number of additional occurrences.
    """
    frames: list[dict[str, Any]] = []
    dropped = False  # a recorder frame was dropped since the last kept frame
    tb = exc.__traceback__
    while tb is not None:
        f = tb.tb_frame
        filename = f.f_code.co_filename
        line = tb.tb_lineno
        if filename == STUDENT_FILE:
            text = (linecache.getline(STUDENT_FILE, line) or "").strip()
            fr = {"kind": "student", "line": line, "text": text, "name": f.f_code.co_name}
            last = frames[-1] if frames else None
            same = (
                last is not None
                and last["kind"] == "student"
                and (last["line"], last["name"], last["text"])
                == (fr["line"], fr["name"], fr["text"])
            )
            if same and dropped:
                pass  # the eval frame of a recorded call: same line as the caller's frame
            elif same and last is not None:
                last["repeat"] = last.get("repeat", 0) + 1  # recursion: "repeated N more times"
            else:
                frames.append(fr)
            dropped = False
        elif _is_recorder_file(filename):
            dropped = True
        else:
            mod = str(f.f_globals.get("__name__") or filename).split(".")[0]
            last = frames[-1] if frames else None
            if last is not None and last["kind"] == "library":
                last["count"] += 1
                if mod not in last["modules"]:
                    last["modules"].append(mod)
            else:
                frames.append({"kind": "library", "count": 1, "modules": [mod]})
            dropped = False
        tb = tb.tb_next
    return frames
