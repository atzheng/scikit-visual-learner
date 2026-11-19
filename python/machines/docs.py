# ruff: noqa: E501
"""Structured documentation for any function, class or method (CONTRACTS.md section 12).

Everything comes from the docstrings installed in the interpreter, so it works offline and matches the
running versions. Student code is never executed: student definitions are read from the source text with
``ast``. The only network-adjacent output is a plain URL string the UI shows as a link.

``docs(module, name, source=None)`` returns a JSON-able dict (the ``Doc`` type in ``@machines/log``)::

    {qualname, kind: 'function'|'class'|'method', signature: str|None, summary, description,
     sections: [{title, kind: 'entries'|'seealso'|'text'|'examples', ...}], url: str|None,
     source: 'numpydoc'|'plain'|'none'}
"""

from __future__ import annotations

import ast
import builtins
import importlib
import inspect
import re
import sys
import textwrap
from typing import Any

# -- numpydoc parser -------------------------------------------------------------------------

_ENTRY_SECTIONS = {
    "Parameters",
    "Other Parameters",
    "Attributes",
    "Returns",
    "Yields",
    "Receives",
    "Raises",
    "Warns",
    "Methods",
}
_TYPE_ONLY = {"Returns", "Yields", "Receives", "Raises", "Warns"}  # an entry may be just a type
_TEXT_SECTIONS = {"Notes", "References", "Warnings", "Warning", "Note"}
_KNOWN = _ENTRY_SECTIONS | _TEXT_SECTIONS | {"See Also", "Examples", "Example"}
_UNDERLINE = re.compile(r"^-{3,}\s*$")
_ROLE = re.compile(r":(?:[a-z]+:)?[a-z]+:`([^`]*)`")
_LIST_START = re.compile(r"^\s*(?:[-*+]\s|\d+[.)]\s|>>>|\.\.\s|\|)")


def _role(m: re.Match[str]) -> str:
    body = m.group(1)
    arrow = re.match(r"^(.*?)\s*<([^<>]*)>$", body, re.S)
    if arrow:
        return arrow.group(1) or arrow.group(2)
    if body.startswith("~"):
        return body[1:].rsplit(".", 1)[-1]
    return body


def _rst(text: str) -> str:
    """Light reST clean-up: roles become their text, double backticks single, a few directives words."""
    text = _ROLE.sub(_role, text)
    text = re.sub(r"``([^`]+)``", r"`\1`", text)
    text = re.sub(r"^\s*\.\. versionadded::\s*(\S+)", r"Added in version \1.", text, flags=re.M)
    text = re.sub(r"^\s*\.\. versionchanged::\s*(\S+)", r"Changed in version \1.", text, flags=re.M)
    text = re.sub(
        r"^\s*\.\. deprecated::\s*(\S+)", r"Deprecated since version \1.", text, flags=re.M
    )
    text = re.sub(r"^\s*\.\. (?:note|warning)::\s*$", "", text, flags=re.M)
    text = re.sub(
        r"^\s*\.\. (?:code-block|sourcecode|currentmodule|autosummary|plot)::.*$",
        "",
        text,
        flags=re.M,
    )
    return text


def _flow(text: str) -> str:
    """Join hard-wrapped paragraphs; keep lists, tables and indented blocks line by line."""
    text = _rst(textwrap.dedent(text)).strip("\n")
    out: list[str] = []
    for block in re.split(r"\n\s*\n", text):
        lines = block.split("\n")
        if not "".join(lines).strip():
            continue
        first_indent = len(lines[0]) - len(lines[0].lstrip())
        keep = any(
            _LIST_START.match(ln) or (ln.strip() and len(ln) - len(ln.lstrip()) > first_indent)
            for ln in lines
        )
        if keep:
            out.append("\n".join(ln.rstrip() for ln in lines))
        else:
            out.append(" ".join(ln.strip() for ln in lines))
    return "\n\n".join(out)


def _split_sections(lines: list[str]) -> tuple[list[str], list[tuple[str, list[str]]]]:
    """Header lines before the first section, then (title, body lines) per section."""
    head: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    cur: list[str] | None = None
    i = 0
    while i < len(lines):
        line = lines[i]
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if line.strip() and not line[0].isspace() and _UNDERLINE.match(nxt):
            cur = []
            sections.append((line.strip(), cur))
            i += 2
            continue
        (cur if cur is not None else head).append(line)
        i += 1
    return head, sections


