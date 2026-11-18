import machines


def test_package_imports() -> None:
    assert "record" in machines.__all__
