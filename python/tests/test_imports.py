"""Imports (CONTRACTS section 3, "Imports"): `import` sites for the graph, and transparency."""

from __future__ import annotations

import ast
import builtins
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from test_transparency import describe_ns, run_instrumented, run_plain

from machines.transform import instrument


def imports(source: str) -> list[dict[str, Any]]:
    return [s for s in instrument(source).sites if s["kind"] == "import"]


def bindings(source: str) -> dict[str, dict[str, Any]]:
    return {b["name"]: b for s in imports(source) for b in s["imports"]}


def test_forms_and_fields() -> None:
    b = bindings(
        "import numpy\nimport pandas as pd\nimport os.path\nimport a.b as c\n"
        "from sklearn.linear_model import LinearRegression, Ridge as R\n"
    )
    assert b["numpy"] == {"name": "numpy", "module": "numpy", "attr": None, "sole": True}
    assert b["pd"]["module"] == "pandas" and b["pd"]["attr"] is None
    assert b["os"]["module"] == "os"
    assert b["c"]["module"] == "a.b"
    assert b["LinearRegression"]["module"] == "sklearn.linear_model"
    assert b["LinearRegression"]["attr"] == "LinearRegression"
    assert b["R"]["attr"] == "Ridge"
    assert all(x["sole"] for x in b.values())


def test_site_position_and_ids_are_appended() -> None:
    ins = instrument("import numpy as np\nx = np.zeros(2)\n")
    assert [s["kind"] for s in ins.sites] == ["call", "bind", "import"]
    assert [s["id"] for s in ins.sites] == [0, 1, 2]
    imp = ins.sites[2]
    assert (imp["line"], imp["col"], imp["end_line"], imp["end_col"]) == (1, 0, 1, 18)
    assert imp["text"] == "import numpy as np"


@pytest.mark.parametrize(
    "source",
    [
        "import numpy as np\nnp = 3\n",  # rebound by assignment
        "import numpy as np\nimport pandas as np\n",  # two imports of one name
        "import numpy as np\nfor np in range(2): pass\n",
        "import numpy as np\ndef np(): pass\n",
        "import numpy as np\nclass np: pass\n",
        "import numpy as np\nwith open('f') as np: pass\n",
        "import numpy as np\ndef f(np): return np\n",  # a parameter shadows it in f
        "import numpy as np\ndef f():\n    global np\n    np = 1\n",
        "import numpy as np\ntry:\n    pass\nexcept Exception as np:\n    pass\n",
        "import numpy as np\n(np := 1)\n",
        "import numpy as np\ndel np\n",
        "import numpy as np\nif 1:\n    import pandas as np\n",  # nested rebind
        "import numpy as np\nfrom os import *\n",  # a star import may rebind anything
        "import numpy as np\n[np for np in range(2)]\n",
    ],
)
def test_rebound_names_are_not_sole(source: str) -> None:
    assert bindings(source)["np"]["sole"] is False


def test_module_scope_statements_have_sites_function_and_class_bodies_do_not() -> None:
    src = (
        "if 1:\n    import os\ndef f():\n    import sys\nclass C:\n    import re\n"
        "try:\n    import json\nexcept ImportError:\n    pass\n"
        "for i in range(2):\n    import abc\n"
    )
    assert [s["imports"][0]["name"] for s in imports(src)] == ["os", "json", "abc"]
    # the nested names count as bindings, so a module-level one of the same name is not sole
    assert bindings("import os\nif 1:\n    import os\n")["os"]["sole"] is False


def test_future_and_relative_imports_have_no_site() -> None:
    assert imports("from __future__ import annotations\nfrom . import x\nfrom .m import y\n") == []


def test_import_is_wrapped_by_hooks_and_not_rewritten() -> None:
    src = "import os\nfrom sys import path as p\nx = os.getcwd()\nfrom os import *\n"
    out = ast.unparse(instrument(src).tree).splitlines()
    assert out[:6] == [
        "__imp__(2, True)",
        "import os",
        "__imp__(2)",
        "__imp__(3, True)",
        "from sys import path as p",
        "__imp__(3)",
    ]
    assert out[-1] == "from os import *"  # a star binds nothing: no hook


