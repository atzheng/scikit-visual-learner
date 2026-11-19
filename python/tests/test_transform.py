from __future__ import annotations

import ast
import builtins
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from conftest import run_source

from machines.transform import HOOK_NAMES, UNWRAPPED_CALLS, instrument


def src(source: str) -> str:
    return ast.unparse(instrument(source).tree)


def sites(source: str) -> list[dict[str, Any]]:
    return instrument(source).sites


def kind(source: str, k: str) -> list[dict[str, Any]]:
    return [s for s in sites(source) if s["kind"] == k]


# -- calls -----------------------------------------------------------------------------------


def test_contract_constants() -> None:
    assert HOOK_NAMES == ("__rec__", "__bind__", "__store__", "__scope__", "__ret__", "__imp__")
    assert UNWRAPPED_CALLS == {
        "super", "locals", "globals", "vars", "dir", "eval", "exec", "breakpoint"
    }  # fmt: skip


def test_call_wrapped_and_args_preserved() -> None:
    assert src("f(a, 1, *b, k=2, **c)") == "__rec__(0, f, a, 1, *b, k=2, **c)"


def test_method_call_func_is_attribute() -> None:
    assert src("m.fit(X, y)") == "__rec__(0, m.fit, X, y)"


def test_nested_calls_wrapped_first() -> None:
    source = "f(g(x), h(y))"
    assert src(source) == "__rec__(2, f, __rec__(0, g, x), __rec__(1, h, y))"
    s = sites(source)
    assert [x["text"] for x in s] == ["g(x)", "h(y)", "f(g(x), h(y))"]
    assert s[2]["args"] == [{"origin": "call", "site": 0}, {"origin": "call", "site": 1}]


def test_chained_call() -> None:
    assert src("a.f(1).g(2)") == "__rec__(1, __rec__(0, a.f, 1).g, 2)"


def test_call_site_fields() -> None:
    (s,) = sites("model.fit(X, y=3)")
    assert s["kind"] == "call"
    assert s["func_text"] == "model.fit"
    assert s["text"] == "model.fit(X, y=3)"
    assert (s["line"], s["col"], s["end_line"], s["end_col"]) == (1, 0, 1, 17)
    assert s["args"] == [{"origin": "name", "name": "X"}]
    assert s["keywords"] == {"y": {"origin": "const", "text": "3"}}
    assert "unpack" not in s


def test_calls_in_comprehensions_wrapped() -> None:
    assert src("[f(x) for x in g(y)]") == "[__rec__(0, f, x) for x in __rec__(1, g, y)]"


def test_calls_in_class_body_wrapped() -> None:
    out = src("class A(base(1)):\n    x = f()")
    assert "class A(__rec__(0, base, 1))" in out
    assert "x = __rec__(1, f)" in out


@pytest.mark.parametrize("name", sorted(UNWRAPPED_CALLS))
def test_unwrapped_calls(name: str) -> None:
    assert src(f"{name}(g(x))") == f"{name}(__rec__(0, g, x))"
    assert [s["text"] for s in sites(f"{name}(g(x))")] == ["g(x)"]


def test_unwrapped_only_for_bare_names() -> None:
    assert src("a.locals()") == "__rec__(0, a.locals)"
    assert src("super().f()") == "__rec__(0, super().f)"


def test_unwrapped_call_is_expr_origin() -> None:
    (s,) = [s for s in sites("f(locals())") if s["kind"] == "call"]
    assert s["args"] == [{"origin": "expr", "text": "locals()", "reads": ["locals"]}]


# -- function bodies -------------------------------------------------------------------------


def test_function_body_untouched_but_decorators_and_defaults_visited() -> None:
    source = "@deco(1)\ndef f(a=g(2)):\n    return h(a)\n"
    out = src(source)
    assert "@__rec__(0, deco, 1)" in out
    assert "a=__rec__(1, g, 2)" in out
    assert "return h(a)" in out
    assert [s["text"] for s in sites(source)] == ["deco(1)", "g(2)"]


