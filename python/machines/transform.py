"""The Instrument AST transformer and the site table (CONTRACTS.md section 3).

``instrument(source)`` rewrites the module body, class bodies and the comprehensions in them.
Function and lambda bodies are left alone in M1-3. Hooks are plain names looked up in builtins.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from typing import Any

HOOK_NAMES = ("__rec__", "__bind__", "__store__", "__scope__", "__ret__")
UNWRAPPED_CALLS = frozenset(
    {"super", "locals", "globals", "vars", "dir", "eval", "exec", "breakpoint"}
)

Span = tuple[int, int, int, int]

_NEWLINE = re.compile(r"(\r\n|\r|\n)")
_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)


@dataclass
class Instrumented:
    tree: ast.Module
    sites: list[dict[str, Any]]


def instrument(source: str) -> Instrumented:
    """Parse and rewrite `source`. A SyntaxError from `ast.parse` propagates unchanged."""
    tree = ast.parse(source)
    transformer = _Instrument(source)
    new_tree = transformer.visit(tree)
    assert isinstance(new_tree, ast.Module)
    ast.fix_missing_locations(new_tree)
    return Instrumented(new_tree, transformer.sites)


class _Source:
    """Maps `ast` positions (UTF-8 byte columns) to code-point columns and source slices."""

    def __init__(self, source: str) -> None:
        parts = _NEWLINE.split(source)
        self.lines = parts[0::2]
        self.seps = parts[1::2]
        self._bytes: dict[int, bytes] = {}

    def col(self, line: int, byte_col: int) -> int:
        raw = self._bytes.get(line)
        if raw is None:
            raw = self.lines[line - 1].encode("utf-8", "surrogatepass")
            self._bytes[line] = raw
        return len(raw[:byte_col].decode("utf-8", "surrogatepass"))

    def span(self, node: ast.AST) -> Span:
        line: int = node.lineno  # type: ignore[attr-defined]
        end_line: int = node.end_lineno  # type: ignore[attr-defined]
        col = self.col(line, node.col_offset)  # type: ignore[attr-defined]
        end_col = self.col(end_line, node.end_col_offset)  # type: ignore[attr-defined]
        return line, col, end_line, end_col

    def text(self, span: Span) -> str:
        line, col, end_line, end_col = span
        if line == end_line:
            return self.lines[line - 1][col:end_col]
        out = [self.lines[line - 1][col:]]
        for n in range(line, end_line - 1):
            out.append(self.seps[n - 1] + self.lines[n])
        out.append(self.seps[end_line - 2] + self.lines[end_line - 1][:end_col])
        return "".join(out)


def _is_numeric_const(node: ast.expr) -> bool:
    return (
        isinstance(node, ast.Constant)
        and isinstance(node.value, (int, float, complex))
        and not isinstance(node.value, bool)
    )


def _is_const(node: ast.expr) -> bool:
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return _is_numeric_const(node.operand)
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return all(_is_const(e) for e in node.elts)
    if isinstance(node, ast.Dict):
        return all(k is not None and _is_const(k) for k in node.keys) and all(
            _is_const(v) for v in node.values
        )
    return False


def _collect_reads(node: ast.AST, bound: frozenset[str], out: list[tuple[int, int, str]]) -> None:
    if isinstance(node, ast.Lambda):
        return  # names under a nested lambda are not reads of this expression
    if isinstance(node, ast.Name):
        if isinstance(node.ctx, ast.Load) and node.id not in bound:
            out.append((node.lineno, node.col_offset, node.id))
        return
    if isinstance(node, _COMPREHENSIONS):
        targets = {
            n.id for g in node.generators for n in ast.walk(g.target) if isinstance(n, ast.Name)
        }
        inner = bound | targets
        # The first iterable is evaluated in the enclosing scope.
        _collect_reads(node.generators[0].iter, bound, out)
        for i, gen in enumerate(node.generators):
            if i:
                _collect_reads(gen.iter, inner, out)
            for cond in gen.ifs:
                _collect_reads(cond, inner, out)
        if isinstance(node, ast.DictComp):
            _collect_reads(node.key, inner, out)
            _collect_reads(node.value, inner, out)
        else:
            _collect_reads(node.elt, inner, out)
        return
    for child in ast.iter_child_nodes(node):
        _collect_reads(child, bound, out)


def _reads(node: ast.AST) -> list[str]:
    found: list[tuple[int, int, str]] = []
    _collect_reads(node, frozenset(), found)
    found.sort(key=lambda t: (t[0], t[1]))
    return list(dict.fromkeys(name for _, _, name in found))


def _flatten_targets(target: ast.expr) -> list[ast.expr]:
    if isinstance(target, (ast.Tuple, ast.List)):
        return [leaf for e in target.elts for leaf in _flatten_targets(e)]
    if isinstance(target, ast.Starred):
        return _flatten_targets(target.value)
    return [target]


def _names(target: ast.expr) -> list[str]:
    return [t.id for t in _flatten_targets(target) if isinstance(t, ast.Name)]


def _store_root(target: ast.expr) -> str | None:
    if not isinstance(target, (ast.Attribute, ast.Subscript)):
        return None
    node: ast.expr = target
    while isinstance(node, (ast.Attribute, ast.Subscript)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def _is_unwrapped(node: ast.Call) -> bool:
    return isinstance(node.func, ast.Name) and node.func.id in UNWRAPPED_CALLS


class _Pending:
    """An origin computed before the children are rewritten (a call origin needs its site id)."""

    def __init__(self, data: dict[str, Any] | None, call: ast.Call | None = None) -> None:
        self.data = data
        self.call = call


class _Instrument(ast.NodeTransformer):
    def __init__(self, source: str) -> None:
        self.src = _Source(source)
        self.sites: list[dict[str, Any]] = []
        self.site_of: dict[ast.Call, int] = {}  # original Call node -> site id (wrapped only)
        self.in_class = False

    # -- helpers -----------------------------------------------------------------------------

    def _add(self, site: dict[str, Any]) -> int:
        site["id"] = len(self.sites)
        self.sites.append(site)
        return int(site["id"])

    def _base(self, kind: str, span: Span) -> dict[str, Any]:
        return {
            "id": -1,
            "kind": kind,
            "line": span[0],
            "col": span[1],
            "end_line": span[2],
            "end_col": span[3],
            "text": self.src.text(span),
        }

    def _text(self, node: ast.AST) -> str:
        return self.src.text(self.src.span(node))

    def _pre_origin(self, node: ast.expr) -> _Pending:
        if _is_const(node):
            return _Pending({"origin": "const", "text": self._text(node)})
        if isinstance(node, ast.Name):
            return _Pending({"origin": "name", "name": node.id})
        if isinstance(node, ast.Call) and not _is_unwrapped(node):
            return _Pending(None, node)
        return _Pending({"origin": "expr", "text": self._text(node), "reads": _reads(node)})

    def _resolve(self, pending: _Pending) -> dict[str, Any]:
        if pending.call is not None:
            return {"origin": "call", "site": self.site_of[pending.call]}
        assert pending.data is not None
        return pending.data

    @staticmethod
    def _hook_stmt(name: str, *args: ast.expr, like: ast.AST) -> ast.Expr:
        call = ast.Call(func=ast.Name(name, ast.Load()), args=list(args), keywords=[])
        return ast.copy_location(ast.Expr(ast.copy_location(call, like)), like)

    def _bind_stmt(
        self, names: list[str], span: Span, value: dict[str, Any] | None, like: ast.AST
    ) -> ast.Expr:
        site = self._base("bind", span)
        site["targets"] = names
        if value is not None:
            site["value"] = value
        site["where"] = "local"
        sid = self._add(site)
        mapping = ast.Dict(
            keys=[ast.Constant(n) for n in names],
            values=[ast.Name(n, ast.Load()) for n in names],
        )
        return self._hook_stmt("__bind__", ast.Constant(sid), mapping, like=like)

    def _store_stmt(
        self, root: str, span: Span, value: dict[str, Any] | None, like: ast.AST
    ) -> ast.Expr:
        site = self._base("store", span)
        site["root"] = root
        if value is not None:
            site["value"] = value
        sid = self._add(site)
        return self._hook_stmt(
            "__store__", ast.Constant(sid), ast.Name(root, ast.Load()), like=like
        )

    # -- expressions -------------------------------------------------------------------------

    def visit_Call(self, node: ast.Call) -> ast.expr:
        if _is_unwrapped(node):
            self.generic_visit(node)
            return node
        span = self.src.span(node)
        func_text = self._text(node.func)
        # Origins are computed on the original nodes, before the children are rewritten.
        first_star = next((i for i, a in enumerate(node.args) if isinstance(a, ast.Starred)), None)
        star_pos = None
        if first_star is not None:
            star = node.args[first_star]
            star_pos = (star.lineno, star.col_offset)
        arg_pre: list[_Pending | None] = [
            None if first_star is not None and i >= first_star else self._pre_origin(a)
            for i, a in enumerate(node.args)
        ]
        kw_pre: list[tuple[str, _Pending | None]] = []
        for kw in node.keywords:
            if kw.arg is None:
                kw_pre.append(("**", None))
            elif star_pos is not None and (kw.value.lineno, kw.value.col_offset) > star_pos:
                kw_pre.append((kw.arg, None))
            else:
                kw_pre.append((kw.arg, self._pre_origin(kw.value)))

        self.generic_visit(node)

        site = self._base("call", span)
        site["func_text"] = func_text
        site["args"] = [self._resolve(p) if p else {"origin": "unknown"} for p in arg_pre]
        site["keywords"] = {k: self._resolve(p) if p else {"origin": "unknown"} for k, p in kw_pre}
        sid = self._add(site)
        self.site_of[node] = sid
        call = ast.Call(
            func=ast.Name("__rec__", ast.Load()),
            args=[ast.Constant(sid), node.func, *node.args],
            keywords=node.keywords,
        )
        return ast.copy_location(call, node)

    def visit_Lambda(self, node: ast.Lambda) -> ast.expr:
        # The body is not instrumented; defaults are evaluated in the enclosing scope.
        self._visit_defaults(node.args)
        return node

    def _visit_defaults(self, args: ast.arguments) -> None:
        args.defaults = [self.visit(d) for d in args.defaults]
        args.kw_defaults = [self.visit(d) if d is not None else None for d in args.kw_defaults]

    # -- definitions -------------------------------------------------------------------------

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.stmt:
        # Decorators and defaults run in the enclosing scope. The body and annotations are left
        # alone (annotations are not data flow, and `from __future__ import annotations` would
        # stringify the rewritten calls).
        node.decorator_list = [self.visit(d) for d in node.decorator_list]
        self._visit_defaults(node.args)
        return node

    visit_AsyncFunctionDef = visit_FunctionDef  # type: ignore[assignment]

    def visit_ClassDef(self, node: ast.ClassDef) -> ast.stmt:
        node.decorator_list = [self.visit(d) for d in node.decorator_list]
        node.bases = [self.visit(b) for b in node.bases]
        node.keywords = [self.visit(k) for k in node.keywords]
        outer = self.in_class
        self.in_class = True
        try:
            body: list[ast.stmt] = []
            for s in node.body:
                r = self.visit(s)
                body.extend(r if isinstance(r, list) else [r])
            node.body = body
        finally:
            self.in_class = outer
        return node

    # -- binds and stores --------------------------------------------------------------------

    def _assignment(
        self, node: ast.stmt, targets: list[ast.expr], value: ast.expr, augmented: bool = False
    ) -> ast.stmt | list[ast.stmt]:
        span = self.src.span(node)
        pre: _Pending | None = None
        if not self.in_class:
            if augmented:
                # `x += f(y)` binds x to a combination of x and f(y), not to f(y) itself: an
                # `expr` origin keeps the recorder from wiring f's output to x.
                reads = list(dict.fromkeys([*_names(targets[0]), *_reads(value)]))
                pre = _Pending({"origin": "expr", "text": self.src.text(span), "reads": reads})
            else:
                pre = self._pre_origin(value)
        self.generic_visit(node)
        if pre is None:
            return node  # statements directly in a class body get neither hook
        origin = self._resolve(pre)

        names = [n for t in targets for n in _names(t)]
        extra: list[ast.stmt] = []
        if names:
            extra.append(self._bind_stmt(list(dict.fromkeys(names)), span, origin, node))
        for t in targets:
            for leaf in _flatten_targets(t):
                root = _store_root(leaf)
                if root is not None:
                    # The value is only recorded when the target is the whole left-hand side.
                    single = leaf is t and not augmented
                    extra.append(self._store_stmt(root, span, origin if single else None, node))
        if (
            not augmented
            and len(targets) == 1
            and isinstance(targets[0], (ast.Tuple, ast.List))
            and targets[0].elts
            and all(isinstance(e, ast.Name) for e in targets[0].elts)
            and pre.call is not None
        ):
            self.sites[origin["site"]]["unpack"] = len(targets[0].elts)
        return [node, *extra] if extra else node

    def visit_Assign(self, node: ast.Assign) -> ast.stmt | list[ast.stmt]:
        return self._assignment(node, node.targets, node.value)

    def visit_AugAssign(self, node: ast.AugAssign) -> ast.stmt | list[ast.stmt]:
        return self._assignment(node, [node.target], node.value, augmented=True)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> ast.stmt | list[ast.stmt]:
        annotation = node.annotation
        node.annotation = ast.Constant(None)  # keep the annotation out of the traversal
        try:
            if node.value is None:
                self.generic_visit(node)
                return node
            return self._assignment(node, [node.target], node.value)
        finally:
            node.annotation = annotation

    def visit_For(self, node: ast.For) -> ast.stmt:
        self.generic_visit(node)
        names = [] if self.in_class else _names(node.target)
        if names:
            span = self.src.span(node.target)
            bind = self._bind_stmt(list(dict.fromkeys(names)), span, None, node.target)
            node.body.insert(0, bind)
        return node

    visit_AsyncFor = visit_For  # type: ignore[assignment]

    def visit_With(self, node: ast.With) -> ast.stmt:
        self.generic_visit(node)
        if not self.in_class:
            binds: list[ast.stmt] = []
            for item in node.items:
                if item.optional_vars is None:
                    continue
                names = _names(item.optional_vars)
                if names:
                    start = self.src.span(item.context_expr)
                    end = self.src.span(item.optional_vars)
                    span = (start[0], start[1], end[2], end[3])
                    binds.append(
                        self._bind_stmt(list(dict.fromkeys(names)), span, None, item.optional_vars)
                    )
            node.body[0:0] = binds
        return node

    visit_AsyncWith = visit_With  # type: ignore[assignment]