# -- transparency: imports behave exactly like plain Python ----------------------------------

MODULE = """\
import builtins
print("sidefx loading")
builtins._sidefx_count = getattr(builtins, "_sidefx_count", 0) + 1
def f(x):
    return x * 2
"""

PROGRAMS = {
    "side_effects_once": (
        "import sidefx\nimport sidefx\nimport sidefx as s2\nfrom sidefx import f as g\n"
        "print(g(2), s2 is sidefx)\n"
    ),
    "dunder_import": "m = __import__('sidefx')\nimport sidefx\nprint(m is sidefx, m.f(3))\n",
    "conditional": (
        "try:\n    import not_there_xyz\nexcept ImportError:\n    not_there_xyz = None\n"
        "if False:\n    import sidefx\nprint(not_there_xyz, 'sidefx' in globals())\n"
    ),
    "reimport_after_del": "import sidefx\ndel sidefx\nimport sidefx\nprint(sidefx.f(1))\n",
    "rebound": "import sidefx as m\nprint(m.f(1))\nm = 5\nprint(m)\n",
    "call_before_import": "print(len('ab'))\nfrom builtins import len\nprint(len('abc'))\n",
    "attribute_chain": "import os.path\nimport sidefx\nprint(os.path.join('a'), sidefx.f(4))\n",
    "failing_import": "import sidefx\nimport not_there_xyz\nprint('unreached')\n",
    "star": "from sidefx import *\nprint(f(5))\n",
    "import_in_function": "def h():\n    import sidefx\n    return sidefx.f(6)\nprint(h())\n",
}


@pytest.fixture
def sidefx_module(tmp_path: Path) -> Iterator[None]:
    (tmp_path / "sidefx.py").write_text(MODULE)
    sys.path.insert(0, str(tmp_path))
    yield
    sys.path.remove(str(tmp_path))
    sys.modules.pop("sidefx", None)


@pytest.mark.parametrize("name", sorted(PROGRAMS))
def test_imports_behave_like_plain_python(name: str, sidefx_module: None) -> None:
    source = PROGRAMS[name]
    sys.modules.pop("sidefx", None)
    builtins._sidefx_count = 0  # type: ignore[attr-defined]
    plain = run_plain(source)
    plain_count = builtins._sidefx_count  # type: ignore[attr-defined]
    sys.modules.pop("sidefx", None)
    builtins._sidefx_count = 0  # type: ignore[attr-defined]
    inst = run_instrumented(source)
    inst_count = builtins._sidefx_count  # type: ignore[attr-defined]
    assert inst.stdout == plain.stdout
    assert inst.err == plain.err
    assert inst_count == plain_count  # the module body ran the same number of times
    assert describe_ns(inst.ns) == describe_ns(plain.ns)


# -- recorder: each executed import statement is one `import` event (a timeline step) ---------


def import_events(source: str, **cfg: Any) -> list[dict[str, Any]]:
    from test_recorder import record

    r = record(source, prelude=False, **cfg)
    return [e for e in r.events if e["kind"] == "import"]


def test_each_import_statement_is_one_step_in_execution_order() -> None:
    from test_recorder import record

    r = record("import os\nx = len('ab')\nfrom sys import path as p, argv\n", prelude=False)
    assert [(e["kind"], e["name"]) for e in r.events if e["kind"] == "import"] == [
        ("import", "import os"),
        ("import", "from sys import path as p, argv"),
    ]
    ev = r.events[0]
    assert ev["inputs"] == [] and ev["outputs"] == [] and ev["module"] is None
    assert ev["merge_key"] == f"s{ev['site']}" and ev["error"] is None


def test_conditional_import_that_does_not_run_gives_no_step() -> None:
    src = "if False:\n    import os\ntry:\n    import nope_xyz\nexcept ImportError:\n    pass\n"
    assert import_events(src) == []


def test_conditional_import_that_runs_and_repeated_import_one_step_per_execution() -> None:
    evs = import_events("for k in range(3):\n    import os\nif True:\n    import sys\n")
    assert [e["name"] for e in evs] == ["import os"] * 3 + ["import sys"]
    assert [e["count"] for e in evs[:3]] == [1, 2, 3]


