"""Every fixture program runs in a subprocess: exit status and deterministic stdout."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PROGRAMS = ROOT / "fixtures" / "programs"
DATA = ROOT / "fixtures" / "data"
FAILING = {"edge_syntax.py", "edge_input.py", "edge_error.py"}
ALL = sorted(p.name for p in PROGRAMS.glob("*.py"))


def run(name: str) -> subprocess.CompletedProcess[str]:
    # cwd is fixtures/data so `pd.read_csv("listings.csv")` works here and in the browser
    return subprocess.run(
        [sys.executable, str(PROGRAMS / name)],
        cwd=DATA,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "PYTHONHASHSEED": "0", "MPLBACKEND": "Agg"},
    )


def test_all_programs_present() -> None:
    assert len(ALL) == 31


def test_notebook_is_twenty_lines() -> None:
    lines = (PROGRAMS / "notebook.py").read_text().splitlines()
    assert len([ln for ln in lines if ln.strip()]) == 20


@pytest.mark.slow
@pytest.mark.parametrize("name", ALL)
def test_program_runs(name: str) -> None:
    first = run(name)
    if name in FAILING:
        assert first.returncode != 0, first.stdout
    else:
        assert first.returncode == 0, first.stderr
    second = run(name)
    assert second.returncode == first.returncode
    assert second.stdout == first.stdout
