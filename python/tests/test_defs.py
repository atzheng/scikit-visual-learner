"""Definitions (CONTRACTS section 3, "Definitions"): `def` / `class` sites, steps, transparency."""

from __future__ import annotations

from typing import Any

import pytest
from test_transparency import describe_ns, run_instrumented, run_plain

from machines.transform import instrument


def defs(source: str) -> list[dict[str, Any]]:
    return [s for s in instrument(source).sites if s["kind"] == "def"]


def def_events(source: str, **cfg: Any) -> list[dict[str, Any]]:
    from test_recorder import record

    r = record(source, prelude=False, **cfg)
    return [e for e in r.log["events"] if e["kind"] == "def"]


def test_function_site_fields() -> None:
    (s,) = defs("def f(x, y=2, *a, k=None, **kw):\n    return x\n")
    assert s["def"] == {
        "name": "f",
        "kind": "function",
        "signature": "f(x, y=2, *a, k=None, **kw)",
        "decorated": False,
        "link": True,
    }
    assert s["line"] == 1 and s["end_line"] == 2


def test_class_site_fields() -> None:
    (s,) = defs(
        "class C:\n    def __init__(self, a, b=1): pass\n    def fit(self): pass\n"
        "    def predict(self): pass\n    def __repr__(self): return ''\n"
    )
    assert s["def"]["signature"] == "C(a, b=1)"
    assert s["def"]["methods"] == ["fit", "predict"]
    (e,) = defs("class E: pass\n")
    assert e["def"]["signature"] == "E()" and e["def"]["methods"] == []
    (b,) = defs("class D(object): pass\n")
    assert b["def"]["signature"] == "D(…)"


def test_def_sites_are_appended_after_import_sites() -> None:
    ins = instrument("import os\ndef f(): pass\nx = f()\n")
    assert [s["kind"] for s in ins.sites] == ["call", "bind", "import", "def"]


def test_nested_and_method_defs_are_not_sites() -> None:
    src = (
        "def f():\n    def g(): pass\n    class K: pass\n"
        "class C:\n    def m(self): pass\n    class In: pass\n"
    )
    assert [s["def"]["name"] for s in defs(src)] == ["f", "C"]


def test_conditional_defs_are_sites_lambda_is_not() -> None:
    src = "if True:\n    def a(): pass\nfor i in range(2):\n    class B: pass\nc = lambda: 1\n"
    assert [s["def"]["name"] for s in defs(src)] == ["a", "B"]


@pytest.mark.parametrize(
    ("source", "link"),
    [
        ("def f(): pass\n", True),
        ("def f(): pass\ndef f(): pass\n", True),  # two defs, nothing else: the latest one run
        ("def f(): pass\nf = 3\n", False),
        ("import os as f\ndef f(): pass\n", False),
        ("@d\ndef f(): pass\n", False),  # decorated: the name is bound to the decorator's result
        ("@d\ndef f(): pass\ndef f(): pass\n", False),
        ("def f(): pass\ndef g():\n    global f\n    f = 1\n", False),
        ("def f(): pass\ndef g(f): return f\n", False),
        ("def f(): pass\ndel f\n", False),
        ("def f(): pass\nif (f := 1): pass\n", False),
        ("def f(): pass\nglobals()['f'] = 1\n", False),
        ("def f(): pass\nfrom os import *\n", False),
        ("def f(): pass\nfor f in range(2): pass\n", False),
        ("def f(): pass\ndef g():\n    def f(): pass\n", False),  # a nested def of the same name
    ],
)
def test_link_only_when_the_name_is_certainly_the_def(source: str, link: bool) -> None:
    assert defs(source)[0]["def"]["link"] is link


# -- recorder ---------------------------------------------------------------------------------


def test_each_def_and_class_statement_that_runs_is_one_step() -> None:
    evs = def_events("def f(x, y=2): pass\nclass C:\n    def fit(self): pass\n")
    assert [(e["name"], e["kind"]) for e in evs] == [("f", "def"), ("C", "def")]
    e = evs[0]
    assert e["inputs"] == [] and e["outputs"] == [] and e["module"] is None and e["owner"] is None
    assert e["merge_key"] == f"s{e['site']}" and e["error"] is None and e["scope"] == 0


def test_redefinition_and_conditional_def() -> None:
    evs = def_events("def f(): pass\ndef f(): pass\nif False:\n    def g(): pass\n")
    assert [e["name"] for e in evs] == ["f", "f"]
    assert evs[0]["site"] != evs[1]["site"]