def test_async_generator_and_lambda_untouched() -> None:
    source = (
        "async def a():\n    return f(1)\ndef gen():\n    yield f(1)\nl = lambda x, y=g(1): h(x)\n"
    )
    out = src(source)
    assert "return f(1)" in out and "yield f(1)" in out
    assert "lambda x, y=__rec__(0, g, 1): h(x)" in out
    assert not [s for s in sites(source) if s["text"] in ("f(1)", "h(x)")]


def test_class_body_methods_untouched() -> None:
    out = src("class A:\n    def m(self):\n        return f(1)\n    y = g(2)\n")
    assert "return f(1)" in out
    assert "y = __rec__(0, g, 2)" in out


# -- binds and stores ------------------------------------------------------------------------


def test_assign_bind() -> None:
    assert src("a = f(1)") == "a = __rec__(0, f, 1)\n__bind__(1, {'a': a})"
    (b,) = kind("a = f(1)", "bind")
    assert b["targets"] == ["a"]
    assert b["where"] == "local"
    assert b["value"] == {"origin": "call", "site": 0}
    assert b["text"] == "a = f(1)"


def test_tuple_and_starred_targets_flatten() -> None:
    assert "__bind__(0, {'a': a, 'b': b, 'c': c})" in src("a, (b, *c) = x")
    assert kind("a, (b, *c) = x", "bind")[0]["targets"] == ["a", "b", "c"]


def test_multi_target_assign() -> None:
    assert kind("a = b = 1", "bind")[0]["targets"] == ["a", "b"]


def test_augassign_and_annassign() -> None:
    assert "__bind__(1, {'x': x})" in src("x += f(1)")
    (b,) = kind("x += f(y)", "bind")
    # not the call's origin: x combines x and f(y), so no wire from f to x
    assert b["value"] == {"origin": "expr", "text": "x += f(y)", "reads": ["x", "f", "y"]}
    assert "__bind__" in src("x: int = f(1)")
    assert src("x: int") == "x: int"


def test_annotation_not_instrumented() -> None:
    assert src("x: g(1) = 2").startswith("x: g(1) = 2")


def test_for_target_bind_first_in_body() -> None:
    source = "for i, j in f(x):\n    g(i)"
    assert src(source).splitlines()[1:] == [
        "    __bind__(2, {'i': i, 'j': j})",
        "    __rec__(1, g, i)",
    ]
    (b,) = kind(source, "bind")
    assert b["targets"] == ["i", "j"]
    assert "value" not in b


def test_with_target_bind() -> None:
    source = "with f() as a, g() as (b, c), h():\n    pass"
    out = src(source)
    assert "__bind__(3, {'a': a})" in out
    assert "__bind__(4, {'b': b, 'c': c})" in out
    assert out.index("{'a': a}") < out.index("{'b': b, 'c': c}") < out.index("pass")
    assert [b["targets"] for b in kind(source, "bind")] == [["a"], ["b", "c"]]


def test_store_subscript_and_attribute() -> None:
    assert src('df["c"] = v') == "df['c'] = v\n__store__(0, df)"
    (s,) = kind('df.loc[m, "c"] = 0', "store")
    assert s["root"] == "df"
    assert s["value"] == {"origin": "const", "text": "0"}
    assert kind("obj.a.b = 1", "store")[0]["root"] == "obj"
    assert kind("f().x = 1", "store") == []
    assert kind("(a if b else c).x = 1", "store") == []


def test_store_without_bind_and_mixed() -> None:
    assert kind('df["c"] = 1', "bind") == []
    out = src("a, d[0] = x")
    assert "__bind__(0, {'a': a})" in out and "__store__(1, d)" in out
    (st,) = kind("a, d[0] = x", "store")
    assert "value" not in st  # the right-hand side is not a single value for this target


def test_class_body_gets_no_binds_or_stores() -> None:
    for source in [
        "class A:\n    x = f(1)\n    y: int = 2\n    z += 1\n    for i in r:\n        pass\n",
        "class A:\n    x = f(1)\n    d['a'] = 1\n    with g() as h:\n        pass\n",
    ]:
        out = src(source)
        assert "__bind__" not in out and "__store__" not in out
    assert "__bind__" in src("class A:\n    x = 1\ny = 2")  # module level resumes


