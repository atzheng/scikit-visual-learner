# ruff: noqa: E501
"""Docs source (svl-095): numpydoc parser, URL builder and resolution, against the installed docstrings."""

from __future__ import annotations

import json

import pytest

from machines.docs import doc_url, docs, library_versions, parse_numpydoc

V = {
    "python": "3.14.2",
    "sklearn": "1.8.0",
    "pandas": "3.0.2",
    "numpy": "2.4.6",
    "scipy": "1.18.0",
    "matplotlib": "3.10.8",
}


def section(d: dict, title: str) -> dict:
    return next(s for s in d["sections"] if s["title"] == title)


def entry_names(d: dict, title: str) -> list[str]:
    return [e["name"] for e in section(d, title)["entries"]]


# -- parser on synthetic text ----------------------------------------------------------------


def test_parse_basic_numpydoc() -> None:
    p = parse_numpydoc(
        """Add two numbers.

        Longer text that is
        wrapped over lines.

        Parameters
        ----------
        a : int, default=1
            First :class:`~pkg.Thing` value.
        b
            Second.

        Returns
        -------
        int
            The sum.

        Raises
        ------
        ValueError
            If bad.

        See Also
        --------
        sub : Subtract.
        mul

        Examples
        --------
        >>> add(1, 2)
        3

        Some text.
        """
    )
    assert p["source"] == "numpydoc"
    assert p["summary"] == "Add two numbers."
    assert p["description"] == "Longer text that is wrapped over lines."
    sections = {s["title"]: s for s in p["sections"]}
    assert sections["Parameters"]["entries"] == [
        {"name": "a", "type": "int, default=1", "desc": "First Thing value."},
        {"name": "b", "type": "", "desc": "Second."},
    ]
    assert sections["Returns"]["entries"] == [{"name": "", "type": "int", "desc": "The sum."}]
    assert sections["Raises"]["entries"][0]["type"] == "ValueError"
    assert sections["See Also"]["items"] == [
        {"name": "sub", "desc": "Subtract."},
        {"name": "mul", "desc": ""},
    ]
    assert sections["Examples"]["blocks"] == [
        {"kind": "code", "text": ">>> add(1, 2)\n3"},
        {"kind": "text", "text": "Some text."},
    ]


def test_plain_and_none() -> None:
    p = parse_numpydoc("Just a sentence.\n\nAnd more.")
    assert p["source"] == "plain" and p["summary"] == "Just a sentence." and p["sections"] == []
    assert parse_numpydoc("")["source"] == "none"
    assert parse_numpydoc(None)["source"] == "none"  # type: ignore[arg-type]


def test_parser_never_raises_on_odd_text() -> None:
    for text in ["----", "x\n---\n", "Parameters\n----------", "\n\n  indented\n", ":ref:`a <b>`"]:
        parse_numpydoc(text)


# -- URL builder: exact strings --------------------------------------------------------------


@pytest.mark.parametrize(
    ("qualname", "kind", "url"),
    [
        (
            "sklearn.linear_model.LinearRegression",
            "class",
            "https://scikit-learn.org/1.8/modules/generated/sklearn.linear_model.LinearRegression.html",
        ),
        (
            "sklearn.linear_model.LinearRegression.fit",
            "method",
            "https://scikit-learn.org/1.8/modules/generated/sklearn.linear_model.LinearRegression.html"
            "#sklearn.linear_model.LinearRegression.fit",
        ),
        (
            "sklearn.model_selection.train_test_split",
            "function",
            "https://scikit-learn.org/1.8/modules/generated/sklearn.model_selection.train_test_split.html",
        ),
        (
            "pandas.read_csv",
            "function",
            "https://pandas.pydata.org/pandas-docs/version/3.0.2/reference/api/pandas.read_csv.html",
        ),
        (
            "pandas.DataFrame.mean",
            "method",
            "https://pandas.pydata.org/pandas-docs/version/3.0.2/reference/api/pandas.DataFrame.mean.html",
        ),
        ("numpy.mean", "function", "https://numpy.org/doc/2.4/reference/generated/numpy.mean.html"),
        (
            "numpy.ndarray.mean",
            "method",
            "https://numpy.org/doc/2.4/reference/generated/numpy.ndarray.mean.html",
        ),
        (
            "scipy.optimize.minimize",
            "function",
            "https://docs.scipy.org/doc/scipy-1.18.0/reference/generated/scipy.optimize.minimize.html",
        ),
        (
            "matplotlib.pyplot.plot",
            "function",
            "https://matplotlib.org/3.10.8/api/_as_gen/matplotlib.pyplot.plot.html",
        ),
        ("builtins.len", "function", "https://docs.python.org/3.14/library/functions.html#len"),
        ("builtins.list", "class", "https://docs.python.org/3.14/library/functions.html#func-list"),
        (
            "builtins.str.join",
            "method",
            "https://docs.python.org/3.14/library/stdtypes.html#str.join",
        ),
        (
            "builtins.ValueError",
            "class",
            "https://docs.python.org/3.14/library/exceptions.html#ValueError",
        ),
    ],
)
def test_doc_url_exact(qualname: str, kind: str, url: str) -> None:
    assert doc_url(qualname, kind, V) == url