def test_star_function_level_and_relative_imports_give_no_step() -> None:
    src = (
        "from os.path import *\ndef f():\n    import sys\nf()\nclass C:\n    import re\n"
        "from __future__ import annotations\n"
    )
    # (`__future__` after other statements is a SyntaxError in plain Python too; leave it out)
    src = src.rsplit("from __future__", 1)[0]
    assert import_events(src) == []


def test_failed_import_gives_no_step_and_the_same_error() -> None:
    from test_recorder import plain, record

    src = "import os\nimport not_there_xyz\n"
    r = record(src, prelude=False)
    assert [e["name"] for e in r.events if e["kind"] == "import"] == ["import os"]
    assert type(r.err) is type(plain(src, prelude=False).err) is ModuleNotFoundError


def test_import_steps_count_toward_the_event_cap() -> None:
    from test_recorder import record

    r = record("import os\nimport sys\nimport re\n", prelude=False, max_events=2)
    assert r.rec.limit_hit is True
    assert [e["name"] for e in r.events] == ["import os", "import sys"]


@pytest.mark.parametrize("name", sorted(PROGRAMS))
def test_imports_behave_like_plain_python_under_the_recorder(
    name: str, sidefx_module: None
) -> None:
    from test_recorder import plain, record

    source = PROGRAMS[name]
    sys.modules.pop("sidefx", None)
    builtins._sidefx_count = 0  # type: ignore[attr-defined]
    p = plain(source, prelude=False)
    plain_count = builtins._sidefx_count  # type: ignore[attr-defined]
    sys.modules.pop("sidefx", None)
    builtins._sidefx_count = 0  # type: ignore[attr-defined]
    r = record(source, prelude=False)
    assert r.stdout == p.stdout
    assert type(r.err) is type(p.err) and str(r.err) == str(p.err)
    assert builtins._sidefx_count == plain_count  # type: ignore[attr-defined]
    assert describe_ns(r.ns) == describe_ns(p.ns)
    assert not r.log["diagnostics"]


def test_import_in_a_long_loop_does_not_use_up_the_budget() -> None:
    from test_recorder import plain, record

    src = "import numpy as np\nfor k in range(5000):\n    import os\nx = np.zeros(2)\nprint(x)\n"
    r = record(src, prelude=False)
    assert r.log["status"] != "limit" and r.rec.limit_hit is False
    assert [e["name"] for e in r.events if e["name"] == "zeros"] == ["zeros"]
    assert len([e for e in r.events if e["name"] == "import os"]) == 20
    assert r.stdout == plain(src, prelude=False).stdout and r.err is None


# -- output printed while an import runs (svl-wqe) -------------------------------------------