def test_not_bound() -> None:
    for code in [
        "import os",
        "del a",
        "(a := f(1))",
        "try:\n    pass\nexcept E as e:\n    pass",
        "match x:\n    case [a, b]:\n        pass",
        "global a",
        "class A: pass",
        "def f(): pass",
    ]:
        assert "__bind__" not in src(code)


def test_nested_statements_still_bound() -> None:
    out = src("if c:\n    a = 1\nwhile c:\n    b = 2\ntry:\n    d = 3\nfinally:\n    e = 4")
    assert out.count("__bind__") == 4


# -- origins ---------------------------------------------------------------------------------


def origins(args: str) -> list[dict[str, Any]]:
    return kind(f"f({args})", "call")[-1]["args"]


def test_const_origins() -> None:
    got = origins('0.2, "price", None, True, -1, -2.5, (1, 2), [1, "a"], {"a": 1}, {1, 2}, (), []')
    assert all(o["origin"] == "const" for o in got)
    assert [o["text"] for o in got] == [
        "0.2", '"price"', "None", "True", "-1", "-2.5", "(1, 2)", '[1, "a"]', '{"a": 1}',
        "{1, 2}", "()", "[]",
    ]  # fmt: skip


def test_non_const_origins() -> None:
    got = origins("-x, +1, (1, x), [1, f()], {**d}, 1 + 2, ~1, -True")
    assert [o["origin"] for o in got] == ["expr"] * 8


def test_name_origin_and_call_origin() -> None:
    assert origins("x, g(1)") == [
        {"origin": "name", "name": "x"},
        {"origin": "call", "site": 0},
    ]


def test_expr_origin_reads() -> None:
    (o,) = origins('df["price"] + b * df.c + b')
    assert o == {"origin": "expr", "text": 'df["price"] + b * df.c + b', "reads": ["df", "b"]}


def test_reads_exclude_lambda_and_comprehension_targets() -> None:
    (o,) = origins("[x + k for x in xs]")
    assert o["reads"] == ["k", "xs"]  # source order
    (o,) = origins("(lambda p: p + q) or c")
    assert o["reads"] == ["c"]
    (o,) = origins("[a for a in a]")
    assert o["reads"] == ["a"]  # the first iterable is read in the enclosing scope
    (o,) = origins("{k: v for k, v in d.items() if k > t}")
    assert o["reads"] == ["d", "t"]


def test_starred_makes_following_unknown() -> None:
    (s,) = kind("f(a, *b, c, 1, k=2, **d)", "call")
    assert s["args"] == [
        {"origin": "name", "name": "a"},
        {"origin": "unknown"},
        {"origin": "unknown"},
        {"origin": "unknown"},
    ]
    assert s["keywords"] == {"k": {"origin": "unknown"}, "**": {"origin": "unknown"}}
    (s,) = kind("f(a, k=2, **d)", "call")
    assert s["keywords"] == {"k": {"origin": "const", "text": "2"}, "**": {"origin": "unknown"}}


# -- unpack ----------------------------------------------------------------------------------


def test_unpack() -> None:
    assert kind("a, b, c, d = f(x)", "call")[0]["unpack"] == 4
    assert kind("[a, b] = f(x)", "call")[0]["unpack"] == 2
    for code in [
        "a, *b = f(x)",
        "a, (b, c) = f(x)",
        "a = f(x)",
        "a = b, c = f(x)",
        "a, b = f(x).y",
        "a, b = c, d",
        "a.x, b = f(x)",
    ]:
        assert all("unpack" not in s for s in kind(code, "call")), code


def test_unpack_only_the_rhs_call() -> None:
    assert ["unpack" in c for c in kind("a, b = f(g(x))", "call")] == [False, True]


# -- positions -------------------------------------------------------------------------------


def test_code_point_columns() -> None:
    source = 's = "héllo → 世界"; f(1)\nt = "😀"; g(2)'
    f, g = kind(source, "call")
    line1, line2 = source.split("\n")
    assert f["text"] == "f(1)"
    assert (f["line"], f["col"], f["end_col"]) == (1, line1.index("f(1)"), line1.index("f(1)") + 4)
    assert g["text"] == "g(2)"
    assert (g["line"], g["col"]) == (2, line2.index("g(2)"))
    assert f["col"] < len(line1.encode()) - 3  # would differ if byte offsets leaked through