def _entries(body: list[str], title: str) -> list[dict[str, str]]:
    heads: list[tuple[str, list[str]]] = []
    for line in body:
        if line.strip() and not line[0].isspace():
            heads.append((line.strip(), []))
        elif heads:
            heads[-1][1].append(line)
    out: list[dict[str, str]] = []
    for head, desc in heads:
        if " : " in head:
            name, _, typ = head.partition(" : ")
        elif head.endswith(" :"):
            name, typ = head[:-2], ""
        elif title in _TYPE_ONLY:
            name, typ = "", head
        else:
            name, typ = head, ""
        out.append({"name": name.strip(), "type": typ.strip(), "desc": _flow("\n".join(desc))})
    return out


def _see_also(body: list[str]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for line in body:
        if not line.strip():
            continue
        if not line[0].isspace():
            head = line.strip()
            name, _, desc = head.partition(" : ")
            items.append({"name": _rst(name.strip()), "desc": desc.strip()})
        elif items:
            items[-1]["desc"] = (items[-1]["desc"] + " " + line.strip()).strip()
    for it in items:
        it["desc"] = _rst(it["desc"])
    return items


def _examples(body: list[str]) -> list[dict[str, str]]:
    text = textwrap.dedent("\n".join(body)).strip("\n")
    blocks: list[dict[str, str]] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip("\n")
        if not para.strip():
            continue
        if para.lstrip().startswith(">>>"):
            # a doctest block: its output lines (no prompt) stay with it
            if blocks and blocks[-1]["kind"] == "code" and blocks[-1].get("_open"):
                blocks[-1]["text"] += "\n\n" + para
            else:
                blocks.append({"kind": "code", "text": para})
        else:
            if blocks and blocks[-1]["kind"] == "code" and not para.startswith((".. ", "Examples")):
                # output continuing a doctest after a blank line (e.g. printed arrays); text otherwise
                pass
            blocks.append({"kind": "text", "text": _flow(para)})
    return [{"kind": b["kind"], "text": b["text"]} for b in blocks]


def parse_numpydoc(doc: str) -> dict[str, Any]:
    """Parse a docstring: ``{summary, description, sections, source}``. Never raises."""
    doc = inspect.cleandoc(doc or "")
    if not doc.strip():
        return {"summary": "", "description": "", "sections": [], "source": "none"}
    head, raw = _split_sections(doc.split("\n"))
    paras = [p for p in re.split(r"\n\s*\n", "\n".join(head).strip()) if p.strip()]
    if len(paras) > 1 and re.match(r"^[\w.]+\(.*\)\s*(->.*)?$", " ".join(paras[0].split()), re.S):
        paras = paras[1:]  # numpy method docstrings open with their own call signature
    summary = " ".join(ln.strip() for ln in paras[0].split("\n")) if paras else ""
    description = _flow("\n\n".join(paras[1:])) if len(paras) > 1 else ""
    sections: list[dict[str, Any]] = []
    for title, body in raw:
        norm = {"Example": "Examples", "Warning": "Warnings"}.get(title, title)
        if norm in _ENTRY_SECTIONS:
            sections.append({"title": norm, "kind": "entries", "entries": _entries(body, norm)})
        elif norm == "See Also":
            sections.append({"title": norm, "kind": "seealso", "items": _see_also(body)})
        elif norm == "Examples":
            sections.append({"title": norm, "kind": "examples", "blocks": _examples(body)})
        else:
            sections.append({"title": norm, "kind": "text", "text": _flow("\n".join(body))})
    known = any(s["title"] in _KNOWN for s in sections)
    return {
        "summary": _rst(summary),
        "description": description,
        "sections": sections,
        "source": "numpydoc" if known else "plain",
    }


# -- URLs ------------------------------------------------------------------------------------

_FUNC_ANCHORS_PREFIXED = {"list", "dict", "set", "tuple", "range", "frozenset", "memoryview"}
_BUILTIN_FUNCTIONS = frozenset(
    "abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod "
    "compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset "
    "getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals "
    "map max memoryview min next object oct open ord pow print property range repr reversed round "
    "set setattr slice sorted staticmethod str sum super tuple type vars zip".split()
)


def _short(version: str, parts: int) -> str | None:
    if not version or any(t in version for t in ("dev", "+")):
        return None
    return ".".join(version.split(".")[:parts])


def doc_url(qualname: str, kind: str, versions: dict[str, str]) -> str | None:
    """The official docs URL for a public ``qualname`` (pure; ``versions`` from the running packages).

    ``kind`` is 'function', 'class' or 'method'. ``versions`` has keys ``python``, ``sklearn``, ``pandas``,
    ``numpy``, ``scipy``, ``matplotlib``. Returns None for anything not covered (private names, other libraries).
    """
    parts = qualname.split(".")
    if not qualname or any(p.startswith("_") for p in parts):
        return None
    root = parts[0]
    if root == "builtins":
        return _builtin_url(parts[1:], kind, versions.get("python", ""))
    v = versions.get(root if root != "sklearn" else "sklearn", "")
    if root == "sklearn":
        ver = _short(v, 2)
        if ver is None or len(parts) < 2:
            return None
        if kind == "method":
            page = ".".join(parts[:-1])
            return f"https://scikit-learn.org/{ver}/modules/generated/{page}.html#{qualname}"
        return f"https://scikit-learn.org/{ver}/modules/generated/{qualname}.html"
    if root == "pandas":
        ver = _short(v, 3)
        return (
            f"https://pandas.pydata.org/pandas-docs/version/{ver}/reference/api/{qualname}.html"
            if ver and len(parts) > 1
            else None
        )
    if root == "numpy":
        ver = _short(v, 2)
        return (
            f"https://numpy.org/doc/{ver}/reference/generated/{qualname}.html"
            if ver and len(parts) > 1
            else None
        )
    if root == "scipy":
        ver = _short(v, 3)
        return (
            f"https://docs.scipy.org/doc/scipy-{ver}/reference/generated/{qualname}.html"
            if ver and len(parts) > 2
            else None
        )
    if root == "matplotlib":
        ver = _short(v, 3)
        return (
            f"https://matplotlib.org/{ver}/api/_as_gen/{qualname}.html"
            if ver and len(parts) > 2
            else None
        )
    return None


def _builtin_url(parts: list[str], kind: str, py: str) -> str | None:
    ver = ".".join(py.split(".")[:2]) or "3"
    base = f"https://docs.python.org/{ver}/library"
    if len(parts) == 2:  # a method of a builtin type: str.join, list.append
        return f"{base}/stdtypes.html#{parts[0]}.{parts[1]}"
    if len(parts) != 1:
        return None
    name = parts[0]
    if name in _BUILTIN_FUNCTIONS:
        anchor = f"func-{name}" if name in _FUNC_ANCHORS_PREFIXED else name
        return f"{base}/functions.html#{anchor}"
    if kind == "class" and name.endswith(("Error", "Exception", "Warning")):
        return f"{base}/exceptions.html#{name}"
    return None


def library_versions() -> dict[str, str]:
    """Versions of the libraries that are loaded (never imports anything new)."""
    out = {"python": sys.version.split()[0]}
    for name in ("sklearn", "pandas", "numpy", "scipy", "matplotlib"):
        m = sys.modules.get(name)
        v = getattr(m, "__version__", None)
        if isinstance(v, str):
            out[name] = v
    return out


# -- resolution ------------------------------------------------------------------------------


def _module_prefixes(modname: str) -> list[str]:
    parts = modname.split(".")
    return [".".join(parts[: i + 1]) for i in range(len(parts))]


def _public_owner(obj: Any, fallback_module: str, qual_root: str) -> str:
    """The documented dotted path of the top-level object ``qual_root`` (``sklearn.linear_model.Ridge``).

    The shortest ancestor of the defining module that re-exports the same object wins, so
    ``sklearn.linear_model._ridge.Ridge`` becomes ``sklearn.linear_model.Ridge`` and
    ``pandas.core.frame.DataFrame`` becomes ``pandas.DataFrame``.
    """
    modname = getattr(obj, "__module__", None)
    if not isinstance(modname, str):
        modname = fallback_module
    for prefix in _module_prefixes(modname):
        mod = sys.modules.get(prefix)
        if mod is not None and getattr(mod, qual_root, None) is obj:
            return f"{prefix}.{qual_root}"
    kept = [p for p in modname.split(".") if not p.startswith("_")]
    return ".".join([*kept, qual_root]) if kept else qual_root


def _import(modname: str) -> Any:
    try:
        return sys.modules.get(modname) or importlib.import_module(modname)
    except Exception:  # noqa: BLE001 - any import failure means "not resolvable"
        return None


def _find_root(module: str | None, name: str) -> tuple[Any, str, str, list[str]] | None:
    """(object, module it was found in, its qualname, remaining attribute path) for the top-level object."""
    parts = name.split(".")
    if module in (None, "builtins") and hasattr(builtins, parts[0]) and (module or len(parts) == 1):
        return getattr(builtins, parts[0]), "builtins", parts[0], parts[1:]
    if module:
        for cand in reversed(_module_prefixes(module)):
            mod = _import(cand)
            if mod is not None and hasattr(mod, parts[0]):
                return getattr(mod, parts[0]), cand, parts[0], parts[1:]
        return None
    # No module: ``name`` is a full dotted path; import the longest module prefix.
    for i in range(len(parts) - 1, 0, -1):
        mod = _import(".".join(parts[:i]))
        if mod is not None and hasattr(mod, parts[i]):
            return getattr(mod, parts[i]), ".".join(parts[:i]), parts[i], parts[i + 1 :]
    return None


def _own_doc(obj: Any) -> str:
    if inspect.isclass(obj):
        d = obj.__dict__.get("__doc__")
        if isinstance(d, str) and d.strip():
            return d
        init = obj.__dict__.get("__init__")
        d = getattr(init, "__doc__", None)
        return d if isinstance(d, str) and init is not object.__init__ else ""
    if isinstance(obj, property):
        return obj.fget.__doc__ or "" if obj.fget else ""
    # getdoc follows the MRO for methods that document themselves on a base class
    return inspect.getdoc(obj) or ""


def _signature(obj: Any, is_method: bool, label: str) -> str | None:
    try:
        target = obj.fget if isinstance(obj, property) and obj.fget else obj
        if isinstance(obj, property):
            return None
        sig = inspect.signature(target)
    except TypeError, ValueError:
        return None
    params = list(sig.parameters.values())
    if is_method and params and params[0].name in ("self", "cls"):
        sig = sig.replace(parameters=params[1:])
    return f"{label}{sig}"


def _library_doc(module: str | None, name: str) -> dict[str, Any] | None:
    found = _find_root(module, name)
    if found is None:
        return None
    root_obj, found_in, first, rest = found
    obj: Any = root_obj
    for part in rest:
        try:
            obj = inspect.getattr_static(obj, part) if isinstance(obj, type) else getattr(obj, part)
        except AttributeError:
            return None
        if isinstance(obj, (staticmethod, classmethod)):
            obj = obj.__func__
    if found_in == "builtins":
        public = "builtins." + ".".join([first, *rest])
    else:
        public = ".".join([_public_owner(root_obj, found_in, first), *rest])
    kind = "method" if rest else ("class" if inspect.isclass(obj) else "function")
    label = public.rsplit(".", 1)[-1]
    return {
        "qualname": public,
        "kind": kind,
        "signature": _signature(obj, kind == "method", label),
        "doc": _own_doc(obj),
    }


def _student_doc(name: str, source: str | None) -> dict[str, Any] | None:
    if not source:
        return None
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    node: ast.AST = tree
    parts = name.split(".")
    for part in parts:
        for child in ast.iter_child_nodes(node):
            if (
                isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and child.name == part
            ):
                node = child
                break
        else:
            return None
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return None
    doc = ast.get_docstring(node, clean=False) or ""
    kind = (
        "class" if isinstance(node, ast.ClassDef) else ("method" if len(parts) > 1 else "function")
    )
    sig: str | None
    if isinstance(node, ast.ClassDef):
        init = next(
            (c for c in node.body if isinstance(c, ast.FunctionDef) and c.name == "__init__"), None
        )
        if not doc.strip() and init is not None:
            doc = ast.get_docstring(init, clean=False) or ""
        sig = _ast_sig(parts[-1], init.args, True, None) if init is not None else f"{parts[-1]}()"
    else:
        sig = _ast_sig(parts[-1], node.args, kind == "method", node.returns)
    return {"qualname": name, "kind": kind, "signature": sig, "doc": doc}


def _ast_sig(label: str, args: ast.arguments, drop_self: bool, returns: ast.expr | None) -> str:
    inner = ast.unparse(args)
    if drop_self:
        inner = re.sub(r"^(?:self|cls)(?:, |$)", "", inner)
    text = f"{label}({inner})"
    return f"{text} -> {ast.unparse(returns)}" if returns is not None else text


def docs(module: str | None, name: str, source: str | None = None) -> dict[str, Any]:
    """Documentation for the callee ``name`` defined in ``module`` (an event's ``module`` and ``name``).

    ``module`` is None when ``name`` is a full dotted path. Student definitions (module ``__main__`` or
    ``<student>``) are read from ``source``. Never runs student code and never raises.
    """
    try:
        student = module in ("__main__", "<student>")
        info = _student_doc(name, source) if student else _library_doc(module, name)
    except Exception:  # noqa: BLE001 - documentation must never break the page
        info = None
    if info is None:
        return {
            "qualname": name if module in (None, "__main__", "<student>") else f"{module}.{name}",
            "kind": "function",
            "signature": None,
            "summary": "",
            "description": "",
            "sections": [],
            "url": None,
            "source": "none",
        }
    parsed = parse_numpydoc(info["doc"])
    url = None if student else doc_url(info["qualname"], info["kind"], library_versions())
    return {
        "qualname": info["qualname"],
        "kind": info["kind"],
        "signature": info["signature"],
        "summary": parsed["summary"],
        "description": parsed["description"],
        "sections": parsed["sections"],
        "url": url,
        "source": parsed["source"],
    }
