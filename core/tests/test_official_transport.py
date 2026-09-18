"""Transport sensitivity and explicit counterfactuals over untouched official CSVs."""

from pathlib import Path

import pytest
from core.contracts import RouterTaskSnapshot
from core.engine import SearchSettings, apply_system_policy, solve
from core.evidence import build_plan_evidence
from core.geo import GraphTravel, configure_travel
from core.official import load_official_region
from core.schedule import baseline, validate_plan

DATASET = Path(__file__).resolve().parents[2] / "data/dataset/anonymized"
SETTINGS = SearchSettings(time_limit_ms=3000, solution_limit=8, traffic_enabled=False)


@pytest.mark.parametrize("region", ["east", "southeast", "south_central"])
def test_official_assignments_change_with_transport_only(region):
    """Hold skills, requests and shifts fixed; changing travel mode changes coverage."""
    scenario = load_official_region(DATASET, region)
    original = scenario.snapshot.model_dump_json()
    assert all(request.required_transport is None for request in scenario.snapshot.requests)
    travel = configure_travel(GraphTravel(scenario.graph), SETTINGS.technical())
    plans = {}
    main_plans = {}
    for profile in ("car", "walk"):
        snapshot = apply_system_policy(
            scenario.snapshot.model_copy(
                update={
                    "engineers": [
                        engineer.model_copy(update={"transport_type": profile})
                        for engineer in scenario.snapshot.engineers
                    ],
                }
            ),
            SETTINGS,
        )
        plan = baseline(snapshot, travel)
        validate_plan(snapshot, plan, travel)
        assert plan == baseline(snapshot, travel)
        for assignment in plan.assignments:
            if assignment.status == "assigned":
                facts = assignment.reasons[0].facts
                assert facts["transport_type"] == profile
                assert facts["required_transport"] is None
                assert facts["travel_time_sec"] is not None
        plans[profile] = plan
        output = solve(snapshot, travel, SETTINGS)
        validate_plan(output.memory.snapshot, output.main, travel)
        main_plans[profile] = output.main
    assert plans["car"].summary.assigned_count > plans["walk"].summary.assigned_count
    assert [(a.request_id, a.engineer_id) for a in plans["car"].assignments] != [
        (a.request_id, a.engineer_id) for a in plans["walk"].assignments
    ]
    assert scenario.snapshot.model_dump_json() == original
    assert [(a.request_id, a.engineer_id) for a in main_plans["car"].assignments] != [
        (a.request_id, a.engineer_id) for a in main_plans["walk"].assignments
    ]


@pytest.mark.parametrize("travel_mode", ["graph_with_access_buffer", "fixed_normative"])
def test_official_request_transport_requirement_is_enforced(official_east_scenario, travel_mode):
    """Add a labelled car-only counterfactual to one real row; never alter the CSV."""
    scenario = official_east_scenario
    settings = SearchSettings(
        time_limit_ms=3000, solution_limit=8, traffic_enabled=False, travel_time_mode=travel_mode
    )
    travel = configure_travel(GraphTravel(scenario.graph), settings.technical())
    original = apply_system_policy(scenario.snapshot, settings)
    initial = baseline(original, travel)
    owner = next(
        a
        for a in initial.assignments
        if a.status == "assigned"
        and next(e for e in original.engineers if e.engineer_id == a.engineer_id).transport_type
        == "car"
    )
    request = next(r for r in original.requests if r.request_id == owner.request_id)
    engineer = next(e for e in original.engineers if e.engineer_id == owner.engineer_id)
    payload = original.model_dump()
    payload["requests"] = [request.model_copy(update={"required_transport": "car"}).model_dump()]
    payload["engineers"] = [engineer.model_dump()]
    allowed = RouterTaskSnapshot.model_validate(payload)
    payload["engineers"][0]["transport_type"] = "walk"
    denied = RouterTaskSnapshot.model_validate(payload)

    for snapshot, expected in ((allowed, "assigned"), (denied, "unassigned")):
        output = solve(snapshot, travel, settings)
        for plan in (output.main, output.baseline):
            validate_plan(output.memory.snapshot, plan, travel)
            assignment = plan.assignments[0]
            assert assignment.status == expected
            assert assignment.reasons[0].facts["required_transport"] == "car"
            assert assignment.reasons[0].code == (
                "CONSTRAINTS_SATISFIED" if expected == "assigned" else "NO_TRANSPORT_MATCH"
            )
        evidence = build_plan_evidence(output.memory.snapshot, output.main, travel)
        candidate = evidence.requests[0].candidates[0]
        assert candidate.transport_match == (expected == "assigned")
        if expected == "unassigned":
            assert "transport_mismatch" in candidate.blockers
        assert solve(snapshot, travel, settings).main == output.main


def test_fixed_normative_intentionally_equalizes_travel(official_east_scenario):
    """The documented normative mode uses the same ETA for every transport profile."""
    scenario = official_east_scenario
    settings = SearchSettings(travel_time_mode="fixed_normative", traffic_enabled=False)
    travel = configure_travel(GraphTravel(scenario.graph), settings.technical())
    a, b = (node.location for node in scenario.graph.nodes[:2])
    assert {
        travel.quote(a, b, profile).duration_sec for profile in ("car", "walk", "bike", "transit")
    } == {1200}
