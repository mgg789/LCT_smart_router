"""Policy catalog compilation and observable planning trade-off tests."""

import pytest
from core.contracts import RouterTaskSnapshot
from core.engine import SearchSettings, solve
from core.geo import GraphTravel
from core.policy import POLICY_CATALOG_VERSION, compile_policy

SETTINGS = SearchSettings(time_limit_ms=1600, solution_limit=24)


def _policy_scenario(snapshot, graph, policy_id: str) -> RouterTaskSnapshot:
    data = snapshot.model_dump()
    start = data["planning_as_of"]
    first = data["engineers"][0]
    second = dict(first)
    first.update(
        engineer_id="eng-a",
        input_order=0,
        start_location=graph.nodes[1].location.model_dump(),
    )
    second.update(
        engineer_id="eng-b",
        input_order=1,
        start_location=graph.nodes[2].location.model_dump(),
    )
    data["engineers"] = [first, second]
    data["requests"] = data["requests"][:2]
    for index, request in enumerate(data["requests"], start=1):
        request.update(
            request_id=f"job-{index}",
            arrival_order=index,
            location=graph.nodes[index].location.model_dump(),
            service_duration_sec=300,
            window_start_at=start,
            window_end_at=start + 7200,
            priority="normal",
        )
    data["policy"] = {"policy_id": policy_id, "parameters": {}}
    return RouterTaskSnapshot.model_validate(data)


def test_catalog_is_strict_and_versioned(snapshot):
    """Accept known empty presets and reject unknown preferences at the boundary."""
    compact = snapshot.model_dump()
    compact["policy"] = {"policy_id": "compact", "parameters": {}}
    task = RouterTaskSnapshot.model_validate(compact)
    assert compile_policy(task.policy).ordered_criteria[-3:] == (
        "engineers_used",
        "distance",
        "travel_time",
    )
    assert len(POLICY_CATALOG_VERSION) == 64

    compact["policy"]["parameters"] = {"max_engineers": 1}
    with pytest.raises(ValueError, match="accepts only empty parameters"):
        RouterTaskSnapshot.model_validate(compact)
    compact["policy"] = {"policy_id": "unknown", "parameters": {}}
    with pytest.raises(ValueError):
        RouterTaskSnapshot.model_validate(compact)


def test_fast_minimizes_travel_while_compact_minimizes_engineers(snapshot, graph):
    """Show the catalog's intended resource trade-off on the same feasible jobs."""
    travel = GraphTravel(graph)
    fast = solve(_policy_scenario(snapshot, graph, "fast"), travel, SETTINGS).main
    compact = solve(_policy_scenario(snapshot, graph, "compact"), travel, SETTINGS).main

    assert fast.summary.assigned_count == compact.summary.assigned_count == 2
    assert fast.summary.engineers_used == 2
    assert fast.summary.travel_time_sec == 0
    assert compact.summary.engineers_used == 1
    assert compact.summary.travel_time_sec == 60
    assert compact.summary.distance_km == 0.6


def test_compact_does_not_count_required_lunch_only_route_as_engineer_used(snapshot, graph):
    """Charge compact activation only on the first real job, even after a start lunch."""
    task = _policy_scenario(snapshot, graph, "compact")
    data = task.model_dump()
    start = data["planning_as_of"]
    for engineer in data["engineers"]:
        engineer["lunch"] = {
            "enabled": True,
            "duration_sec": 300,
            "window_start_at": start,
            "window_end_at": start + 300,
            "required": True,
        }
    task = RouterTaskSnapshot.model_validate(data)
    plan = solve(task, GraphTravel(graph), SETTINGS).main

    assert plan.is_usable
    assert plan.summary.assigned_count == 2
    assert plan.summary.engineers_used == 1
    assert [route.lunch.status for route in plan.routes] == ["scheduled", "scheduled"]
    assert sum(route.metrics.assigned_count == 0 for route in plan.routes) == 1