def test_multiline_text_exact() -> None:
    source = "x = f(\n    1,\n    2,\n)\n"
    (s,) = kind(source, "call")
    assert s["text"] == "f(\n    1,\n    2,\n)"
    assert (s["line"], s["end_line"], s["end_col"]) == (1, 4, 1)
    (b,) = kind(source, "bind")
    assert b["text"] == "x = f(\n    1,\n    2,\n)"


def test_crlf_text_preserved() -> None:
    source = "x = f(\r\n    1)\r\ny = 2\r\n"
    (s,) = kind(source, "call")
    assert s["text"] == "f(\r\n    1)"
    assert kind(source, "bind")[1]["line"] == 3


def test_origin_text_uses_code_points() -> None:
    (s,) = kind('f("é", "é" + x)', "call")
    assert s["args"][0] == {"origin": "const", "text": '"é"'}
    assert s["args"][1]["text"] == '"é" + x'


# -- errors and compile ----------------------------------------------------------------------


def test_syntax_error_unchanged() -> None:
    with pytest.raises(SyntaxError) as info:
        instrument("x = (\n")
    with pytest.raises(SyntaxError) as plain:
        ast.parse("x = (\n")
    assert str(info.value) == str(plain.value)
    assert (info.value.lineno, info.value.offset) == (plain.value.lineno, plain.value.offset)


def test_site_ids_index_sites_and_tree_compiles() -> None:
    inst = instrument("a = f(g(1))\nfor i in h(a):\n    df[i] = k(i)\n")
    assert [s["id"] for s in inst.sites] == list(range(len(inst.sites)))
    compile(inst.tree, "<student>", "exec")


# -- transparency (pass-through hooks) -------------------------------------------------------

PROGRAMS = {
    "basic": """
import math
xs = [math.sqrt(i) for i in range(5)]
a, b = divmod(17, 5)
d = {}
d["k"] = len(xs)
d["j"] = d.get("k", 0) + 1
print(sorted(xs, key=lambda v: -v), a, b, d)
""",
    "class_scope": """
class A:
    base = max(1, 2)
    items = [str(i) for i in range(3)]
    def m(self, x=min(3, 4)):
        return x + self.base
    z = base + 1
print(A().m(), A.items, A.z)
""",
    "super_locals": """
class B:
    def __init__(self):
        self.v = 1
class C(B):
    def __init__(self):
        super().__init__()
        self.w = len(locals())
c = C()
print(c.v, c.w, sorted(k for k in globals() if k in "cBC"))
print(dir(c)[-1], vars(c))
""",
    "decorators": """
import functools
@functools.lru_cache(maxsize=None)
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
def gen():
    yield from range(3)
async def co():
    return 1
print(fib(20), list(gen()))
""",
    "binds": """
for i, (j, k) in enumerate([(1, 2), (3, 4)]):
    print(i, j, k)
with open("/dev/null") as fh, open("/dev/null") as (g):
    print(fh.read() == g.read())
n = 0
n += len("abc")
y: int = n * 2
class T: pass
t = T()
t.a = t.b = 3
print(n, y, t.a, t.b)
""",
    "kwargs_reserved": """
def f(site=0, fn=1, *a, **k):
    return site, fn, a, k
print(f(site=2, fn=3), f(1, 2, 3, x=4))
args = [1, 2]
kw = {"z": 1}
print(f(*args, **kw), f(site=5))
""",
    "exceptions": """
try:
    int("x")
except ValueError as e:
    print(type(e).__name__, e)
try:
    [].pop()
except IndexError as e:
    print(e)
""",
    "walrus_comp": """
data = [1, 2, 3]
if (n := len(data)) > 2:
    print(n, [(m := x * 2) for x in data], m)
print({k: v for k, v in zip("ab", range(2))})
print(sum(x for x in map(abs, [-1, -2])))
""",
}


