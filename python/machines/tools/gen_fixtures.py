"""Regenerate fixtures/logs/*.json and fixtures/streams/*.jsonl (CONTRACTS.md section 9).

For each fixtures/programs/<name>.py the program runs through `machines.runtime.run` with cwd
`fixtures/data`, the Agg backend and stdin closed. Every message `run()` emits is written, one per
line, to fixtures/streams/<name>.jsonl; the log from `record()` is written to
fixtures/logs/<name>.json (the golden test also checks that assembling the stream gives the same
log).

Flush timing is forced: `recorder._FLUSH_SECONDS` is set to 0 while generating, so the recorder
flushes at every hook where something changed, whatever the machine's speed. The streams therefore
contain many small batches and open-call stubs, which the assembler cross-check exercises.

Files are pretty-printed with sorted keys. Wall-clock timings (GridSearchCV `refit_time_` and the
`*_fit_time` / `*_score_time` entries of `cv_results_`) get a fixed repr in `values.py`, so the
output is byte-identical between runs with no normalisation.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
PROGRAMS = ROOT / "fixtures" / "programs"
DATA = ROOT / "fixtures" / "data"
LOGS = ROOT / "fixtures" / "logs"
STREAMS = ROOT / "fixtures" / "streams"

# Per-fixture RunConfig overrides. matplotlib is not drawn by default.
CONFIGS: dict[str, dict[str, Any]] = {
    "edge_mpl": {"draw_modules": ["sklearn", "pandas", "numpy", "matplotlib"]},
}


def program_names() -> list[str]:
    return sorted(p.stem for p in PROGRAMS.glob("*.py"))


@contextlib.contextmanager
def fixture_env() -> Iterator[None]:
    """cwd = fixtures/data, MPLBACKEND=Agg, stdin closed, flush on every change."""
    from machines import recorder

    saved_cwd = os.getcwd()
    saved_env = os.environ.get("MPLBACKEND")
    saved_stdin = sys.stdin
    saved_flush = recorder._FLUSH_SECONDS
    os.chdir(DATA)
    os.environ["MPLBACKEND"] = "Agg"
    sys.stdin = open(os.devnull)  # noqa: SIM115
    recorder._FLUSH_SECONDS = 0.0
    try:
        yield
    finally:
        recorder._FLUSH_SECONDS = saved_flush
        sys.stdin.close()
        sys.stdin = saved_stdin
        if saved_env is None:
            os.environ.pop("MPLBACKEND", None)
        else:
            os.environ["MPLBACKEND"] = saved_env
        os.chdir(saved_cwd)


def source_of(name: str) -> str:
    return (PROGRAMS / f"{name}.py").read_text()


def run_fixture(name: str) -> list[dict[str, Any]]:
    """The messages `run()` emits for fixtures/programs/<name>.py. Call inside `fixture_env()`."""
    from machines import runtime

    messages: list[dict[str, Any]] = []
    # Round-trip through JSON so what we hold is exactly what is written, detached from the
    # recorder's live dicts.
    runtime.run(
        source_of(name),
        CONFIGS.get(name, {}),
        lambda m: messages.append(json.loads(json.dumps(m))),
    )
    return messages


def record_fixture(name: str) -> dict[str, Any]:
    """The `record()` log of the program. Call inside `fixture_env()`."""
    from machines import runtime

    return runtime.record(source_of(name), CONFIGS.get(name, {}))


def dumps_log(log: dict[str, Any]) -> str:
    return json.dumps(log, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def dumps_stream(messages: list[dict[str, Any]]) -> str:
    return "".join(json.dumps(m, sort_keys=True, ensure_ascii=False) + "\n" for m in messages)


def main(argv: list[str] | None = None) -> int:
    names = (argv if argv is not None else sys.argv[1:]) or program_names()
    LOGS.mkdir(parents=True, exist_ok=True)
    STREAMS.mkdir(parents=True, exist_ok=True)
    with fixture_env():
        for name in names:
            log = record_fixture(name)
            messages = run_fixture(name)
            (LOGS / f"{name}.json").write_text(dumps_log(log))
            (STREAMS / f"{name}.jsonl").write_text(dumps_stream(messages))
            print(f"{name}: {len(log['events'])} events, {len(messages)} messages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
