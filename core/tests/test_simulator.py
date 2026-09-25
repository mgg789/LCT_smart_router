"""What-if answers stay off the published plan."""

import pytest
from core.engine import SearchSettings
from core.runtime import construction_travel
from core.schedule import baseline
from core.simulator import SimulationPatch, patch_hash, simulate_patch


def test_window_shift_keeps_the_snapshot_and_uses_insertion(snapshot):
    raw = snapshot.model_dump_json().encode()
    before = snapshot.model_dump()
    settings = SearchSettings(time_limit_ms=800)
    travel = construction_travel(settings, snapshot.planning_as_of)
    base = baseline(snapshot, travel)
    job = snapshot.requests[0]
    patch = SimulationPatch.model_validate(
        {
            "window": {
                "request_id": job.request_id,
                "window_start_at": job.window_start_at + 60,
                "window_end_at": job.window_end_at + 60,
            }
        }
    )
    result = simulate_patch(raw, settings, "ctx-1", patch, base, publication_id="pub-1")
    assert result["method"] == "insertion"
    assert result["patch_hash"] == patch_hash(patch)
    assert "delta" in result
    assert snapshot.model_dump() == before


def test_mixed_patch_is_rejected():
    with pytest.raises(ValueError, match="PATCH_MIXED"):
        SimulationPatch.model_validate(
            {
                "policy_id": "fast",
                "window": {"request_id": "job-1", "window_start_at": 10, "window_end_at": 20},
            }
        )


def test_patch_hash_ignores_missing_fields():
    left = SimulationPatch.model_validate({"policy_id": "sla"})
    right = SimulationPatch.model_validate({"policy_id": "sla"})
    assert patch_hash(left) == patch_hash(right)
    assert patch_hash(left) != patch_hash(SimulationPatch.model_validate({"policy_id": "eco"}))
