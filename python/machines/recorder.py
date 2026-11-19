"""The recorder (CONTRACTS.md section 4): hooks, events, call filtering, caps and streaming.

The transformer rewrites student code so that every call, binding and store reaches one of three
hooks in ``builtins``. They dispatch to the one active ``Recorder``; with none active they behave
exactly like the code they replaced.

Design rules that matter for correctness:

* Transparency: every hook returns what the original expression returned and re-raises what it
  raised. Any internal error becomes a diagnostic, turns that hook into a pass-through, and never
  reaches the student.
* No false wires: reference values are matched by identity (``ValueTable``), scalars only through
  names (identity guard ``bound_obj is value``) or the recorded output of the call that made them.
* Warnings: a call goes through a per-site *trampoline*, a tiny function whose code is compiled
  with filename ``<student>`` and the site's line numbers, so ``warnings.warn`` (and pandas'
  ``find_stack_level``) blame the student's line and not this module, and the
  ``__warningregistry__`` lives in the student's globals as in plain Python.
  ``sys._getframe`` sees the trampoline (documented as unsupported in CONTRACTS section 3).
"""

from __future__ import annotations

import ast
import builtins
import inspect
import sys
import time
import types
import weakref
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, fields
from typing import Any

from .transform import HOOK_NAMES, _reads
from .values import ValueTable

__all__ = ["Recorder", "RunConfig", "install_hooks"]

_FLUSH_SECONDS = 0.1
_UNKNOWN: dict[str, Any] = {"origin": "unknown"}
_CONTAINER_TYPES = frozenset({str, list, dict, set, tuple, frozenset, bytes, bytearray})
_P = inspect.Parameter
_MESSAGE_MAX = 500
_BUILTINS_DICT = builtins.__dict__
_STRONG_PLANS = 512  # cache bound for callables that cannot be weakly referenced
_BIND_CAP_FACTOR = 4  # binding rows allowed per `max_events`


@dataclass
class RunConfig:
    draw_modules: list[str] = field(default_factory=lambda: ["sklearn", "pandas", "numpy"])
    draw_builtins: bool = False
    draw_container_methods: bool = False
    machine_classes: list[str] = field(default_factory=list)
    wall_ms: int = 30_000
    max_events: int = 5_000
    per_site: int = 20
    preview_bytes: int = 1_000_000
    hash_cells: int = 100_000

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> RunConfig:
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in (d or {}).items() if k in known})


# -- module-level hooks ----------------------------------------------------------------------

_active: Recorder | None = None