def test_doc_url_none_cases() -> None:
    assert (
        doc_url("sklearn.linear_model._base.LinearRegression", "class", V) is None
    )  # private path
    assert doc_url("somelib.thing", "function", V) is None
    assert doc_url("builtins.nosuchthing", "function", V) is None
    assert doc_url("sklearn.linear_model.Ridge", "class", {**V, "sklearn": "1.9.dev0"}) is None
    assert doc_url("pandas.read_csv", "function", {"python": "3.14.2"}) is None  # not loaded


# -- real installed docstrings (same versions as Pyodide) ------------------------------------


def test_pinned_versions_match_the_url_tests() -> None:
    import matplotlib
    import pandas
    import scipy
    import sklearn

    v = library_versions()
    assert v["sklearn"] == V["sklearn"] and v["pandas"] == V["pandas"]
    assert v["scipy"] == V["scipy"] and v["matplotlib"] == matplotlib.__version__ == V["matplotlib"]
    assert pandas and scipy and sklearn


def test_linear_regression_class() -> None:
    d = docs("sklearn.linear_model._base", "LinearRegression")
    assert d["qualname"] == "sklearn.linear_model.LinearRegression"
    assert d["kind"] == "class" and d["source"] == "numpydoc"
    assert d["summary"] == "Ordinary least squares Linear Regression."
    assert entry_names(d, "Parameters") == ["fit_intercept", "copy_X", "tol", "n_jobs", "positive"]
    assert "coef_" in entry_names(d, "Attributes")
    assert d["signature"].startswith("LinearRegression(*, fit_intercept=True")
    assert d["url"].endswith("/sklearn.linear_model.LinearRegression.html")
    assert section(d, "Examples")["blocks"][0]["kind"] == "code"


def test_linear_regression_fit_method() -> None:
    d = docs("sklearn.linear_model._base", "LinearRegression.fit")
    assert d["kind"] == "method" and d["signature"] == "fit(X, y, sample_weight=None)"
    assert entry_names(d, "Parameters") == ["X", "y", "sample_weight"]
    assert section(d, "Returns")["entries"][0]["name"] == "self"
    assert d["url"].endswith("LinearRegression.html#sklearn.linear_model.LinearRegression.fit")


def test_method_inherited_from_a_base_class_uses_the_owner_page() -> None:
    d = docs("sklearn.linear_model._ridge", "Ridge.predict")
    assert d["qualname"] == "sklearn.linear_model.Ridge.predict"
    assert d["source"] == "numpydoc" and d["summary"]
    assert d["url"].endswith("Ridge.html#sklearn.linear_model.Ridge.predict")


def test_pandas_read_csv_resolves_to_public_path() -> None:
    d = docs("pandas.io.parsers.readers", "read_csv")
    assert d["qualname"] == "pandas.read_csv"
    names = entry_names(d, "Parameters")
    assert names[0] == "filepath_or_buffer" and "sep" in names and len(names) > 30
    assert (
        d["url"]
        == f"https://pandas.pydata.org/pandas-docs/version/{V['pandas']}/reference/api/pandas.read_csv.html"
    )
    assert section(d, "Returns")["entries"]


def test_pandas_dataframe_method() -> None:
    d = docs("pandas.core.frame", "DataFrame.mean")
    assert d["qualname"] == "pandas.DataFrame.mean" and d["kind"] == "method"
    assert "axis" in entry_names(d, "Parameters")
    assert section(d, "See Also")["items"]


