"""Shared test helpers: pass-through recorder hooks (no recording)."""

from __future__ import annotations

import builtins
import contextlib
import io
import sys
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from machines.transform import HOOK_NAMES, Instrumented


def _rec(site: int, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    return fn(*args, **kwargs)


def _bind(site: int, mapping: dict[str, Any], /) -> None:
    return None


def _store(site: int, base: Any, /) -> None:
    return None


def _scope(fn: Callable[..., Any], /) -> Callable[..., Any]:
    return fn


def _ret(site: int, value: Any, /) -> Any:
    return value


PASSTHROUGH_HOOKS: dict[str, Callable[..., Any]] = dict(
    zip(HOOK_NAMES, (_rec, _bind, _store, _scope, _ret), strict=True)
)


@pytest.fixture
def passthrough_hooks() -> Iterator[None]:
    """Install pass-through hooks in builtins for the duration of a test."""
    saved = {n: getattr(builtins, n) for n in HOOK_NAMES if hasattr(builtins, n)}
    for name, hook in PASSTHROUGH_HOOKS.items():
        setattr(builtins, name, hook)
    try:
        yield
    finally:
        for name in HOOK_NAMES:
            if name in saved:
                setattr(builtins, name, saved[name])
            else:
                delattr(builtins, name)


def run_source(source: str | Instrumented) -> tuple[dict[str, Any], str, str | None]:
    """Run plain source, or an instrumented tree, as `<student>`.

    Returns (namespace, stdout, error) where error is "Type: message" or None.
    """
    code = compile(source if isinstance(source, str) else source.tree, "<student>", "exec")
    ns: dict[str, Any] = {"__name__": "__main__"}
    buf = io.StringIO()
    err = None
    with contextlib.redirect_stdout(buf):
        try:
            exec(code, ns)
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
    return ns, buf.getvalue(), err


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Skip tests marked `no_pyodide(reason=...)` inside Pyodide (`pnpm test:pyodide`)."""
    if sys.platform != "emscripten":
        return
    for item in items:
        mark = item.get_closest_marker("no_pyodide")
        if mark:
            item.add_marker(pytest.mark.skip(reason=f"no_pyodide: {mark.kwargs['reason']}"))
