"""Value table (CONTRACTS.md section 5): tokens, classification, fingerprints, versions, summaries.

Imports only the standard library. numpy, pandas, scipy and sklearn are never imported here:
they are looked up in ``sys.modules`` (a student object of such a type implies the library is
already loaded), so the module imports on a bare interpreter and costs nothing when unused.

Token numbering starts at 0 for both objects (``v0.0``) and scalars (``s0``).
Nothing derived from ``id()``, addresses or time reaches a token or a summary.

Known transparency limit: objects that cannot be weakly referenced (lists, dicts, tuples, sets)
are kept alive after their first token, in an LRU bounded by ``_KEEP_MAX`` entries and
``_KEEP_BYTES`` of estimated size (shallow size plus the fingerprint's item keys). An evicted
object loses its number (``id`` -> number mapping dropped, so no id-reuse risk): a later
sighting of it gets a fresh token, a missing wire and never a false one. Fingerprints never hold
strong references (weakref per weakref-able item, id and type otherwise), so cycles still
collect.
"""

from __future__ import annotations

import hashlib
import json
import re
import reprlib
import sys
import types
import weakref
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Literal

__all__ = ["ValueTable"]

Kind = Literal["scalar", "label", "reference"]

_BASIC_SCALARS = (int, float, complex, bool, str, bytes, type(None), type(Ellipsis))
_SIMPLE_TYPES = frozenset(_BASIC_SCALARS)
_LABEL_TYPES = (
    types.FunctionType,
    types.BuiltinFunctionType,
    types.MethodType,
    types.ModuleType,
    types.WrapperDescriptorType,
    types.MethodWrapperType,
    types.MethodDescriptorType,
    types.ClassMethodDescriptorType,
    type,
)
_ANGLE = re.compile(r"<[^<>]*>")
_ADDRESS = re.compile(r"\s(?:at\s)?0x[0-9a-fA-F]+")
_MAX_ATTRS = 64
_KEEP_MAX = 256
_KEEP_BYTES = 16 * 1024 * 1024
_KEY_BYTES = 100
_CELL_MAX = 40
_PREVIEW_ROWS = 5
_PREVIEW_COLS = 8
_MATRIX = 5
_MAX_COLUMNS = 50


def _mod(name: str) -> Any:
    return sys.modules.get(name)


def _clip(text: str, n: int = _CELL_MAX) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def _strip_addresses(s: str) -> str:
    """Remove memory addresses from `<...>` object reprs only (determinism)."""
    return _ANGLE.sub(lambda m: _ADDRESS.sub("", m.group()), s)


def _cell(x: Any) -> str:
    """Format one preview cell: str(), NaN shown as NaN, at most 40 characters."""
    if isinstance(x, float) and x != x:
        return "NaN"
    try:
        s = str(x)
    except Exception:
        s = f"<{type(x).__name__}>"
    return _clip(s if isinstance(x, str) else _strip_addresses(s))


def _repr(obj: Any) -> str:
    try:
        s = reprlib.repr(obj)
    except Exception:
        s = f"<{type(obj).__name__}>"
    return _clip(s if isinstance(obj, str) else _strip_addresses(s))


def _key(x: Any) -> tuple[Any, ...]:
    """A reference to an item that never keeps it alive (fingerprints must not hold objects).

    Simple scalars compare by value, weakref-able objects by a weakref, others by id and type.
    """
    if type(x) in _SIMPLE_TYPES:
        return ("v", x)
    try:
        return ("w", weakref.ref(x))
    except TypeError:
        return ("i", id(x), type(x))


def _same_item(a: tuple[Any, ...], b: tuple[Any, ...]) -> bool:
    if a[0] != b[0]:
        return False
    if a[0] == "w":
        x = a[1]()
        return x is not None and x is b[1]()
    if a[0] == "i":
        return a[1:] == b[1:]
    x, y = a[1], b[1]
    if x is y:
        return True
    if type(x) is not type(y):
        return False
    try:
        return bool(x == y) or bool(x != x and y != y)
    except Exception:
        return False


