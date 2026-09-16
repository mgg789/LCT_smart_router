"""Freshness checks for checked Router boundary schemas."""

from pathlib import Path

from core.schema import write_schemas

ROOT = Path(__file__).resolve().parents[2]


def test_checked_schemas_match_contract_models(tmp_path):
    """Regeneration must reproduce every committed integration schema byte-for-byte."""
    write_schemas(tmp_path)
    committed = ROOT / "core/schemas"
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(
        path.name for path in committed.iterdir()
    )
    for generated in tmp_path.iterdir():
        assert generated.read_bytes() == (committed / generated.name).read_bytes()
