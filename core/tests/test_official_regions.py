"""Second-region and simultaneous multi-zone Router acceptance tests."""

import hashlib
import json
from pathlib import Path

import pytest
from core.contracts import Policy
from core.engine import SearchSettings, solve
from core.geo import GraphTravel
from core.official import (
    OfficialScenarioConfig,
    combine_official_scenarios,
    load_official_region,
)
from core.schedule import validate_plan

ROOT = Path(__file__).resolve().parents[2]
DATASET = ROOT / "data/dataset/anonymized"
GOLDEN = json.loads(
    (ROOT / "core/tests/golden/official-south-central-v1.json").read_text(encoding="utf-8")
)


def _plan_hash(plan) -> str:
    return hashlib.sha256(plan.model_dump_json().encode("utf-8")).hexdigest()


def test_official_config_requires_all_source_and_resource_hashes():
    """No official acceptance scenario may silently opt out of provenance checks."""
    config = json.loads(
        (ROOT / "core/scenarios/south-central-v1/config.json").read_text(encoding="utf-8")
    )
    del config["resource_sha256"]["road_matrix"]
    with pytest.raises(ValueError, match="resource hashes must cover"):
        OfficialScenarioConfig.model_validate(config)


def test_south_central_official_golden():
    """Run the second official region through the same strict importer and Engine."""
    scenario = load_official_region(DATASET, "south_central")
    output = solve(
        scenario.snapshot,
        GraphTravel(scenario.graph),
        SearchSettings(**GOLDEN["settings"]),
    )
    validate_plan(scenario.snapshot, output.main, GraphTravel(scenario.graph))
    assert len(scenario.snapshot.requests) == GOLDEN["source"]["requests"]
    assert len(scenario.snapshot.engineers) == GOLDEN["source"]["engineers"]
    assert sum(request.priority == "urgent" for request in scenario.snapshot.requests) == 16
    assert scenario.geocode_quality == {"district_centroid_projection": 56}
    assert _plan_hash(output.baseline) == GOLDEN["baseline"]["plan_sha256"]
    assert _plan_hash(output.main) == GOLDEN["main"]["plan_sha256"]
    assert output.main.summary.assigned_count == GOLDEN["main"]["assigned_count"]
    assert output.main.summary.urgent_assigned_count == GOLDEN["main"]["urgent_assigned_count"]
    assert output.main.summary.travel_time_sec == GOLDEN["main"]["travel_time_sec"]
    assert [
        assignment.request_id
        for assignment in output.main.assignments
        if assignment.status == "unassigned"
    ] == GOLDEN["main"]["unassigned_request_ids"]


def test_east_and_south_central_run_as_one_isolated_multizone_problem():
    """Solve two official pools at once and prove no cross-zone assignment exists."""
    east = load_official_region(DATASET, "east")
    south = load_official_region(DATASET, "south_central")
    scenario = combine_official_scenarios([east, south])
    assert len(scenario.snapshot.requests) == 122
    assert len(scenario.snapshot.engineers) == 23
    assert len(scenario.graph.nodes) == 122
    assert len(scenario.graph.edges) == 7370

    travel = GraphTravel(scenario.graph)
    assert (
        travel.quote(
            east.snapshot.engineers[0].start_location,
            south.snapshot.requests[0].location,
            "car",
        )
        is None
    )
    output = solve(
        scenario.snapshot,
        travel,
        SearchSettings(time_limit_ms=8000, solution_limit=16),
    )
    validate_plan(scenario.snapshot, output.main, travel)
    assert output.main.summary.requests_total == 122
    assert output.main.summary.assigned_count > output.baseline.summary.assigned_count
    assert all(
        assignment.status == "unassigned"
        or assignment.request_id.split(":", 1)[0] == assignment.engineer_id.split(":", 1)[0]
        for assignment in output.main.assignments
    )


def test_every_v2_policy_builds_a_valid_second_region_plan():
    """Exercise every preset on organizer rows, not only synthetic unit fixtures."""
    scenario = load_official_region(DATASET, "south_central")
    travel = GraphTravel(scenario.graph)
    for policy_id in ("fast", "compact", "sla", "balanced", "eco"):
        snapshot = scenario.snapshot.model_copy(
            update={"policy": Policy(policy_id=policy_id, parameters={})}
        )
        output = solve(
            snapshot,
            travel,
            SearchSettings(time_limit_ms=1200, solution_limit=6),
        )
        validate_plan(snapshot, output.main, travel)
        assert output.main.is_usable
        assert output.main.summary.assigned_count > output.baseline.summary.assigned_count