def _rec_hook(site: int, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    r = _active
    if r is None:
        return fn(*args, **kwargs)
    return r._rec(site, fn, args, kwargs, sys._getframe(1))


def _bind_hook(site: int, mapping: dict[str, Any], /) -> None:
    r = _active
    if r is not None:
        r._bind(site, mapping, sys._getframe(1))


def _store_hook(site: int, base: Any, /) -> None:
    r = _active
    if r is not None:
        r._store(site, base, sys._getframe(1))


def _import_hook(site: int, begin: bool = False, /) -> None:
    r = _active
    if r is not None:
        if begin:
            r._import_begin(site)
        else:
            r._import(site, sys._getframe(1))


def _scope_hook(fn: Callable[..., Any], /) -> Callable[..., Any]:
    return fn


def _ret_hook(site: int, value: Any, /) -> Any:
    return value


_HOOKS: tuple[Callable[..., Any], ...] = (
    _rec_hook,
    _bind_hook,
    _store_hook,
    _scope_hook,
    _ret_hook,
    _import_hook,
)


def install_hooks() -> None:
    """Put the hooks into builtins (idempotent). They pass through when no Recorder is active."""
    for name, hook in zip(HOOK_NAMES, _HOOKS, strict=True):
        setattr(builtins, name, hook)


# -- helpers ---------------------------------------------------------------------------------


def _clip(s: str, n: int = _MESSAGE_MAX) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _tramp_code(site: dict[str, Any]) -> types.CodeType:
    """The call `f(*a, **k)` (read from `__machines_rc__`) as an eval code object at its position.

    It runs with the *caller's* globals and locals (see `Recorder._call`), so the callee's immediate
    caller frame is the student's namespace: `df.query("a > @t")`, `sys._getframe(1).f_locals`
    and warnings blamed on a stack level all behave as in plain Python.
    """
    tree = ast.parse("__machines_rc__[0](*__machines_rc__[1], **__machines_rc__[2])", mode="eval")
    line = site.get("func_line", site["line"])  # the line CPython reports for the call
    end_line = site["end_line"]
    col, end_col = (site["col"], site["end_col"]) if line == site["line"] else (0, site["end_col"])
    if line == end_line and end_col < col:
        end_col = col
    for n in ast.walk(tree):
        if hasattr(n, "lineno"):
            n.lineno, n.end_lineno = line, end_line  # type: ignore[attr-defined]
            n.col_offset, n.end_col_offset = col, end_col  # type: ignore[attr-defined]
    return compile(tree, "<student>", "eval")


def _is_student_code(fn: Any) -> bool:
    for _ in range(8):
        code = getattr(fn, "__code__", None)
        if isinstance(code, types.CodeType):
            return code.co_filename == "<student>"
        nxt = getattr(fn, "__wrapped__", None)
        if nxt is None:
            return False
        fn = nxt
    return False


def _label_text(value: Any) -> str:
    for attr in ("__qualname__", "__name__"):
        v = getattr(value, attr, None)
        if isinstance(v, str):
            return v
    return type(value).__name__


class _Plan:
    """How to record one kind of callable. Cached per callable (see `Recorder._plan`)."""

    __slots__ = ("kind", "module", "name", "params", "sig_done", "student")

    def __init__(self, kind: str, name: str, module: str | None, student: bool) -> None:
        self.kind = kind
        self.name = name
        self.module = module
        self.student = student
        self.params: list[tuple[str, Any]] | None = None
        self.sig_done = False


class _Ctx:
    """A started recorded call (kept on the open stack until it finishes)."""

    __slots__ = (
        "count", "depth", "i", "inputs", "key", "kind", "module", "name", "owner", "owner_obj",
        "plan", "site", "slot", "targets", "unpack",
    )  # fmt: skip

    i: int
    site: int
    kind: str
    name: str
    module: str | None
    key: str
    count: int
    slot: bool
    depth: int
    owner: str | None
    owner_obj: Any
    inputs: list[dict[str, Any]]
    targets: list[Any]
    unpack: int | None
    plan: _Plan


@dataclass
class _SiteMeta:
    known_args: int
    owner: tuple[Any, ...] | None = None  # computed lazily for method calls


class Recorder:
    def __init__(
        self,
        sites: list[dict[str, Any]],
        config: RunConfig | dict[str, Any] | None,
        emit: Callable[[dict[str, Any]], None] | None = None,
        *,
        on_enter: Callable[[int, int], None] | None = None,
        on_exit: Callable[[int], None] | None = None,
        namespace: dict[str, Any] | None = None,
    ) -> None:
        self.sites = sites
        self.config = config if isinstance(config, RunConfig) else RunConfig.from_dict(config)
        self.emit = emit
        self.on_enter = on_enter
        self.on_exit = on_exit
        self.namespace = namespace  # the student's globals; taken from the first hook frame if None
        self.vt = ValueTable(
            self.config.preview_bytes, self.config.hash_cells, self.config.machine_classes
        )
        self._draw = frozenset(self.config.draw_modules)
        self._plans: weakref.WeakKeyDictionary[Any, dict[Any, _Plan | None]] = (
            weakref.WeakKeyDictionary()
        )
        self._strong: dict[Any, _Plan | None] = {}
        self._fresh_site: int | None = None  # site of the call that just finished
        self._chk: set[int] = set()  # ids fingerprinted in the current phase of a call
        self._codes: dict[tuple[int, str], types.CodeType] = {}
        self._meta: dict[int, _SiteMeta] = {}
        self._reads_cache: dict[str, list[str]] = {}
        self._reset_state()

    def _reset_state(self) -> None:
        self.vt.reset()
        self.current_event = -1
        self.commit_output: Callable[[], None] | None = None  # runtime seam (svl-wqe)
        self._import_mark: tuple[int, int] | None = None
        self.limit_hit = False
        self.diagnostics: list[str] = []
        self._events: list[dict[str, Any]] = []
        self._by_i: dict[int, dict[str, Any]] = {}  # the events in `_events`, by `i`
        self._slots: dict[str, dict[str, Any]] = {}
        self._consumed: set[str] = set()  # tokens already an input of some recorded event
        self._produced: set[str] = set()  # tokens that are the output of some recorded event
        self._bindings: list[list[Any]] = []  # [event, name, token, slot_key?]
        self._bslots: dict[str, list[Any]] = {}
        self._output: list[dict[str, Any]] = []
        self._pending_events: list[dict[str, Any]] = []
        self._pending_bindings: list[list[Any]] = []
        self._pending_output: list[dict[str, Any]] = []
        self._pending_diag = 0
        self._stack: list[_Ctx] = []
        self._open_sig: tuple[int, ...] = ()
        self._next_i = 0
        self._n_rec = 0
        self._n_bind = 0
        self._counts: dict[str, int] = {}
        self._bind_counts: dict[int, int] = {}
        self._names: dict[str, tuple[str, Any, bool]] = {}  # name -> (token, obj|weakref, is_ref)
        self._site_out: dict[int, list[tuple[Callable[[], Any], str | None]]] = {}
        self._unhandled: list[tuple[dict[str, Any], BaseException]] = []
        self._last_exc: BaseException | None = None
        self._off: set[str] = set()
        self._started = False
        self._last_flush = time.monotonic()

    # -- lifecycle ----------------------------------------------------------------------------

    @property
    def in_reentry(self) -> bool:
        return self.vt.in_reentry

    def install(self) -> None:
        global _active
        install_hooks()
        _active = self

    def uninstall(self) -> None:
        """Stop recording. The hooks stay in builtins and pass through."""
        global _active
        if _active is self:
            _active = None

    def add_output(self, entry: dict[str, Any]) -> None:
        """Runtime seam: one finished `OutputEntry` (tagged with `current_event` by the caller)."""
        self._output.append(entry)
        self._pending_output.append(entry)

    def current_line(self) -> int | None:
        """Student line of the innermost open recorded call (warning attribution), if any."""
        if self._stack:
            return int(self.sites[self._stack[-1].site]["line"])
        return None

    def final_status(self, status: str) -> str:
        return "limit" if status == "ok" and self.limit_hit else status

    # -- diagnostics --------------------------------------------------------------------------

    def _degrade(self, hook: str, exc: BaseException) -> None:
        self._off.add(hook)
        self.diagnostics.append(f"{hook}: {type(exc).__name__}: {_clip(str(exc), 200)}")

    # -- plans (call filtering) ---------------------------------------------------------------

    def _plan(self, fn: Any) -> _Plan | None:
        """The cached decision for a callable. The cache never keeps callables alive."""
        t = type(fn)
        sub: Any = None
        try:
            if t is types.MethodType:
                s = fn.__self__
                owner_key: Any = fn.__func__
                sub = "cm" if isinstance(s, type) else type(s)
            elif (t is types.BuiltinFunctionType or t is types.BuiltinMethodType) and _is_instance(
                getattr(fn, "__self__", None)
            ):
                owner_key = type(fn.__self__)
                sub = getattr(fn, "__name__", None)
            else:
                owner_key = fn
            try:
                slot = self._plans.get(owner_key)
                if slot is None:
                    slot = self._plans[owner_key] = {}
            except TypeError:  # not weakly referenceable (or unhashable): bounded strong cache
                key = (owner_key, sub)
                hash(key)
                if len(self._strong) > _STRONG_PLANS:
                    self._strong.clear()
                try:
                    return self._strong[key]
                except KeyError:
                    plan = self._strong[key] = self._decide(fn)
                    return plan
        except TypeError:
            return self._decide(fn)
        try:
            return slot[sub]
        except KeyError:
            plan = slot[sub] = self._decide(fn)
            return plan

    def _decide(self, fn: Any) -> _Plan | None:
        cfg = self.config
        t = type(fn)
        owner_type: type | None = None
        if t is types.MethodType and not isinstance(fn.__self__, type):
            owner_type = type(fn.__self__)
        elif t is types.BuiltinFunctionType or t is types.BuiltinMethodType:
            s = getattr(fn, "__self__", None)
            if _is_instance(s):
                owner_type = type(s)
        name = getattr(fn, "__qualname__", None) or getattr(fn, "__name__", None)
        if not isinstance(name, str):
            name = type(fn).__qualname__
        if owner_type is not None:
            student = owner_type.__module__ == "__main__" or _is_student_code(fn)
            module = getattr(fn, "__module__", None)
            if not isinstance(module, str):
                module = owner_type.__module__
            name = f"{owner_type.__qualname__}.{getattr(fn, '__name__', name)}"
            if student:
                return _Plan("method", name, module, True)
            om = owner_type.__module__ or ""
            if om == "builtins":
                ok = (
                    cfg.draw_container_methods
                    if owner_type in _CONTAINER_TYPES
                    else cfg.draw_builtins
                )
            else:
                ok = om.partition(".")[0] in self._draw
            return _Plan("method", name, om if om else module, False) if ok else None
        module = getattr(fn, "__module__", None)
        if not isinstance(module, str):
            module = type(fn).__module__
        if isinstance(fn, type):
            student = module == "__main__"
            kind = "constructor"
        elif _is_student_code(fn):
            student, kind = True, "student_function"
        else:
            student, kind = False, "function"
        if student:
            return _Plan(kind, name, module, True)
        if module == "builtins":
            ok = cfg.draw_builtins
        else:
            ok = module.partition(".")[0] in self._draw
        return _Plan(kind, name, module, False) if ok else None

    def _params(self, plan: _Plan, fn: Any) -> list[tuple[str, Any]] | None:
        if not plan.sig_done:
            plan.sig_done = True
            try:
                plan.params = [(n, p.kind) for n, p in inspect.signature(fn).parameters.items()]
            except Exception:
                plan.params = None
        return plan.params

    # -- hook entry points --------------------------------------------------------------------

    def _call(self, site: int, fn: Any, args: Any, kwargs: Any, frame: types.FrameType) -> Any:
        """Make the call from a `<student>` frame that shares the caller's namespace.

        The callee's immediate caller is then an eval frame whose globals and locals are the
        student's own (at module level `f_locals is f_globals`), at the call's reported line.
        """
        try:
            fc = frame.f_code
            key = (
                site,
                fc.co_qualname,
            )  # the frame is named like the caller's (`C` in a class body)
            code = self._codes.get(key)
            if code is None:
                code = self._codes[key] = _tramp_code(self.sites[site]).replace(
                    co_name=fc.co_name, co_qualname=fc.co_qualname
                )
            g = frame.f_globals
            loc = frame.f_locals
        except Exception as e:  # noqa: BLE001
            self._degrade("trampoline", e)
            return fn(*args, **kwargs)
        bdict = _BUILTINS_DICT
        bdict["__machines_rc__"] = (fn, args, kwargs)
        try:
            return eval(code, g) if loc is g else eval(code, g, loc)  # noqa: S307
        finally:
            bdict["__machines_rc__"] = None

    def _tick(self) -> None:
        """Common hook entry: continuing code means an earlier exception was caught."""
        if self._unhandled:
            # An exception still being handled (an except block, or a finally block while it
            # propagates) is undecided: a call there does not show it was caught. It is settled
            # by a later hook outside the block, or by close_open().
            live = sys.exc_info()[1]
            keep = []
            for ev, ev_exc in self._unhandled:
                if ev_exc is live:
                    keep.append((ev, ev_exc))
                else:
                    self._settle(ev)
            self._unhandled[:] = keep
        if time.monotonic() - self._last_flush >= _FLUSH_SECONDS:
            self.flush()

    def _rec(self, site: int, fn: Any, args: Any, kwargs: Any, frame: types.FrameType) -> Any:
        self._site_out.pop(site, None)  # a result from an earlier execution is not this one's
        if self.vt.in_reentry or self.limit_hit or "rec" in self._off:
            return self._call(site, fn, args, kwargs, frame)
        if self.namespace is None:
            self.namespace = frame.f_globals
        depth = len(self._stack)
        ctx: _Ctx | None = None
        try:
            self._tick()
            plan = self._plan(fn)
            if plan is not None:
                ctx = self._start(site, fn, args, kwargs, plan, depth)
        except Exception as e:  # noqa: BLE001
            del self._stack[depth:]
            ctx = None
            self._degrade("rec", e)
        if ctx is None:
            return self._call(site, fn, args, kwargs, frame)
        try:
            result = self._call(site, fn, args, kwargs, frame)
        except BaseException as exc:
            if isinstance(exc, Exception):
                try:
                    self._finish_error(ctx, exc)
                except Exception as e:  # noqa: BLE001
                    del self._stack[depth:]
                    self._degrade("rec", e)
            # KeyboardInterrupt and friends: leave the call open for close_open()
            raise
        try:
            self._finish(ctx, fn, result)
        except Exception as e:  # noqa: BLE001
            del self._stack[depth:]
            self._degrade("rec", e)
        return result

    # -- starting a call ----------------------------------------------------------------------

    def _meta_for(self, site: int) -> _SiteMeta:
        m = self._meta.get(site)
        if m is None:
            args = self.sites[site].get("args") or []
            known = next((k for k, o in enumerate(args) if o["origin"] == "unknown"), len(args))
            m = self._meta[site] = _SiteMeta(known)
        return m

    def _alloc(self, key: str, counts: bool = True) -> tuple[int, int, bool] | None:
        if counts:
            if self._n_rec >= self.config.max_events:
                self.limit_hit = True
                return None
            self._n_rec += 1
        i = self._next_i
        self._next_i += 1
        self.current_event = i
        c = self._counts.get(key, 0) + 1
        self._counts[key] = c
        return i, c, c > self.config.per_site

    def _start(
        self, site: int, fn: Any, args: Any, kwargs: Any, plan: _Plan, depth: int
    ) -> _Ctx | None:
        vt = self.vt
        prev = vt.in_reentry
        vt.in_reentry = True
        try:
            info = self.sites[site]
            key = f"s{site}"
            self._chk = set()
            self._fresh_site = None
            owner_obj: Any = None
            owner_tok: str | None = None
            inputs: list[dict[str, Any]] = []
            has_owner = plan.kind == "method"
            if has_owner:
                owner_obj = fn.__self__
                machine = vt.classify(owner_obj) == "reference" and vt.is_machine(owner_obj)
                if machine:
                    self._check(owner_obj)
                    owner_tok = vt.token(owner_obj)
                    vt.summarize(owner_tok, owner_obj)
                else:
                    self_in = self._owner_input(site, info, owner_obj)
                    inputs.append(self_in)
                    owner_tok = self_in.get("value")
            for param, value, ref in self._labelled(plan, fn, args, kwargs):
                o = self._origin(site, info, ref)
                inputs.append(self._input(param, o, value, site, _expr_key(site, ref)))
            alloc = self._alloc(key)
            if alloc is None:
                return None
            ctx = _Ctx()
            ctx.i, ctx.count, ctx.slot = alloc
            ctx.site, ctx.kind, ctx.name, ctx.module = site, plan.kind, plan.name, plan.module
            ctx.key, ctx.depth, ctx.plan = key, depth, plan
            ctx.owner, ctx.owner_obj, ctx.inputs = owner_tok, owner_obj, inputs
            ctx.unpack = info.get("unpack")
            ctx.targets = self._watch_targets(owner_obj, args, kwargs)
            self._stack.append(ctx)
        finally:
            vt.in_reentry = prev
        self._maybe_flush()
        if self.on_enter is not None:
            self.on_enter(ctx.i, site)
        return ctx

    def _maybe_flush(self) -> None:
        if time.monotonic() - self._last_flush >= _FLUSH_SECONDS:
            self.flush()

    def _labelled(
        self, plan: _Plan, fn: Any, args: Any, kwargs: Any
    ) -> list[tuple[str, Any, int | str]]:
        """(param name, value, positional index or keyword name) for each argument passed."""
        params = self._params(plan, fn)
        out: list[tuple[str, Any, int | str]] = []
        npos = len(args)
        if params is None:
            out.extend((f"arg{j}", a, j) for j, a in enumerate(args))
            out.extend((k, v, k) for k, v in kwargs.items())
            return out
        idx = 0
        named: set[str] = set()
        has_var_kw = False
        for name, kind in params:
            if kind is _P.POSITIONAL_ONLY or kind is _P.POSITIONAL_OR_KEYWORD:
                if kind is _P.POSITIONAL_OR_KEYWORD:
                    named.add(name)
                if idx < npos:
                    out.append((name, args[idx], idx))
                    idx += 1
                elif name in kwargs and kind is _P.POSITIONAL_OR_KEYWORD:
                    out.append((name, kwargs[name], name))
            elif kind is _P.VAR_POSITIONAL:
                base = idx
                for j in range(base, npos):
                    out.append((f"{name}[{j - base}]", args[j], j))
                idx = npos
            elif kind is _P.KEYWORD_ONLY:
                named.add(name)
                if name in kwargs:
                    out.append((name, kwargs[name], name))
            else:
                has_var_kw = True
        for j in range(idx, npos):  # more positionals than the signature takes: the call fails
            out.append((f"arg{j}", args[j], j))
        if has_var_kw or any(k not in named for k in kwargs):
            taken = {n for n, _ in params}  # a **kw key equal to a positional-only name
            var_kw = next((n for n, k in params if k is _P.VAR_KEYWORD), "kwargs")
            out.extend(
                (f"{var_kw}[{k}]" if k in taken else k, v, k)
                for k, v in kwargs.items()
                if k not in named
            )
        return out

    def _origin(self, site: int, info: dict[str, Any], ref: int | str) -> dict[str, Any]:
        if isinstance(ref, int):
            args = info.get("args") or []
            return args[ref] if ref < self._meta_for(site).known_args else _UNKNOWN
        return (info.get("keywords") or {}).get(ref, _UNKNOWN)

    def _owner_input(self, site: int, info: dict[str, Any], owner: Any) -> dict[str, Any]:
        """The `self` input of a method on data. Its expression is the callee minus the method."""
        meta = self._meta_for(site)
        if meta.owner is None:
            meta.owner = _owner_expr(info.get("func_text") or "", self._reads_of)
        kind, text, reads = meta.owner
        if kind == "name":
            o: dict[str, Any] = {"origin": "name", "name": text}
        elif kind == "expr":
            o = {"origin": "expr", "text": text, "reads": reads}
        else:
            o = _UNKNOWN
        return self._input("self", o, owner, site, f"s{site}.self")

    def _reads_of(self, text: str) -> list[str]:
        r = self._reads_cache.get(text)
        if r is None:
            try:
                r = _reads(ast.parse(text, mode="eval"))
            except SyntaxError:
                r = []
            self._reads_cache[text] = r
        return r

    # -- inputs and expression events ---------------------------------------------------------

    def _input(
        self, param: str, o: dict[str, Any], value: Any, ex_site: int, ex_key: str
    ) -> dict[str, Any]:
        vt = self.vt
        kind = o["origin"]
        inp: dict[str, Any] = {"param": param, "origin": kind}
        cls = vt.classify(value)
        if cls == "label":
            inp["text"] = _label_text(value)
            return inp
        if kind == "const":
            inp["text"] = o["text"]
            return inp
        if cls == "scalar":
            tok = self._scalar_token(o, value, ex_site, ex_key)
        else:
            tok = self._ref_token(o, value, ex_site, ex_key)
        inp["value"] = tok
        return inp

    def _scalar_token(self, o: dict[str, Any], value: Any, ex_site: int, ex_key: str) -> str:
        vt = self.vt
        kind = o["origin"]
        if kind == "name":
            rec = self._names.get(o["name"])
            if rec is not None and not rec[2] and rec[1] is value:
                tok = rec[0]
            else:
                tok = vt.fresh_scalar(value)
                self._names[o["name"]] = (tok, value, False)
        elif kind == "call":
            tok = self._out_token(o["site"], value) or self._hidden_call(o["site"], value)
        elif kind == "expr":
            tok = self._expr_event(
                ex_site, ex_key, o["text"], o["reads"], value, (), calls=o.get("calls", ())
            )
        else:
            tok = vt.fresh_scalar(value)
        vt.summarize(tok, value)
        return tok

    def _ref_token(self, o: dict[str, Any], value: Any, ex_site: int, ex_key: str) -> str:
        vt = self.vt
        kind = o["origin"]
        if kind == "expr" and not vt.seen(value):
            return self._expr_event(
                ex_site, ex_key, o["text"], o["reads"], value, (), calls=o.get("calls", ())
            )
        if kind == "call" and not vt.seen(value) and self._out_token(o["site"], value) is None:
            return self._hidden_call(o["site"], value)
        self._check(value)
        tok = vt.token(value)
        vt.summarize(tok, value)
        return tok

    def _check(self, obj: Any) -> tuple[str, str] | None:
        """`vt.check`, at most once per phase of a call (fingerprints can be expensive)."""
        if id(obj) in self._chk:
            return None
        self._chk.add(id(obj))
        return self.vt.check(obj)

    def _out_token(self, site: int, value: Any, pos: int | None = None) -> str | None:
        outs = self._site_out.get(site)
        if not outs:
            return None
        if pos is not None and pos < len(outs) and outs[pos][0]() is value:
            return outs[pos][1]
        for o, t in outs:
            if o() is value:
                return t
        return None

    def _hidden_call(self, inner: int, value: Any) -> str:
        """A `call` origin the recorder did not record (hidden): an expression event instead."""
        text = self.sites[inner]["text"]
        # hidden calls never count against the event cap (SPEC "Call filtering")
        return self._expr_event(inner, f"s{inner}", text, self._reads_of(text), value, (), False)

    def _read_inputs(
        self, reads: list[str], rebound: Any, strict: bool = False
    ) -> list[dict[str, Any]]:
        """Tokens currently held by the names an expression reads (CONTRACTS section 5).

        `rebound` are names the statement just assigned: their *previous* binding is what the
        expression read, since the namespace already holds the new value.
        """
        vt = self.vt
        ns = self.namespace or {}
        out: list[dict[str, Any]] = []
        for name in reads:
            rec = self._names.get(name)
            if name in rebound:
                if rec is None:
                    continue
                tok = rec[0]
                if rec[2]:
                    obj = rec[1]()
                    if obj is None:
                        continue
                    tok = vt.token(obj) if vt.seen(obj) else tok
            else:
                if name not in ns:
                    continue
                obj = ns[name]
                cls = vt.classify(obj)
                if cls == "label":
                    continue
                if cls == "scalar":
                    if rec is None or rec[2] or rec[1] is not obj:
                        continue
                    tok = rec[0]
                else:
                    if strict and (rec is None or rec[1]() is not obj):
                        continue  # rebound since its last bind (a call in the statement did it)
                    self._check(obj)
                    tok = vt.token(obj)
                    vt.summarize(tok, obj)
            out.append({"param": name, "origin": "name", "value": tok})
        return out

    def _rebound_unseen(self, name: str, ns: dict[str, Any]) -> bool:
        """A reference name whose object is not the one its last `__bind__` recorded."""
        rec = self._names.get(name)
        obj = ns[name]
        return (
            rec is not None
            and rec[2]
            and rec[1]() is not obj
            and self.vt.classify(obj) == "reference"
        )

    def _call_inputs(
        self, calls: Sequence[int], have: list[dict[str, Any]], fmt: str = "{}"
    ) -> list[dict[str, Any]]:
        """Outputs of the calls an expression contains (`calls` of an `expr` origin).

        The transformer lists only unconditional, outermost, wrapped calls of the expression, so
        each ran exactly once while the expression was evaluated. A call with no recorded single
        output (hidden, failed, tuple result) gives nothing: a missing wire, never a false one.
        """
        out: list[dict[str, Any]] = []
        # A second call with the same `func_text` (`[StandardScaler(), StandardScaler()]`) is
        # dropped on purpose by the `param` check below: a missing wire, never a false one.
        for c in calls:
            outs = self._site_out.get(c)  # reset at the start of every execution of the site
            if not outs or len(outs) != 1 or outs[0][1] is None:
                continue
            param = fmt.format(self.sites[c].get("func_text") or self.sites[c]["text"])
            if any(i["param"] == param for i in (*have, *out)):
                continue
            out.append({"param": param, "origin": "call", "value": outs[0][1]})
        return out

    def _expr_event(
        self,
        site: int,
        key: str,
        text: str,
        reads: list[str],
        value: Any,
        rebound: Any,
        counts: bool = True,
        reuse: str | None = None,
        calls: Sequence[int] = (),
    ) -> str:
        vt = self.vt
        scalar = vt.classify(value) == "scalar"
        inputs = self._read_inputs(reads, rebound)
        inputs.extend(self._call_inputs(calls, inputs))
        if reuse is not None and not inputs:
            return reuse  # nothing to draw a wire from: the token stays a source
        tok = reuse or (vt.fresh_scalar(value) if scalar else vt.token(value))
        self._chk.add(id(value))  # first sight: the baseline fingerprint was just taken
        alloc = self._alloc(key, counts)
        if alloc is None:
            return tok
        vt.summarize(tok, value)
        i, count, slot = alloc
        self._add_event(
            {
                "i": i,
                "ret": i,
                "site": site,
                "scope": 0,
                "kind": "expr",
                "name": text,
                "module": None,
                "owner": None,
                "inputs": inputs,
                "outputs": [tok],
                "returns_self": False,
                "mutates": [],
                "count": count,
                **({"slot": True} if slot else {}),
                "merge_key": key,
                "error": None,
            }
        )
        return tok

    # -- finishing a call ---------------------------------------------------------------------

    def _watch_targets(self, owner: Any, args: Any, kwargs: Any) -> list[Any]:
        """Objects whose version may change in the call: owner, inputs, reachable estimators."""
        vt = self.vt
        seen: set[int] = set()
        out: list[Any] = []
        cands = [owner, *args, *kwargs.values()]
        base = sys.modules.get("sklearn.base")
        est = base.BaseEstimator if base is not None else None
        extra: list[Any] = []
        for c in cands:
            if c is None or vt.classify(c) != "reference" or id(c) in seen:
                continue
            seen.add(id(c))
            out.append(c)
            if est is not None and isinstance(c, est):
                try:
                    for v in c.get_params(deep=True).values():
                        if isinstance(v, est) and id(v) not in seen:
                            seen.add(id(v))
                            extra.append(v)
                except Exception:  # noqa: BLE001, S110
                    pass
        out.extend(extra)
        for o in out:  # baseline before the call (first sight) and unblamed changes
            self._check(o)
        return out

    def _mutations(self, ctx: _Ctx) -> list[list[str]]:
        vt = self.vt
        out: list[list[str]] = []
        self._chk = set()  # a new phase: what the call did to its inputs
        for o in ctx.targets:
            self._chk.add(id(o))
            ch = vt.check(o)
            if ch is not None:
                vt.summarize(ch[1], o)
                out.append([ch[0], ch[1]])
        return out

    def _finish(self, ctx: _Ctx, fn: Any, result: Any) -> None:
        vt = self.vt
        prev = vt.in_reentry
        vt.in_reentry = True
        try:
            mutates = self._mutations(ctx)
            outputs: list[str] = []
            owner = ctx.owner_obj
            returns_self = (
                owner is not None and result is owner and vt.classify(owner) == "reference"
            )
            outs: list[tuple[Callable[[], Any], str | None]] = []
            if not returns_self:
                if (
                    ctx.unpack is not None
                    and isinstance(result, tuple | list)
                    and len(result) == ctx.unpack
                ):
                    items = list(result)
                else:
                    items = [result]
                for item in items:
                    tok = self._output_token(item)
                    outs.append((_getter(item), tok))
                    if tok is not None:
                        outputs.append(tok)
            else:
                outs.append((_getter(result), vt.token(owner)))
            self._site_out[ctx.site] = outs
            del self._stack[ctx.depth :]
            self._add_event(
                {
                    "i": ctx.i,
                    "ret": self._next_i - 1,
                    "site": ctx.site,
                    "scope": 0,
                    "kind": ctx.kind,
                    "name": ctx.name,
                    "module": ctx.module,
                    "owner": ctx.owner,
                    "inputs": ctx.inputs,
                    "outputs": outputs,
                    "returns_self": returns_self,
                    "mutates": mutates,
                    "count": ctx.count,
                    **({"slot": True} if ctx.slot else {}),
                    "merge_key": ctx.key,
                    "error": None,
                }
            )
        finally:
            vt.in_reentry = prev
        self._fresh_site = ctx.site
        if self.on_exit is not None:
            self.on_exit(ctx.i)

    def _output_token(self, item: Any) -> str | None:
        vt = self.vt
        cls = vt.classify(item)
        if item is None or cls == "label":
            return None
        if cls == "scalar":
            tok = vt.fresh_scalar(item)
        else:
            self._check(item)
            tok = vt.token(item)
        vt.summarize(tok, item)
        return tok

    def _finish_error(self, ctx: _Ctx, exc: Exception) -> None:
        vt = self.vt
        prev = vt.in_reentry
        vt.in_reentry = True
        try:
            mutates = self._mutations(ctx)  # a failed call may still have changed its inputs
            propagated = exc is self._last_exc
            self._last_exc = exc
            try:
                message = _clip(str(exc))
            except Exception:  # noqa: BLE001
                message = ""
            err: dict[str, Any] = {"type": type(exc).__name__, "message": message, "handled": False}
            if propagated:
                err["propagated"] = True
            ev = {
                "i": ctx.i,
                "ret": self._next_i - 1,
                "site": ctx.site,
                "scope": 0,
                "kind": ctx.kind,
                "name": ctx.name,
                "module": ctx.module,
                "owner": ctx.owner,
                "inputs": ctx.inputs,
                "outputs": [],
                "returns_self": False,
                "mutates": mutates,
                "count": ctx.count,
                **({"slot": True} if ctx.slot else {}),
                "merge_key": ctx.key,
                "error": err,
            }
            del self._stack[ctx.depth :]
            self._add_event(ev)
            self._unhandled.append((ev, exc))
        finally:
            vt.in_reentry = prev
        if self.on_exit is not None:
            self.on_exit(ctx.i)

    def _settle(self, ev: dict[str, Any]) -> None:
        """The error of `ev` was caught. An event already streamed is sent again (same `i`), so
        the assembled log says `handled: true` too."""
        ev["error"]["handled"] = True
        if self._by_i.get(ev["i"]) is ev and not any(p is ev for p in self._pending_events):
            self._pending_events.append(ev)

    def _add_event(self, ev: dict[str, Any]) -> None:
        if ev.get("slot"):
            old = self._slots.get(ev["merge_key"])
            if old is not None and old["i"] > ev["i"]:
                return
            if old is not None:
                self._events = [e for e in self._events if e is not old]
                self._by_i.pop(old["i"], None)
            self._slots[ev["merge_key"]] = ev
        self._consumed.update(i["value"] for i in ev["inputs"] if "value" in i)
        self._produced.update(ev["outputs"])
        self._produced.update(m[1] for m in ev["mutates"])
        self._events.append(ev)
        self._by_i[ev["i"]] = ev
        self._pending_events.append(ev)

    # -- bindings -----------------------------------------------------------------------------

    def _bind(self, site: int, mapping: dict[str, Any], frame: types.FrameType) -> None:
        if self.vt.in_reentry or self.limit_hit or "bind" in self._off:
            return
        if self.namespace is None:
            self.namespace = frame.f_globals
        vt = self.vt
        prev = vt.in_reentry
        vt.in_reentry = True
        try:
            self._tick()
            self._bind_inner(site, mapping)
        except Exception as e:  # noqa: BLE001
            self._degrade("bind", e)
        finally:
            vt.in_reentry = prev

    def _bind_inner(self, site: int, mapping: dict[str, Any]) -> None:
        vt = self.vt
        info = self.sites[site]
        o = info.get("value")
        # `x = f(...)`: the call just fingerprinted its outputs, nothing ran since
        if not (o is not None and o["origin"] == "call" and o["site"] == self._fresh_site):
            self._chk = set()
        self._fresh_site = None
        targets: list[str] = info.get("targets") or list(mapping)
        rebound = frozenset(mapping)
        rows: list[tuple[str, str | None]] = []
        new_names: list[tuple[str, tuple[str, Any, bool] | None]] = []
        for name, obj in mapping.items():
            cls = vt.classify(obj)
            if cls == "label":
                rows.append((name, None))
                new_names.append((name, None))
                continue
            tok = self._bind_token(site, info, o, name, obj, cls, targets, rebound)
            vt.summarize(tok, obj)
            rows.append((name, tok))
            if cls == "scalar":
                new_names.append((name, (tok, obj, False)))
            else:
                new_names.append((name, (tok, _getter(obj), True)))
        for name, rec in new_names:
            if rec is None:
                self._names.pop(name, None)
            else:
                self._names[name] = rec
        self._n_bind += len(rows)
        if self._n_bind > _BIND_CAP_FACTOR * self.config.max_events:
            self.limit_hit = True  # bindings are not events, but a loop must not grow the log
        n = self._bind_counts.get(site, 0) + 1
        self._bind_counts[site] = n
        slot = n > self.config.per_site
        ev = self._next_i - 1
        for name, tok in rows:
            if tok is None:
                continue
            row: list[Any] = [ev, name, tok]
            if slot:
                row.append(f"b{site}.{name}")
                self._bslots[row[3]] = row
            self._bindings.append(row)
            self._pending_bindings.append([0, *row])

    def _bind_token(
        self,
        site: int,
        info: dict[str, Any],
        o: dict[str, Any] | None,
        name: str,
        obj: Any,
        cls: str,
        targets: list[str],
        rebound: frozenset[str],
    ) -> str:
        vt = self.vt
        kind = o["origin"] if o is not None else None
        key = f"s{site}"
        if cls == "scalar":
            if kind == "name":
                rec = self._names.get(o["name"])  # type: ignore[index]
                if rec is not None and not rec[2] and rec[1] is obj:
                    return rec[0]
            elif kind == "call":
                pos = targets.index(name) if name in targets else None
                inner = o["site"]  # type: ignore[index]
                if not self.sites[inner].get("unpack"):
                    pos = None
                tok = self._out_token(inner, obj, pos)
                return tok if tok is not None else self._hidden_call(inner, obj)
            elif kind == "expr":
                return self._expr_event(
                    site, key, o["text"], o["reads"], obj, rebound, calls=o.get("calls", ())
                )  # type: ignore[index]
            return vt.fresh_scalar(obj)
        # references
        if kind == "expr":
            if not vt.seen(obj):
                return self._expr_event(
                    site, key, o["text"], o["reads"], obj, rebound, calls=o.get("calls", ())
                )  # type: ignore[index]
            if name not in o["reads"] and _is_attr_chain(o["text"]):  # type: ignore[index]
                # `coefs = model.coef_`: the object already has a token (the machine's summary)
                # but no producer; show the read as an expression that outputs that same token
                self._check(obj)
                tok = vt.token(obj)
                if tok not in self._produced and tok not in self._consumed:
                    return self._expr_event(
                        site,
                        key,
                        o["text"],
                        o["reads"],
                        obj,
                        rebound,
                        reuse=tok,  # type: ignore[index]
                        calls=o.get("calls", ()),  # type: ignore[union-attr]
                    )
            if name in o["reads"]:  # type: ignore[index]
                before = vt.token(obj)
                ch = vt.check(obj)
                if ch is not None:  # augmented assignment changed the object in place
                    vt.summarize(ch[1], obj)
                    self._inplace_event(site, key, o, rebound, ch)  # type: ignore[arg-type]
                    return ch[1]
                return before
        elif kind == "call":
            inner = o["site"]  # type: ignore[index]
            if not vt.seen(obj) and self._out_token(inner, obj) is None:
                return self._hidden_call(inner, obj)
        self._check(obj)
        return vt.token(obj)

    def _inplace_event(
        self,
        site: int,
        key: str,
        o: dict[str, Any],
        rebound: frozenset[str],
        ch: tuple[str, str],
    ) -> None:
        alloc = self._alloc(key)
        if alloc is None:
            return
        i, count, slot = alloc
        self._add_event(
            {
                "i": i,
                "ret": i,
                "site": site,
                "scope": 0,
                "kind": "expr",
                "name": o["text"],
                "module": None,
                "owner": None,
                "inputs": self._read_inputs(o["reads"], rebound),
                "outputs": [],
                "returns_self": False,
                "mutates": [[ch[0], ch[1]]],
                "count": count,
                **({"slot": True} if slot else {}),
                "merge_key": key,
                "error": None,
            }
        )

    # -- stores -------------------------------------------------------------------------------

    def _store(self, site: int, base: Any, frame: types.FrameType) -> None:
        if self.vt.in_reentry or self.limit_hit or "store" in self._off:
            return
        if self.namespace is None:
            self.namespace = frame.f_globals
        vt = self.vt
        prev = vt.in_reentry
        vt.in_reentry = True
        try:
            self._tick()
            self._store_inner(site, base)
        except Exception as e:  # noqa: BLE001
            self._degrade("store", e)
        finally:
            vt.in_reentry = prev

    def _store_inner(self, site: int, base: Any) -> None:
        vt = self.vt
        self._chk = set()
        if vt.classify(base) != "reference":
            return
        info = self.sites[site]
        root = info.get("root") or "target"
        before_tok = vt.token(base)  # the version the store started from
        inputs: list[dict[str, Any]] = [{"param": "target", "origin": "name", "value": before_tok}]
        vt.summarize(before_tok, base)
        o = info.get("value")
        if o is not None:
            kind = o["origin"]
            if kind == "expr":
                # the RHS object is not passed to the hook: wire the names it reads instead
                for r in self._read_inputs(o["reads"], frozenset({root}), True):
                    inputs.append({**r, "param": f"value[{r['param']}]", "origin": "expr"})
                inputs.extend(self._call_inputs(o.get("calls", ()), inputs, "value[{}]"))
            elif kind == "call":
                # the call's output is usually already freed (a temporary): use the token that was
                # issued for it, which cannot be a false wire (a `call` origin is static)
                out = self._site_out.get(o["site"])
                if out and out[0][1] is not None:
                    inputs.append({"param": "value", "origin": "call", "value": out[0][1]})
            else:
                ns = self.namespace or {}
                if kind == "name" and o["name"] in ns and not self._rebound_unseen(o["name"], ns):
                    inputs.append(self._input("value", o, ns[o["name"]], site, f"s{site}.value"))
                elif kind == "const":
                    inputs.append({"param": "value", "origin": "const", "text": o["text"]})
        # Index operands (`mask` in `df.loc[mask, "c"] = 0`): the hook gets only the root, so wire
        # what the operand reads, or the output of a call in it. The root itself is the target.
        for io in info.get("index") or ():
            kind = io["origin"]
            reads = [io["name"]] if kind == "name" else io.get("reads", [])
            have = {inp["param"] for inp in inputs}
            for r in self._read_inputs([n for n in reads if n != root], frozenset(), True):
                param = f"index[{r['param']}]"
                if param not in have:
                    inputs.append({**r, "param": param, "origin": kind})
            calls = [io["site"]] if kind == "call" else io.get("calls", ())
            inputs.extend(self._call_inputs(calls, inputs, "index[{}]"))
        alloc = self._alloc(f"s{site}")
        if alloc is None:
            return
        i, count, slot = alloc
        _, after = vt.bump(base)
        vt.summarize(after, base)
        self._add_event(
            {
                "i": i,
                "ret": i,
                "site": site,
                "scope": 0,
                "kind": "store",
                "name": info["text"],
                "module": None,
                "owner": None,
                "inputs": inputs,
                "outputs": [after],
                "returns_self": False,
                "mutates": [],
                "count": count,
                **({"slot": True} if slot else {}),
                "merge_key": f"s{site}",
                "error": None,
            }
        )

    # -- imports ------------------------------------------------------------------------------

    def _import_begin(self, site: int) -> None:
        """Before an import statement: remember where its output starts (svl-wqe).

        Text printed while the import runs is tagged with the previous event, since the import's
        own event does not exist yet. Text pending in the runtime is committed first, so the
        import's output starts a new entry; `_import` retags what was added after this mark. A
        failed import never reaches `_import`, so its output keeps the previous tag.
        Does nothing where `_import` would record no event (past `per_site` or `max_events`, or
        recording is off), so it does not split merged output.
        """
        self._import_mark = None
        if (
            self.vt.in_reentry
            or self.limit_hit
            or "import" in self._off
            or self._n_rec >= self.config.max_events
            or self._counts.get(f"s{site}", 0) >= self.config.per_site
        ):
            return
        if self.commit_output is not None:
            self.commit_output()
        self._import_mark = (len(self._output), self.current_event)

    def _retag_import_output(self, i: int) -> None:
        mark, self._import_mark = self._import_mark, None
        if mark is None:
            return
        if self.commit_output is not None:
            self.commit_output()
        start, old = mark
        for entry in self._output[start:]:
            if entry["i"] == old:
                entry["i"] = i

    def _import(self, site: int, frame: types.FrameType) -> None:
        """An import statement ran (the hook follows it): one `import` event, a timeline step.

        No values, no tokens: the event only says the statement at `site` ran, so nothing here can
        touch the student's objects. It counts toward `max_events` like any other event.
        """
        if self.vt.in_reentry or self.limit_hit or "import" in self._off:
            return
        if self.namespace is None:
            self.namespace = frame.f_globals
        try:
            self._tick()
            key = f"s{site}"
            if self._counts.get(key, 0) >= self.config.per_site:
                return  # a loop's later runs: no event, no budget (as for hidden calls)
            alloc = self._alloc(key)
            if alloc is None:
                return
            i, count, slot = alloc
            self._retag_import_output(i)
            is_def = self.sites[site]["kind"] == "def"
            subs = [] if is_def else self._submodules(site, frame)
            self._add_event(
                {
                    "i": i,
                    "ret": i,
                    "site": site,
                    "scope": 0,
                    "kind": "def" if is_def else "import",
                    "name": self.sites[site]["def"]["name"] if is_def else self.sites[site]["text"],
                    "module": None,
                    "owner": None,
                    "inputs": [],
                    "outputs": [],
                    "returns_self": False,
                    "mutates": [],
                    "count": count,
                    **({"slot": True} if slot else {}),
                    **({"submodules": subs} if subs else {}),
                    "merge_key": f"s{site}",
                    "error": None,
                }
            )
        except Exception as e:  # noqa: BLE001
            self._degrade("import", e)

    def _submodules(self, site: int, frame: types.FrameType) -> list[str]:
        """Names a `from m import a [as b]` statement bound to the submodule `m.a` (svl-ac6).

        Only a plain module object whose `__name__` is exactly `m.a` counts, so
        `from os import path` (`posixpath`) and a class or function are not. Reads the module
        dict and `__name__` of a real module only; no student code runs.
        """
        out: list[str] = []
        for b in self.sites[site].get("imports", []):
            if b.get("attr") is None:
                continue
            obj = frame.f_globals.get(b["name"])
            want = f"{b['module']}.{b['attr']}"
            if type(obj) is types.ModuleType and obj.__dict__.get("__name__") == want:
                out.append(b["name"])
        return out

    # -- streaming and the log ----------------------------------------------------------------

    def _open_stubs(self) -> list[dict[str, Any]]:
        return [
            {"i": c.i, "site": c.site, "kind": c.kind, "name": c.name, "module": c.module}
            for c in self._stack
        ]

    def flush(self, force: bool = False) -> None:
        self._last_flush = time.monotonic()
        if self.emit is None:
            self._pending_events = []
            self._pending_bindings = []
            self._pending_output = []
            self._pending_diag = len(self.diagnostics)
            return
        sig = tuple(c.i for c in self._stack)
        summaries = self.vt.take_new_summaries()
        diag = self.diagnostics[self._pending_diag :]
        if not (
            force
            or self._pending_events
            or self._pending_bindings
            or self._pending_output
            or summaries
            or diag
            or sig != self._open_sig
        ):
            return
        msg = {
            "type": "batch",
            "events": self._pending_events,
            "open": self._open_stubs(),
            "values": summaries,
            "bindings": self._pending_bindings,
            "output": self._pending_output,
            "diagnostics": diag,
        }
        self._pending_events = []
        self._pending_bindings = []
        self._pending_output = []
        self._pending_diag = len(self.diagnostics)
        self._open_sig = sig
        self.emit(msg)

    def close_open(self, exc: BaseException | None) -> None:
        """Close calls still open at the end of the run, then flush everything.

        A stop (KeyboardInterrupt, from the worker's interrupt buffer) or timeout marks them
        `interrupted`; any other exception is recorded as their error.
        """
        interrupted = exc is None or not isinstance(exc, Exception)
        for ev, ev_exc in self._unhandled:  # caught earlier: the run went on
            if ev_exc is not exc:
                self._settle(ev)
        stack, self._stack = self._stack, []
        for ctx in stack:
            err: dict[str, Any] | None = None
            if not interrupted and exc is not None:
                err = {
                    "type": type(exc).__name__,
                    "message": _clip(_safe_str(exc)),
                    "handled": False,
                    "propagated": True,
                }
            self._add_event(
                {
                    "i": ctx.i,
                    "ret": ctx.i,
                    "site": ctx.site,
                    "scope": 0,
                    "kind": ctx.kind,
                    "name": ctx.name,
                    "module": ctx.module,
                    "owner": ctx.owner,
                    "inputs": ctx.inputs,
                    "outputs": [],
                    "returns_self": False,
                    "mutates": [],
                    "count": ctx.count,
                    **({"slot": True} if ctx.slot else {}),
                    "merge_key": ctx.key,
                    "error": err,
                    **({"interrupted": True} if interrupted else {}),
                }
            )
        self._unhandled.clear()
        self.flush(force=True)

    def log(self, status: str, error: dict[str, Any] | None) -> dict[str, Any]:
        """The full EventLog. Assembling the streamed batches gives the same document."""
        events = sorted(self._events, key=lambda e: e["i"])
        bindings = [
            b[:3]
            for b in sorted(self._bindings, key=lambda b: b[0])
            if len(b) == 3 or self._bslots[b[3]] is b
        ]
        return {
            "version": 2,
            "status": self.final_status(status),
            "error": error,
            "sites": self.sites,
            "scopes": [
                {
                    "id": 0,
                    "name": "<module>",
                    "parent_event": None,
                    "lexical_parent": None,
                    "bindings": bindings,
                }
            ],
            "values": dict(self.vt.values),
            "events": events,
            "output": list(self._output),
            "diagnostics": list(self.diagnostics),
        }


# -- small pure helpers ----------------------------------------------------------------------


def _safe_str(exc: BaseException) -> str:
    try:
        return str(exc)
    except Exception:  # noqa: BLE001
        return ""


def _getter(obj: Any) -> Callable[[], Any]:
    """A way to reach `obj` later without keeping it alive when it can be weakly referenced."""
    try:
        return weakref.ref(obj)
    except TypeError:
        return lambda: obj


def _is_instance(s: Any) -> bool:
    """A builtin callable's `__self__` that makes it a method (not a module or a class)."""
    return s is not None and not isinstance(s, (types.ModuleType, type))


def _expr_key(site: int, ref: int | str) -> str:
    return f"s{site}.a{ref}" if isinstance(ref, int) else f"s{site}.k{ref}"


def _is_attr_chain(text: str) -> bool:
    """`model.coef_`, `a.b.c`: attribute reads on a plain name, nothing else."""
    try:
        node = ast.parse(text, mode="eval").body
    except SyntaxError:
        return False
    if not isinstance(node, ast.Attribute):
        return False
    while isinstance(node, ast.Attribute):
        node = node.value  # type: ignore[assignment]
    return isinstance(node, ast.Name)


def _owner_expr(func_text: str, reads_of: Callable[[str], list[str]]) -> tuple[str, str, list[str]]:
    """Split `df["price"].mean` into the owner expression and the method name."""
    try:
        node = ast.parse(func_text.strip(), mode="eval").body
    except SyntaxError:
        return ("unknown", "", [])
    if not isinstance(node, ast.Attribute):
        return ("unknown", "", [])
    if isinstance(node.value, ast.Name):
        return ("name", node.value.id, [])
    text = ast.get_source_segment(func_text.strip(), node.value) or ""
    return ("expr", text, reads_of(text)) if text else ("unknown", "", [])