def test_def_in_a_loop_counts_each_run() -> None:
    evs = def_events("for i in range(3):\n    def f(): pass\n")
    assert [e["count"] for e in evs] == [1, 2, 3]


def test_decorated_def_is_a_step_after_the_decorator_ran() -> None:
    from test_recorder import record

    r = record("def deco(f):\n    return f\n@deco\ndef g(): pass\n", prelude=False)
    assert [e["name"] for e in r.log["events"] if e["kind"] == "def"] == ["deco", "g"]


def test_failed_class_body_or_decorator_gives_no_step() -> None:
    assert def_events("class C:\n    x = 1 / 0\n") == []
    src = "def d(f): raise ValueError('no')\n@d\ndef g(): pass\n"
    assert [e["name"] for e in def_events(src)] == ["d"]


def test_def_steps_count_toward_the_event_cap() -> None:
    from test_recorder import record

    r = record("def a(): pass\ndef b(): pass\ndef c(): pass\n", prelude=False, max_events=2)
    assert r.rec.limit_hit is True


def test_student_calls_are_still_recorded_next_to_the_def() -> None:
    from test_recorder import record

    r = record("def f(x):\n    return x\nclass C: pass\nf(1)\nC()\n", prelude=False)
    assert [(e["kind"], e["name"]) for e in r.log["events"]] == [
        ("def", "f"),
        ("def", "C"),
        ("student_function", "f"),
        ("constructor", "C"),
    ]


def test_output_printed_by_a_class_body_belongs_to_its_step() -> None:
    from machines import record

    log = record("print('before')\nclass C:\n    print('in body')\nprint('after')\n")
    (e,) = [e for e in log["events"] if e["kind"] == "def"]
    assert [(o["i"], o["text"]) for o in log["output"]] == [
        (-1, "before\n"),
        (e["i"], "in body\n"),
        (e["i"], "after\n"),
    ]


# -- transparency -------------------------------------------------------------------------------

PROGRAMS = {
    "plain": "def f(x, y=2):\n    return x + y\nprint(f(1))\n",
    "class": (
        "class C:\n    def __init__(self, a): self.a = a\n    def get(self): return self.a\n"
        "print(C(3).get())\n"
    ),
    "decorated": (
        "import functools\n@functools.lru_cache(maxsize=None)\ndef f(n):\n    return n * 2\n"
        "print(f(2), f(2), f.cache_info().hits)\n"
    ),
    "class_decorator": (
        "from dataclasses import dataclass\n@dataclass\nclass P:\n    x: int = 1\n"
        "print(P(), P(2))\n"
    ),
    "redefinition": "def f(): return 1\nprint(f())\ndef f(): return 2\nprint(f())\n",
    "conditional": "if False:\n    def f(): return 1\nelse:\n    def f(): return 2\nprint(f())\n",
    "defaults_run_once": "n = []\ndef f(a=n.append(1) or n): return a\nprint(f(), f(), n)\n",
    "class_body_side_effect": "class C:\n    print('body')\n    x = 3\nprint(C.x)\n",
    "failing_class_body": "print('a')\nclass C:\n    x = 1 / 0\nprint('unreached')\n",
    "failing_decorator": "def d(f): raise KeyError('k')\n@d\ndef g(): pass\n",
    "error_in_function": "def f():\n    return 1 / 0\nf()\n",
    "async": "async def f(): return 1\nc = f()\nprint(type(c).__name__)\nc.close()\n",
    "generator": "def g():\n    yield 1\n    yield 2\nprint(list(g()))\n",
    "name_in_loop": "for i in range(3):\n    def f(i=i): return i\nprint(f())\n",
    "method_names": (
        "class C:\n    def a(self): pass\n    b = 3\n    def c(self): pass\n"
        "print(sorted(vars(C)))\n"
    ),
}


@pytest.mark.parametrize("name", sorted(PROGRAMS))
def test_defs_behave_like_plain_python(name: str) -> None:
    source = PROGRAMS[name]
    plain = run_plain(source)
    inst = run_instrumented(source)
    assert inst.stdout == plain.stdout
    assert inst.err == plain.err
    assert describe_ns(inst.ns) == describe_ns(plain.ns)


def test_traceback_line_is_unchanged() -> None:
    from machines import runtime

    src = "def f():\n    return 1 / 0\n\n\nclass C:\n    pass\n\n\nf()\n"
    msgs: list[dict[str, Any]] = []
    runtime.run(src, {}, msgs.append)
    done = msgs[-1]
    assert done["status"] == "error"
    assert done["error"]["type"] == "ZeroDivisionError"
    assert done["error"]["line"] == 2