def _public(ns: dict[str, Any]) -> dict[str, Any]:
    return {
        k: v
        for k, v in ns.items()
        if isinstance(v, (int, float, str, bool, list, tuple, dict, type(None)))
        and not k.startswith("__")
    }


@pytest.mark.parametrize("name", sorted(PROGRAMS))
def test_passthrough_transparent(name: str, passthrough_hooks: None) -> None:
    source = PROGRAMS[name]
    plain_ns, plain_out, plain_err = run_source(source)
    ns, out, err = run_source(instrument(source))
    assert plain_err is None
    assert (out, err) == (plain_out, plain_err)
    assert _public(ns) == _public(plain_ns)


def test_passthrough_same_exception(passthrough_hooks: None) -> None:
    source = "x = 1\ny = int('q')\nz = 2\n"
    plain_ns, plain_out, plain_err = run_source(source)
    ns, out, err = run_source(instrument(source))
    assert plain_err is not None and err == plain_err
    assert "z" not in ns and ns["x"] == 1


def test_hooks_are_not_in_globals(passthrough_hooks: None) -> None:
    ns, _, _ = run_source(instrument("a = len([1])\nb = sorted(globals())"))
    assert not any(n in ns["b"] for n in HOOK_NAMES)
    assert all(hasattr(builtins, n) for n in HOOK_NAMES)


def test_class_body_name_mangling_unaffected(passthrough_hooks: None) -> None:
    source = "class A:\n    __p = len('ab')\n    q = __p + 1\nprint(A.q, A._A__p)\n"
    _, out, err = run_source(instrument(source))
    assert (out, err) == ("3 2\n", None)


FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
FIXTURE_PROGRAMS = sorted(p.name for p in (FIXTURES / "programs").glob("*.py"))

_RUNNER = """
import sys
from machines.transform import instrument
import builtins
builtins.__rec__ = lambda site, fn, /, *a, **k: fn(*a, **k)
builtins.__bind__ = lambda site, m, /: None
builtins.__store__ = lambda site, b, /: None
builtins.__scope__ = lambda fn, /: fn
builtins.__ret__ = lambda site, v, /: v
builtins.__imp__ = lambda site, begin=False, /: None
path, mode = sys.argv[1], sys.argv[2]
source = open(path).read()
sys.argv = [path]
ns = {"__name__": "__main__", "__file__": path}
if mode == "plain":
    code = compile(source, "<student>", "exec")
else:
    code = compile(instrument(source).tree, "<student>", "exec")
exec(code, ns)
"""


def _run_fixture(name: str, mode: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", _RUNNER, str(FIXTURES / "programs" / name), mode],
        cwd=FIXTURES / "data",
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=240,
        env={**os.environ, "PYTHONHASHSEED": "0", "MPLBACKEND": "Agg"},
    )


def _last_line(stderr: str) -> str:
    lines = stderr.strip().splitlines()
    return lines[-1].split(": ", 1)[-1] if lines else ""


def test_fixture_programs_exist() -> None:
    assert len(FIXTURE_PROGRAMS) >= 26  # the parametrized test below must run, not skip


@pytest.mark.slow
@pytest.mark.parametrize("name", FIXTURE_PROGRAMS)
def test_fixture_program_transparent(name: str) -> None:
    """Pass-through hooks: same stdout, exit status and final error line as plain Python."""
    plain = _run_fixture(name, "plain")
    inst = _run_fixture(name, "instrumented")
    assert inst.returncode == plain.returncode
    assert inst.stdout == plain.stdout
    # warning locations differ (the hook frame is the caller; CONTRACTS section 3): compare text
    assert _last_line(inst.stderr) == _last_line(plain.stderr)


# -- review fixes: false wires --------------------------------------------------------------


@pytest.mark.parametrize(
    "code",
    [
        "a, *b = f(x)",
        "a, b = c = f(1)",
        "x[0], y = f(1)",
        "a, b = c",
        "(a, b), c = f(1), 2",
    ],
)
def test_destructuring_binds_have_no_value(code: str) -> None:
    for s in kind(code, "bind") + kind(code, "store"):
        assert "value" not in s, code
    assert all("unpack" not in s for s in kind(code, "call"))