@pytest.fixture
def chatty_modules(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    (tmp_path / "chatty_a.py").write_text(
        "import sys, warnings\nprint('a loads')\nimport chatty_b\n"
        "print('err', file=sys.stderr)\nwarnings.warn('careful', FutureWarning)\n"
    )
    (tmp_path / "chatty_b.py").write_text("print('b loads')\n")
    (tmp_path / "chatty_bad.py").write_text("print('bad loads')\nraise ValueError('nope')\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    for m in ("chatty_a", "chatty_b", "chatty_bad"):
        sys.modules.pop(m, None)
    yield
    for m in ("chatty_a", "chatty_b", "chatty_bad"):
        sys.modules.pop(m, None)


def _out(log: dict[str, Any]) -> list[tuple[int, str]]:
    return [(o["i"], o["stream"]) for o in log["output"]]


def test_import_output_is_tagged_with_the_import_step(chatty_modules: None) -> None:
    from machines import record

    log = record("import chatty_a\nprint('after')\n")
    assert [e["name"] for e in log["events"]] == ["import chatty_a"]
    # nested import output, stderr and the warning all belong to the import step
    assert _out(log) == [(0, "stdout"), (0, "stderr"), (0, "warning"), (0, "stdout")]
    assert log["output"][0]["text"] == "a loads\nb loads\n"
    assert log["output"][3]["text"] == "after\n"


def test_import_output_after_earlier_output_and_events(chatty_modules: None) -> None:
    from machines import record

    log = record("import os\nprint('first')\nimport chatty_b\nprint('last')\n")
    assert {e["name"]: e["i"] for e in log["events"]} == {"import os": 0, "import chatty_b": 1}
    # 'first' stays with the previous step, the import's text moves to its own step
    assert [(o["i"], o["text"]) for o in log["output"]] == [
        (0, "first\n"),
        (1, "b loads\n"),
        (1, "last\n"),
    ]


def test_first_statement_import_output_is_not_tagged_before_any_event(
    chatty_modules: None,
) -> None:
    from machines import record

    log = record("import chatty_b\n")
    assert [(o["i"], o["text"]) for o in log["output"]] == [(0, "b loads\n")]


def test_failed_import_output_stays_with_the_previous_step(chatty_modules: None) -> None:
    from machines import record

    src = "import os\ntry:\n    import chatty_bad\nexcept ValueError:\n    print('caught')\n"
    log = record(src)
    assert [e["name"] for e in log["events"]] == ["import os"]
    assert [(o["i"], o["text"]) for o in log["output"]] == [(0, "bad loads\ncaught\n")]


def test_failed_first_import_keeps_the_no_event_tag(chatty_modules: None) -> None:
    from machines import record

    log = record("try:\n    import chatty_bad\nexcept ValueError:\n    pass\n")
    assert log["events"] == []
    assert [(o["i"], o["text"]) for o in log["output"]] == [(-1, "bad loads\n")]


def test_star_import_output_is_not_a_step(chatty_modules: None) -> None:
    from machines import record

    log = record("import os\nfrom chatty_b import *\n")
    assert [e["name"] for e in log["events"]] == ["import os"]
    assert [(o["i"], o["text"]) for o in log["output"]] == [(0, "b loads\n")]


def test_import_this_output() -> None:
    from machines import record

    sys.modules.pop("this", None)
    log = record("print('x')\nimport this\n")
    sys.modules.pop("this", None)
    assert [(o["i"], o["text"][:3]) for o in log["output"]] == [(-1, "x\n"), (0, "The")]


def test_import_past_per_site_does_not_split_merged_output() -> None:
    from test_recorder import plain

    from machines import record

    src = "for i in range(25):\n    import os\n    print(i)\n"
    log = record(src)
    p = plain(src, prelude=False)
    # runs 0..19 each have a step; the later runs' prints merge into run 19's entry
    assert [o["i"] for o in log["output"]] == list(range(20))
    assert log["output"][-1]["text"] == "19\n20\n21\n22\n23\n24\n"
    assert "".join(o["text"] for o in log["output"]) == p.stdout


def test_dotted_binding_names_the_full_module() -> None:
    b = bindings("import os.path\nimport xml.dom.minidom\nimport json\nimport a.b as c\n")
    assert b["os"]["dotted"] == "os.path"  # `import a.b` binds `a`; a.b is a module
    assert b["xml"]["dotted"] == "xml.dom.minidom"
    assert "dotted" not in b["json"] and "dotted" not in b["c"]


def test_submodules_are_recorded_only_for_real_submodules() -> None:
    src = (
        "from xml import dom\n"  # a submodule
        "from os import path\n"  # a module, but posixpath, not os.path
        "from json import loads\n"  # a function
        "from collections import abc, OrderedDict as OD\n"  # abc is a submodule, OD a class
        "import json\n"
    )
    evs = import_events(src)
    assert [e.get("submodules") for e in evs] == [["dom"], None, None, ["abc"], None]


def test_submodule_check_runs_no_student_code() -> None:
    # A module whose class overrides __getattribute__ / __eq__ must not be consulted.
    src = (
        "import sys, types\n"
        "class M(types.ModuleType):\n"
        "    def __getattribute__(self, n):\n"
        "        raise RuntimeError(n)\n"
        "sys.modules['evil_pkg'] = m = M('evil_pkg')\n"
        "sys.modules['evil_pkg.sub'] = s = M('evil_pkg.sub')\n"
        "object.__setattr__(m, '__path__', [])\n"
        "object.__setattr__(m, 'sub', s)\n"
        "from evil_pkg import sub\n"
    )
    evs = import_events(src)
    assert evs[-1].get("submodules") is None
