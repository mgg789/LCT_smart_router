"""Official East import, benchmark golden and explanation evidence acceptance."""

import hashlib
import json
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = json.loads((ROOT / "core/tests/golden/official-east-v1.json").read_text(encoding="utf-8"))


def _plan_hash(plan) -> str:
    return hashlib.sha256(plan.model_dump_json().encode("utf-8")).hexdigest()


def test_official_east_import_is_complete(official_east_scenario):
    scenario = official_east_scenario
    assert len(scenario.snapshot.requests) == GOLDEN["source"]["requests"]
    assert len(scenario.snapshot.engineers) == GOLDEN["source"]["engineers"]
    assert sum(request.priority == "urgent" for request in scenario.snapshot.requests) == 13
    assert {engineer.transport_type for engineer in scenario.snapshot.engineers} == {
        "car",
        "bike",
        "walk",
        "transit",
    }
    assert sum(scenario.geocode_quality.values()) == 66
    assert all(
        set(edge.duration_sec) == {"car", "bike", "walk", "transit"}
        for edge in scenario.graph.edges
    )


def test_official_east_import_rejects_control_drift(tmp_path, official_east_scenario):
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    for name in (
        official_east_scenario.config.synthetic_file,
        official_east_scenario.config.control_file,
    ):
        shutil.copy2(ROOT / "data/dataset/anonymized" / name, dataset / name)
    control = dataset / official_east_scenario.config.control_file
    contents = control.read_text(encoding="cp1251")
    control.write_text(
        contents.replace("Конвергенция абонента", "Drifted type", 1), encoding="cp1251"
    )
    from core.official import load_official_east

    with pytest.raises(ValueError, match="control rows do not match"):
        load_official_east(dataset)


def test_official_east_golden(official_east_run):
    baseline = official_east_run.output.baseline
    main = official_east_run.output.main
    assert _plan_hash(baseline) == GOLDEN["baseline"]["plan_sha256"]
    assert _plan_hash(main) == GOLDEN["main"]["plan_sha256"]
    assert baseline.summary.assigned_count == GOLDEN["baseline"]["assigned_count"]
    assert baseline.summary.urgent_assigned_count == GOLDEN["baseline"]["urgent_assigned_count"]
    assert baseline.summary.travel_time_sec == GOLDEN["baseline"]["travel_time_sec"]
    assert main.summary.assigned_count == GOLDEN["main"]["assigned_count"]
    assert main.summary.urgent_assigned_count == GOLDEN["main"]["urgent_assigned_count"]
    assert main.summary.travel_time_sec == GOLDEN["main"]["travel_time_sec"]
    assert [
        assignment.request_id
        for assignment in main.assignments
        if assignment.status == "unassigned"
    ] == GOLDEN["main"]["unassigned_request_ids"]


def test_explanation_evidence_is_calculation_backed(official_east_run):
    evidence = official_east_run.evidence.requests
    assigned = next(item for item in evidence if item.status == "assigned" and item.travel_time_sec)
    selected = next(
        candidate
        for candidate in assigned.candidates
        if candidate.engineer_id == assigned.engineer_id
    )
    assert selected.skill_match and selected.transport_match and selected.available
    assert assigned.start_at is not None and assigned.window_end_margin_sec is not None
    assert assigned.window_start_offset_sec is not None
    assert assigned.distance_km is not None and assigned.distance_km > 0
    assert len(assigned.candidates) == 12
    assert assigned.reasons[0] == next(
        assignment.reasons[0]
        for assignment in official_east_run.output.main.assignments
        if assignment.request_id == assigned.request_id
    )
    assert assigned.reasons[0].basis == "constraint_check"
    appendable = next(
        candidate for candidate in assigned.candidates if candidate.append_at_route_end_feasible
    )
    assert appendable.append_start_at is not None
    assert appendable.append_incremental_travel_time_sec is not None
    assert appendable.append_incremental_distance_km is not None

    unassigned = next(item for item in evidence if item.request_id == "57299")
    assert unassigned.reason_codes == ["NO_FEASIBLE_ASSIGNMENT_FOUND"]
    assert unassigned.reasons[0].basis == "calculation_outcome"
    assert any(candidate.solo_feasible for candidate in unassigned.candidates)
    assert all(candidate.blockers for candidate in unassigned.candidates)