def test_plain_name_targets_keep_value() -> None:
    assert kind("x = f()", "bind")[0]["value"] == {"origin": "call", "site": 0}
    assert kind("a = b = f()", "bind")[0]["value"] == {"origin": "call", "site": 0}
    assert kind("a, b = f()", "bind")[0]["value"] == {"origin": "call", "site": 0}


def test_comprehension_target_is_not_a_name_origin() -> None:
    (s,) = kind("n = 5; ys = [f(n) for n in [5]]", "call")
    assert s["args"] == [{"origin": "expr", "text": "n", "reads": []}]
    (s,) = kind("ys = [f(n + k) for n in z]", "call")
    assert s["args"][0]["reads"] == ["k"]
    # outside the comprehension the name is still a name
    assert kind("[g(n) for n in z]; f(n)", "call")[-1]["args"] == [{"origin": "name", "name": "n"}]


def test_class_body_assigned_name_is_not_a_name_origin() -> None:
    source = "x = 5\nclass A:\n    x = 5\n    y = f(x)\n    z = f(w + x)\nf(x)"
    a, b, c = kind(source, "call")
    assert a["args"] == [{"origin": "expr", "text": "x", "reads": []}]
    assert b["args"][0]["reads"] == ["w"]
    assert c["args"] == [{"origin": "name", "name": "x"}]


def test_store_index_operands_and_expr_calls() -> None:
    (st,) = kind('df.loc[mask, "c"] = 0', "store")
    assert st["index"] == [{"origin": "name", "name": "mask"}]
    (st,) = kind("a[i], i = 1, 2", "store")
    assert "index" not in st  # `i` is rebound by the statement
    (st,) = kind("a[(j := 1)] = 2", "store")
    assert "index" not in st
    (st,) = kind("d[f(x)] = 0", "store")
    assert st["index"] == [{"origin": "call", "site": 0}]
    (b,) = kind("m = [('s', S()), (t, g(h(1)))]", "bind")
    assert b["value"]["calls"] == [0, 2]
    # conditional, short-circuit and lambda calls are never listed
    (b,) = kind("m = [a if c else f(1), c and g(1), lambda: h(1)]", "bind")
    assert "calls" not in b["value"]
    (b,) = kind("m = [x > f(1), g(2) or h(3)]", "bind")
    assert b["value"]["calls"] == [0, 1]


def _volatile_binds(src: str) -> set[str]:
    out: set[str] = set()
    for site in instrument(src).sites:
        if site["kind"] == "bind" and site.get("volatile"):
            out.update(site["targets"])
    return out


@pytest.mark.parametrize(
    ("src", "expected"),
    [
        ("a = 1\nb = a\n", set()),
        ("a = 1\nb = a\ndel b\n", {"b"}),
        ("k = 1\ndef g():\n    global k\n    k = 2\n", {"k"}),
        ("b = 1\nif (b := 2):\n    pass\n", {"b"}),
        ("a = 1\nimport os as a\n", {"a"}),
        ("a = 1\nb = 2\nglobals()\n", {"a", "b"}),
        ("a = 1\nexec('a = 2')\n", {"a"}),
        ("a = 1\nfrom m import *\n", {"a"}),
        ("import sys\nk1 = 1\nsys.modules[__name__].k1 = 2\n", {"k1"}),
        ("k2 = 1\nsetattr(object(), 'k2', 2)\n", {"k2"}),
        ("import sys\nk3 = 1\nsys.modules['__main__'].__dict__['k3'] = 2\n", {"k3"}),
        ("import __main__\nk4 = 1\n__main__.k4 = 2\n", {"k4"}),
        ("from importlib import import_module\nk5 = 1\n", {"k5"}),
        ("k6 = 1\nx = k6.__dict__\n", {"k6", "x"}),
        ("k7 = 1\ndelattr(object(), 'k7')\n", {"k7"}),
    ],
)
def test_volatile_bind_sites(src: str, expected: set[str]) -> None:
    # svl-35d: a bind site is volatile when its name can be rebound or unbound unseen
    assert _volatile_binds(src) == expected