def test_numpy_mean() -> None:
    d = docs("numpy", "mean")
    assert d["qualname"] == "numpy.mean" and d["source"] == "numpydoc"
    assert entry_names(d, "Parameters")[:2] == ["a", "axis"]
    assert d["url"] == "https://numpy.org/doc/2.4/reference/generated/numpy.mean.html"


def test_numpy_method_signature_line_is_not_the_summary() -> None:
    d = docs("numpy", "ndarray.mean")
    assert d["qualname"] == "numpy.ndarray.mean"
    assert not d["summary"].startswith("a.mean(")


def test_train_test_split() -> None:
    d = docs("sklearn.model_selection._split", "train_test_split")
    assert d["qualname"] == "sklearn.model_selection.train_test_split"
    assert entry_names(d, "Parameters")[0] == "*arrays"
    assert d["url"].endswith("/sklearn.model_selection.train_test_split.html")


def test_scipy_and_matplotlib() -> None:
    d = docs("scipy.optimize._minimize", "minimize")
    assert d["qualname"] == "scipy.optimize.minimize" and d["source"] == "numpydoc"
    assert (
        d["url"]
        == f"https://docs.scipy.org/doc/scipy-{V['scipy']}/reference/generated/scipy.optimize.minimize.html"
    )
    m = docs("matplotlib.axes._axes", "Axes.plot")
    assert m["qualname"] == "matplotlib.axes.Axes.plot"
    p = docs("matplotlib.pyplot", "plot")
    assert p["qualname"] == "matplotlib.pyplot.plot" and p["summary"]


def test_builtins() -> None:
    d = docs("builtins", "len")
    assert d["qualname"] == "builtins.len" and d["source"] == "plain"
    assert d["summary"] == "Return the number of items in a container."
    assert d["url"].endswith("/library/functions.html#len")
    m = docs("builtins", "list.append")
    assert m["kind"] == "method" and m["url"].endswith("stdtypes.html#list.append")


STUDENT = '''
def area(w, h=2) -> float:
    """Area of a rectangle.

    Parameters
    ----------
    w : float
        Width.
    """
    return w * h

class Box:
    """A box."""
    def __init__(self, size):
        pass
    def grow(self, by):
        """Make it bigger."""

class Plain:
    def __init__(self, x):
        """Takes x."""

def nodoc(): pass
'''


def test_student_function_class_method_and_none() -> None:
    d = docs("__main__", "area", STUDENT)
    assert d["kind"] == "function" and d["url"] is None and d["source"] == "numpydoc"
    assert d["signature"] == "area(w, h=2) -> float"
    assert entry_names(d, "Parameters") == ["w"]
    b = docs("__main__", "Box", STUDENT)
    assert b["kind"] == "class" and b["summary"] == "A box." and b["signature"] == "Box(size)"
    g = docs("__main__", "Box.grow", STUDENT)
    assert g["kind"] == "method" and g["signature"] == "grow(by)" and g["source"] == "plain"
    assert docs("__main__", "Plain", STUDENT)["summary"] == "Takes x."
    n = docs("__main__", "nodoc", STUDENT)
    assert n["source"] == "none" and n["summary"] == "" and n["signature"] == "nodoc()"


def test_student_code_is_never_executed() -> None:
    src = "import os\nos.environ['DOCS_RAN'] = '1'\ndef f():\n    '''Doc.'''\n"
    docs("__main__", "f", src)
    import os

    assert "DOCS_RAN" not in os.environ


def test_unresolvable_is_a_none_doc_and_json_safe() -> None:
    for module, name, source in [
        ("nosuchmodule.sub", "thing", None),
        ("sklearn.linear_model", "Missing.fit", None),
        ("__main__", "ghost", STUDENT),
        ("__main__", "f", "def broken(:"),
        (None, "sklearn.linear_model.LinearRegression.fit", None),
    ]:
        d = docs(module, name, source)
        json.dumps(d)
        if name in ("ghost", "Missing.fit", "thing") or source == "def broken(:":
            assert d["source"] == "none"
    full = docs(None, "sklearn.linear_model.LinearRegression.fit")
    assert full["qualname"] == "sklearn.linear_model.LinearRegression.fit"
    assert full["source"] == "numpydoc"


def test_every_result_is_json_serialisable() -> None:
    for module, name in [
        ("sklearn.linear_model._base", "LinearRegression"),
        ("pandas.io.parsers.readers", "read_csv"),
        ("numpy", "mean"),
        ("builtins", "len"),
    ]:
        json.dumps(docs(module, name))
