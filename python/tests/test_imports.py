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


def test_import_is_followed_by_a_hook_and_not_rewritten() -> None:
    src = "import os\nfrom sys import path as p\nx = os.getcwd()\nfrom os import *\n"
    out = ast.unparse(instrument(src).tree).splitlines()
    assert out[:4] == ["import os", "__imp__(2)", "from sys import path as p", "__imp__(3)"]
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
