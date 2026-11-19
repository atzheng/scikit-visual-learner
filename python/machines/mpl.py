"""matplotlib support (CONTRACTS.md section 6): Agg backend and `plt.show()` to figure output.

Nothing here imports matplotlib. `MplHook.install()` forces the Agg backend through the
`MPLBACKEND` environment variable (read when matplotlib is imported), and a `sys.meta_path` finder
patches `matplotlib.pyplot.show` right after that module executes, whenever the student imports it.
"""

from __future__ import annotations

import base64
import functools
import importlib.abc
import importlib.machinery
import io
import os
import struct
import sys
import warnings
from collections.abc import Callable
from typing import Any

__all__ = ["MplHook", "close_figures", "png_size"]

_PYPLOT = "matplotlib.pyplot"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


_FLOAT_XY_MESSAGE = r"The [xy] parameter as float was deprecated"


def _deprecation_category() -> type[Warning]:
    try:
        from matplotlib import MatplotlibDeprecationWarning

        return MatplotlibDeprecationWarning  # type: ignore[no-any-return]
    except ImportError:  # pragma: no cover
        return DeprecationWarning


def png_size(data: bytes) -> tuple[int, int]:
    """(width, height) from a PNG's IHDR chunk."""
    if data[:8] != _PNG_MAGIC:
        raise ValueError("not a PNG")
    w, h = struct.unpack(">II", data[16:24])
    return int(w), int(h)


def close_figures() -> None:
    """Close every figure, if matplotlib.pyplot was imported (never imports it)."""
    plt = sys.modules.get(_PYPLOT)
    if plt is not None:
        try:
            plt.close("all")
        except Exception:  # noqa: BLE001
            pass


class _Finder(importlib.abc.MetaPathFinder):
    def __init__(self, hook: MplHook) -> None:
        self.hook = hook

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname != _PYPLOT or self.hook.patching:
            return None
        self.hook.patching = True
        try:
            spec = None
            for finder in sys.meta_path:
                if finder is self or not hasattr(finder, "find_spec"):
                    continue
                spec = finder.find_spec(fullname, path, target)
                if spec is not None:
                    break
        finally:
            self.hook.patching = False
        if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
            return spec
        spec.loader = _PatchingLoader(spec.loader, self.hook)
        return spec


class _PatchingLoader(importlib.abc.Loader):
    def __init__(self, inner: Any, hook: MplHook) -> None:
        self.inner = inner
        self.hook = hook

    def create_module(self, spec: Any) -> Any:
        return self.inner.create_module(spec)

    def exec_module(self, module: Any) -> None:
        self.inner.exec_module(module)
        self.hook.patch_pyplot(module)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


class MplHook:
    """Per-run matplotlib setup. `emit_figure(b64_png, width, height)` gets each shown figure."""

    def __init__(self, emit_figure: Callable[[str, int, int], None]) -> None:
        self.emit_figure = emit_figure
        self.patching = False
        self._finder: _Finder | None = None
        self._saved_env: str | None = None
        self._env_set = False
        self._orig_show: Any = None
        self._plt: Any = None

    def install(self) -> None:
        self._saved_env = os.environ.get("MPLBACKEND")
        os.environ["MPLBACKEND"] = "Agg"
        self._env_set = True
        self._finder = _Finder(self)
        sys.meta_path.insert(0, self._finder)
        mpl = sys.modules.get("matplotlib")
        if mpl is not None:  # already imported by an earlier run: switch the backend now
            try:
                mpl.use("Agg", force=True)
            except Exception:  # noqa: BLE001
                pass
        plt = sys.modules.get(_PYPLOT)
        if plt is not None:
            self.patch_pyplot(plt)

    def uninstall(self) -> None:
        if self._finder is not None:
            try:
                sys.meta_path.remove(self._finder)
            except ValueError:
                pass
            self._finder = None
        if self._plt is not None and self._orig_show is not None:
            self._plt.show = self._orig_show
            self._plt = None
        if self._env_set:
            if self._saved_env is None:
                os.environ.pop("MPLBACKEND", None)
            else:
                os.environ["MPLBACKEND"] = self._saved_env
            self._env_set = False

    def patch_pyplot(self, plt: Any) -> None:
        if self._plt is plt:
            return
        self._plt = plt
        self._orig_show = plt.show
        hook = self

        @functools.wraps(
            self._orig_show
        )  # keeps module/name: `plt.show` is still a matplotlib call
        def show(*args: Any, **kwargs: Any) -> None:
            hook.show_all(plt)

        plt.show = show

    def show_all(self, plt: Any) -> None:
        for num in list(plt.get_fignums()):
            fig = plt.figure(num)
            buf = io.BytesIO()
            with warnings.catch_warnings():
                # Pyodide's matplotlib build passes float x/y to draw_text for every drawn text
                # (CPython does not). Hide only that warning, only while we render the figure.
                warnings.filterwarnings(
                    "ignore",
                    message=_FLOAT_XY_MESSAGE,
                    category=_deprecation_category(),
                )
                fig.savefig(buf, format="png", dpi=100)
            data = buf.getvalue()
            w, h = png_size(data)
            self.emit_figure(base64.b64encode(data).decode("ascii"), w, h)
        plt.close("all")
