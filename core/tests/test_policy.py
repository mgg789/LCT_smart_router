"""Policy catalog compilation and observable planning trade-off tests."""

import pytest
from core.contracts import RouterTaskSnapshot
from core.engine import SearchSettings, solve
from core.geo import GraphTravel, RoadGraph
from core.policy import POLICY_CATALOG_VERSION, compile_policy

SETTINGS = SearchSettings(
    time_limit_ms=1600,
    solution_limit=24,
    lunches_enabled=True,
    access_buffer_sec=0,
)


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

    expected = {
        "fast": "travel_time",
        "compact": "engineers_used",
        "sla": "window_start_delay",
        "balanced": "max_jobs_per_engineer",
        "eco": "distance",
    }
    for policy_id, first_resource in expected.items():
        data = snapshot.model_dump()
        data["policy"] = {"policy_id": policy_id, "parameters": {}}
        spec = compile_policy(RouterTaskSnapshot.model_validate(data).policy)
        assert spec.search_stages[1] == first_resource


def test_fast_minimizes_travel_while_compact_minimizes_engineers(snapshot, graph):
    """Show the catalog's intended resource trade-off on the same feasible jobs."""
    travel = GraphTravel(graph)
    fast = solve(_policy_scenario(snapshot, graph, "fast"), travel, SETTINGS).main
    compact = solve(_policy_scenario(snapshot, graph, "compact"), travel, SETTINGS).main

    assert fast.summary.assigned_count == compact.summary.assigned_count == 2
    assert fast.summary.engineers_used == 2
    assert fast.summary.travel_time_sec == 0
    assert compact.summary.engineers_used == 1
    assert compact.summary.travel_time_sec == 81
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


def test_balanced_and_sla_spread_work_while_compact_concentrates(snapshot, graph):
    travel = GraphTravel(graph)
    compact = solve(_policy_scenario(snapshot, graph, "compact"), travel, SETTINGS).main
    balanced = solve(_policy_scenario(snapshot, graph, "balanced"), travel, SETTINGS).main
    sla = solve(_policy_scenario(snapshot, graph, "sla"), travel, SETTINGS).main
    assert max(route.metrics.assigned_count for route in compact.routes) == 2
    assert max(route.metrics.assigned_count for route in balanced.routes) == 1
    assert max(route.metrics.assigned_count for route in sla.routes) == 1


def test_eco_prefers_shorter_distance_while_fast_prefers_time(snapshot):
    """Prove the eco preset on a graph with intentionally opposed cost signals."""
    start = snapshot.planning_as_of
    graph = RoadGraph.model_validate(
        {
            "version": "policy-cost-tradeoff",
            "source": "test",
            "nodes": [
                {"node_id": "fast", "location": {"lat": 55.75, "lon": 37.60}},
                {"node_id": "eco", "location": {"lat": 55.75, "lon": 37.61}},
                {"node_id": "job", "location": {"lat": 55.75, "lon": 37.62}},
            ],
            "edges": [
                {
                    "source": "fast",
                    "target": "job",
                    "distance_m": 1000,
                    "duration_sec": {"car": 60},
                },
                {
                    "source": "eco",
                    "target": "job",
                    "distance_m": 100,
                    "duration_sec": {"car": 180},
                },
            ],
        }
    )
    base = snapshot.model_dump()
    engineer = base["engineers"][0]
    engineer.update(skills=["local"], transport_type="car")
    second = {
        **engineer,
        "engineer_id": "eco-eng",
        "input_order": 1,
        "start_location": graph.nodes[1].location.model_dump(),
    }
    engineer.update(
        engineer_id="fast-eng",
        input_order=0,
        start_location=graph.nodes[0].location.model_dump(),
    )
    base["engineers"] = [engineer, second]
    base["requests"] = [
        {
            "request_id": "job",
            "arrival_order": 0,
            "location": graph.nodes[2].location.model_dump(),
            "service_duration_sec": 300,
            "window_start_at": start,
            "window_end_at": start + 3600,
            "priority": "normal",
            "required_skill": "local",
            "required_transport": None,
        }
    ]
    travel = GraphTravel(graph)
    owners = {}
    for policy_id in ("fast", "eco"):
        base["policy"] = {"policy_id": policy_id, "parameters": {}}
        plan = solve(RouterTaskSnapshot.model_validate(base), travel, SETTINGS).main
        owners[policy_id] = plan.assignments[0].engineer_id
    assert owners == {"fast": "fast-eng", "eco": "eco-eng"}
