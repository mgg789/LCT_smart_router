"""Freshness and executable checks for checked Router boundary schemas."""

import json
from pathlib import Path

import pytest
from core.contracts import EquipmentStock
from core.schema import write_schemas
from jsonschema import Draft202012Validator, ValidationError

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


def test_checked_snapshot_schema_accepts_equipment_contract(snapshot):
    """The static integration artifact accepts required equipment and carried stock."""
    request = snapshot.requests[0].model_copy(update={"required_equipment": "set_top_box"})
    engineer = snapshot.engineers[0].model_copy(
        update={"equipment_stock": EquipmentStock(router=2, set_top_box=3, smart_speaker=1)}
    )
    payload = snapshot.model_copy(update={"requests": [request], "engineers": [engineer]})
    schema = json.loads(
        (ROOT / "core/schemas/router-task-snapshot-1.0.json").read_text(encoding="utf-8")
    )

    Draft202012Validator(schema).validate(payload.model_dump(mode="json"))


def test_checked_snapshot_schema_requires_explicit_equipment_stock(snapshot):
    """Every publication states stock explicitly so missing data never means zero silently."""
    payload = snapshot.model_dump(mode="json")
    del payload["engineers"][0]["equipment_stock"]
    schema = json.loads(
        (ROOT / "core/schemas/router-task-snapshot-1.0.json").read_text(encoding="utf-8")
    )

    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(payload)