def _same_fp(a: Any, b: Any) -> bool:
    """Fingerprints are (struct, keys): struct compares by ==, keys by `_same_item`."""
    if a is None or b is None:
        return a is b
    if a[0] != b[0]:
        return False
    ra, rb = a[1], b[1]
    return len(ra) == len(rb) and all(_same_item(x, y) for x, y in zip(ra, rb, strict=True))


def _digest(data: bytes) -> str:
    return hashlib.blake2b(data, digest_size=16).hexdigest()


class ValueTable:
    def __init__(
        self,
        preview_bytes: int = 1_000_000,
        hash_cells: int = 100_000,
        machine_classes: list[str] | tuple[str, ...] = (),
    ) -> None:
        self.preview_bytes = preview_bytes
        self.hash_cells = hash_cells
        self.machine_classes = frozenset(machine_classes)
        self.in_reentry = False
        self._gen = 0
        self.reset()

    def reset(self) -> None:
        """Forget everything: numbering restarts, kept-alive objects are released."""
        self._gen += 1  # stale finalizers become no-ops
        self._ids: dict[int, int] = {}  # id(obj) -> object number
        self._versions: dict[int, int] = {}
        self._fps: dict[int, Any] = {}
        self._keep: OrderedDict[int, tuple[Any, int]] = OrderedDict()  # no weakref support: LRU
        self._keep_bytes = 0
        self._next_obj = 0
        self._next_scalar = 0
        self.values: dict[str, dict[str, Any]] = {}
        self._new: dict[str, dict[str, Any]] = {}
        self._preview_used = 0

    # -- re-entry ---------------------------------------------------------------------------

    @contextmanager
    def reentry(self) -> Iterator[None]:
        """Mark that the recorder is running student-visible code (repr, properties, signatures).

        Sets ``in_reentry`` and always restores the previous value, even on exception.
        """
        prev = self.in_reentry
        self.in_reentry = True
        try:
            yield
        finally:
            self.in_reentry = prev

    # -- classification ---------------------------------------------------------------------

    def classify(self, obj: Any) -> Kind:
        t = type(obj)
        if t in _SIMPLE_TYPES:
            return "scalar"
        if isinstance(obj, _BASIC_SCALARS):
            return "scalar"
        if isinstance(obj, _LABEL_TYPES):
            return "label"
        np = _mod("numpy")
        if np is not None:
            if isinstance(obj, np.generic):
                return "scalar"
            if isinstance(obj, np.ufunc):
                return "label"
        pd = _mod("pandas")
        if pd is not None and isinstance(
            obj,
            (pd.Timestamp, pd.Timedelta, pd.Period, type(pd.NA), type(pd.NaT)),
        ):
            return "scalar"
        if (t is tuple or t is frozenset) and all(self.classify(x) == "scalar" for x in obj):
            return "scalar"
        return "reference"

    def seen(self, obj: Any) -> bool:
        """Has this object been given a token yet?"""
        return id(obj) in self._ids

    def is_machine(self, obj: Any) -> bool:
        if self.classify(obj) != "reference":
            return False
        t = type(obj)
        if t.__module__ == "__main__":
            return True
        base = _mod("sklearn.base")
        if base is not None and isinstance(obj, base.BaseEstimator):
            return True
        if self.machine_classes:
            for c in t.__mro__:
                if f"{c.__module__}.{c.__qualname__}" in self.machine_classes:
                    return True
        return False

    # -- tokens -----------------------------------------------------------------------------

    def fresh_scalar(self, obj: Any = None) -> str:
        n = self._next_scalar
        self._next_scalar += 1
        return f"s{n}"

    def _number(self, obj: Any) -> int:
        n = self._ids.get(id(obj))
        if n is not None:
            if self._keep and id(obj) in self._keep:
                self._keep.move_to_end(id(obj))
            return n
        n = self._next_obj
        self._next_obj += 1
        self._ids[id(obj)] = n
        self._versions[n] = 0
        try:
            weakref.finalize(obj, self._drop, self._gen, id(obj), n).atexit = False
        except TypeError:
            self._retain(obj)
        self._fps[n] = self._fingerprint(obj)
        return n

    def _retain(self, obj: Any) -> None:
        """Keep an unweakrefable object alive (so its id stays valid), within a bound."""
        try:
            # shallow size plus the fingerprint's per-item keys (about 100 bytes each)
            size = sys.getsizeof(obj) + _KEY_BYTES * len(obj)
        except Exception:
            size = 64
        self._keep[id(obj)] = (obj, size)
        self._keep_bytes += size
        while len(self._keep) > 1 and (
            len(self._keep) > _KEEP_MAX or self._keep_bytes > _KEEP_BYTES
        ):
            oid, (_, sz) = self._keep.popitem(last=False)
            self._keep_bytes -= sz
            n = self._ids.pop(oid, None)
            if n is not None:
                self._versions.pop(n, None)
                self._fps.pop(n, None)

    def _drop(self, gen: int, oid: int, n: int) -> None:
        if gen != self._gen:
            return
        if self._ids.get(oid) == n:
            del self._ids[oid]
        self._versions.pop(n, None)
        self._fps.pop(n, None)

    def token(self, obj: Any) -> str:
        n = self._number(obj)
        return f"v{n}.{self._versions[n]}"

    def check(self, obj: Any) -> tuple[str, str] | None:
        if self.classify(obj) != "reference":
            return None
        if id(obj) not in self._ids:
            self._number(obj)  # first sight: baseline, no change
            return None
        n = self._ids[id(obj)]
        fp = self._fingerprint(obj)
        if _same_fp(self._fps[n], fp):
            return None
        return self._advance(n, fp)

    def bump(self, obj: Any) -> tuple[str, str]:
        n = self._number(obj)
        return self._advance(n, self._fingerprint(obj))

    def _advance(self, n: int, fp: Any) -> tuple[str, str]:
        before = f"v{n}.{self._versions[n]}"
        self._versions[n] += 1
        self._fps[n] = fp
        return before, f"v{n}.{self._versions[n]}"

    # -- fingerprints -----------------------------------------------------------------------

    def _hash_ok(self, cells: int) -> bool:
        return cells <= self.hash_cells

    def _fingerprint(self, obj: Any) -> Any:
        """Return (struct, refs) or None. Never raises."""
        try:
            return self._fingerprint_unsafe(obj)
        except Exception:
            return None

    def _fingerprint_unsafe(self, obj: Any) -> Any:
        pd = _mod("pandas")
        np = _mod("numpy")
        if pd is not None:
            if isinstance(obj, pd.DataFrame):
                rows, cols = obj.shape
                struct = (
                    "df",
                    (rows, cols),
                    tuple(map(str, obj.columns)),
                    tuple(str(d) for d in obj.dtypes),
                    self._pandas_hash(pd, obj) if self._hash_ok(rows * cols) else None,
                )
                return (struct, ())
            if isinstance(obj, pd.Series):
                struct = (
                    "series",
                    obj.shape,
                    str(obj.dtype),
                    str(obj.name),
                    self._pandas_hash(pd, obj) if self._hash_ok(len(obj)) else None,
                )
                return (struct, ())
        if np is not None and isinstance(obj, np.ndarray):
            h = None
            if self._hash_ok(obj.size):
                try:
                    h = _digest(obj.tobytes())
                except Exception:
                    h = None
            return (("array", obj.shape, str(obj.dtype), h), ())
        sp = _mod("scipy.sparse")
        if sp is not None and sp.issparse(obj):
            h = None
            if self._hash_ok(obj.nnz) and obj.format in ("csr", "csc", "coo", "bsr", "dia"):
                try:
                    parts = [obj.data.tobytes()]
                    for name in ("indices", "indptr", "row", "col", "offsets"):
                        a = getattr(obj, name, None)
                        if a is not None:
                            parts.append(a.tobytes())
                    h = _digest(b"|".join(parts))
                except Exception:
                    h = None
            return (("sparse", obj.format, obj.shape, obj.nnz, str(obj.dtype), h), ())
        t = type(obj)
        if t is list or t is tuple:
            return (("seq", t.__name__, len(obj)), tuple(_key(x) for x in obj))
        if t is dict:
            refs: list[Any] = []
            for k, v in obj.items():
                refs.append(k)
                refs.append(v)
            return (("dict", len(obj)), tuple(_key(x) for x in refs))
        if t is set:
            return (("set", frozenset((id(x), type(x)) for x in obj)), ())
        names: list[str] = []
        keys: list[tuple[Any, ...]] = []
        attrs = getattr(obj, "__dict__", None)
        if isinstance(attrs, dict):
            for k in tuple(attrs):
                names.append(str(k))
                keys.append(_key(attrs[k]))
        for k in self._slot_names(t):
            try:
                v = getattr(obj, k)
            except AttributeError:
                continue
            names.append("slot:" + k)
            keys.append(_key(v))
        if not names and not isinstance(attrs, dict) and not self._slot_names(t):
            return None
        return (("obj", tuple(names)), tuple(keys))

    @staticmethod
    def _slot_names(t: type) -> list[str]:
        out: list[str] = []
        for c in t.__mro__:
            sl = c.__dict__.get("__slots__", ())
            for k in (sl,) if isinstance(sl, str) else sl:
                if k in ("__dict__", "__weakref__"):
                    continue
                if k.startswith("__") and not k.endswith("__"):
                    k = f"_{c.__name__.lstrip('_')}{k}"  # private-name mangling
                out.append(k)
        return out

    @staticmethod
    def _pandas_hash(pd: Any, obj: Any) -> str | None:
        try:
            return _digest(pd.util.hash_pandas_object(obj, index=True).to_numpy().tobytes())
        except Exception:
            return None  # unhashable cells: structural fingerprint only

    # -- summaries --------------------------------------------------------------------------

    def take_new_summaries(self) -> dict[str, dict[str, Any]]:
        new, self._new = self._new, {}
        return new

    def _put(self, token: str, summary: dict[str, Any]) -> None:
        self.values[token] = summary
        self._new[token] = summary

    def _with_preview(self, summary: dict[str, Any], preview: dict[str, Any] | None) -> None:
        if preview is None:
            return
        size = len(json.dumps(preview, separators=(",", ":"), ensure_ascii=False).encode())
        if self._preview_used + size > self.preview_bytes:
            return
        self._preview_used += size
        summary["preview"] = preview

    def summarize(self, token: str, obj: Any) -> None:
        self._summarize(token, obj, 0)

    def _summarize(self, token: str, obj: Any, depth: int) -> None:
        if token in self.values:
            return
        kind = self.classify(obj)
        if kind == "label":
            return
        # Minimal entry first: a BaseException from a student __repr__ (stop) must still leave
        # every issued token with a values entry.
        summary: dict[str, Any] = {"type": type(obj).__name__}
        self._put(token, summary)
        try:
            summary.update(self._summary(obj, kind))
        except Exception:
            pass
        if kind == "reference" and self.is_machine(obj):
            summary["machine"] = True
            try:
                attrs = self._machine_attrs(obj, depth) if depth == 0 else {}
            except Exception:
                attrs = {}
            if attrs:
                summary["attrs"] = attrs

    def _machine_attrs(self, obj: Any, depth: int) -> dict[str, str]:
        items: dict[str, Any] = {}
        base = _mod("sklearn.base")
        if base is not None and isinstance(obj, base.BaseEstimator):
            params = obj.get_params(deep=False)
            items.update((str(k), v) for k, v in params.items())
            for k, v in vars(obj).items():
                if k.endswith("_") and not k.startswith("_") and k not in params:
                    items[k] = v
        else:
            for k, v in vars(obj).items():
                if not k.startswith("_"):
                    items[k] = v
        out: dict[str, str] = {}
        for k in sorted(items)[:_MAX_ATTRS]:
            v = items[k]
            kind = self.classify(v)
            if kind == "label":
                continue
            tok = self.fresh_scalar(v) if kind == "scalar" else self.token(v)
            self._summarize(tok, v, depth + 1)
            out[k] = tok
        return out

    def _summary(self, obj: Any, kind: Kind) -> dict[str, Any]:
        t = type(obj)
        name = t.__name__
        if kind == "scalar":
            if t is tuple or t is frozenset:
                return {"type": f"{name}[{len(obj)}]", "repr": _repr(obj)}
            np = _mod("numpy")
            if np is not None and isinstance(obj, np.generic):
                return {"type": name, "repr": _cell(obj)}  # str(): "3", not "np.int64(3)"
            return {"type": "None" if obj is None else name, "repr": _repr(obj)}
        pd = _mod("pandas")
        np = _mod("numpy")
        if pd is not None and isinstance(obj, pd.DataFrame):
            return self._df_summary(obj)
        if pd is not None and isinstance(obj, pd.Series):
            return self._series_summary(obj)
        if np is not None and isinstance(obj, np.ndarray):
            s: dict[str, Any] = {"type": "array", "shape": list(obj.shape), "dtype": str(obj.dtype)}
            self._with_preview(s, {"kind": "matrix", "rows": self._array_rows(obj)})
            return s
        sp = _mod("scipy.sparse")
        if sp is not None and sp.issparse(obj):
            s = {"type": "sparse", "shape": list(obj.shape), "dtype": str(obj.dtype)}
            try:
                rows = self._array_rows(obj.tocsr()[:_MATRIX, :_MATRIX].toarray())
                self._with_preview(s, {"kind": "matrix", "rows": rows})
            except Exception:
                pass
            return s
        if t in (list, dict, tuple, set, frozenset):
            return {"type": f"{name}[{len(obj)}]", "repr": _repr(obj)}
        if self.is_machine(obj):
            return {"type": name}
        return {"type": name, "repr": _repr(obj)}

    @staticmethod
    def _array_rows(arr: Any) -> list[list[str]]:
        nd = arr.ndim
        if nd == 0:
            return [[_cell(arr[()])]]
        if nd == 1:
            return [[_cell(x) for x in arr[:_MATRIX]]]
        lead = (0,) * (nd - 2)
        sl = arr[(*lead, slice(_MATRIX), slice(_MATRIX))]
        return [[_cell(x) for x in row] for row in sl]

    def _df_summary(self, df: Any) -> dict[str, Any]:
        cols = [str(c) for c in df.columns[:_MAX_COLUMNS]]
        s: dict[str, Any] = {
            "type": "DF",
            "shape": [int(df.shape[0]), int(df.shape[1])],
            "columns": cols,
            "dtypes": [str(d) for d in df.dtypes[:_MAX_COLUMNS]],
        }
        head = df.iloc[:_PREVIEW_ROWS, :_PREVIEW_COLS]
        self._with_preview(
            s,
            {
                "kind": "table",
                "columns": [str(c) for c in head.columns],
                "index": [_cell(i) for i in head.index],
                "rows": [
                    [_cell(x) for x in row] for row in head.itertuples(index=False, name=None)
                ],
            },
        )
        return s

    def _series_summary(self, ser: Any) -> dict[str, Any]:
        s: dict[str, Any] = {
            "type": "Series",
            "shape": [int(ser.shape[0])],
            "dtype": str(ser.dtype),
        }
        head = ser.iloc[:_PREVIEW_ROWS]
        self._with_preview(
            s,
            {
                "kind": "table",
                "columns": ["" if ser.name is None else _cell(ser.name)],
                "index": [_cell(i) for i in head.index],
                "rows": [[_cell(x)] for x in head],
            },
        )
        return s
