"""Independent regressions for departure traffic, tolerances and policy scoring."""

from dataclasses import replace

import pytest
from core.contracts import Policy, RouterTechnicalSettings
from core.engine import SearchSettings, solve
from core.geo import GraphTravel, TravelQuote, configure_travel
from core.policy import policy_score
from core.route_search import RouteEvaluator
from core.runtime import calculate_policy_comparison
from core.schedule import assemble_plan, baseline, fixed_order, validate_plan


class RushHourRoads:
    """Fixture where using the planning-time quote makes the second job infeasible."""

    version = "departure-sensitive-test"

    def __init__(self, graph, departure):
        self.graph = GraphTravel(graph)
        self.departure = departure

    def quote(self, origin, destination, profile):
        raise AssertionError("Dynamic search must request actual departure time")

    def quote_at(self, origin, destination, profile, departure_at):
        road = self.graph.quote(origin, destination, profile)
        if road is None:
            return None
        # Mark as authoritative to avoid stacking the local forecast on this test.
        return TravelQuote(
            road.duration_sec * (8 if departure_at >= self.departure + 600 else 1),
            road.distance_m,
            road.points,
            "traffic_api",
        )


def test_dynamic_search_never_uses_planning_time_quotes(snapshot, graph):
    travel = RushHourRoads(graph, snapshot.planning_as_of)
    settings = SearchSettings(access_buffer_sec=0)
    output = solve(snapshot, travel, settings)
    configured = configure_travel(travel, settings.technical(), snapshot.planning_as_of)
    validate_plan(output.memory.snapshot, output.main, configured)
    assert output.main.summary.assigned_count == 3
    assert len({leg.travel_time_sec for route in output.main.routes for leg in route.legs}) > 1


@pytest.mark.parametrize("minutes,assigned", [(0, 0), (5, 0), (10, 1), (15, 1), (20, 1)])
def test_window_lateness_is_explicit_and_does_not_extend_shifts(snapshot, graph, minutes, assigned):
    start = snapshot.planning_as_of
    request = snapshot.requests[0].model_copy(
        update={
            "location": snapshot.engineers[0].start_location,
            "window_start_at": start - 1200,
            "window_end_at": start - 600,
        }
    )
    task = snapshot.model_copy(update={"requests": [request]})
    settings = SearchSettings(access_buffer_sec=0, window_lateness_tolerance_sec=minutes * 60)
    result = solve(task, GraphTravel(graph), settings)
    for plan in (result.main, result.baseline):
        assert plan.summary.assigned_count == assigned
        assert plan.summary.late_assigned_count == assigned
        assert plan.summary.total_lateness_sec == assigned * 600
        assert plan.summary.min_window_slack_sec == (-600 if assigned else None)
    assert task.requests[0].window_end_at == start - 600
    short = task.engineers[0].model_copy(update={"shift_end_at": start + 1})
    result = solve(task.model_copy(update={"engineers": [short]}), GraphTravel(graph), settings)
    assert result.main.summary.assigned_count == 0


@pytest.mark.parametrize("policy", ["fast", "compact", "sla", "balanced", "eco"])
def test_search_score_matches_independent_public_metrics(snapshot, graph, policy):
    task = snapshot.model_copy(update={"policy": Policy(policy_id=policy, parameters={})})
    travel = configure_travel(GraphTravel(graph), RouterTechnicalSettings(), task.planning_as_of)
    evaluator = RouteEvaluator(task, travel)
    routes = [fixed_order(task, task.engineers[0], [r.request_id for r in task.requests], travel)]
    plan = assemble_plan(task, routes)
    internal = evaluator.score([evaluator.from_route(routes[0])], policy)
    public = policy_score(task, plan)
    assert internal[2:] == public[2:]
    assert internal[0] + plan.summary.urgent_total == public[0]
    assert internal[1] + plan.summary.requests_total == public[1]
    state = evaluator.evaluate(0, tuple(r.request_id for r in task.requests))
    assert state == evaluator.from_route(routes[0])


def test_comparison_preserves_fifo_and_no_policy_misses_a_better_shared_candidate(snapshot, graph):
    settings = SearchSettings(access_buffer_sec=0)
    comparison = calculate_policy_comparison(
        snapshot.model_dump_json().encode(), "test", graph, settings, "ctx", 100
    )
    travel = configure_travel(GraphTravel(graph), settings.technical(), snapshot.planning_as_of)
    assert comparison.rows[-1].summary == baseline(snapshot, travel).summary
    assert all(
        row.summary.assigned_count >= comparison.rows[-1].summary.assigned_count
        for row in comparison.rows
    )
    # Same original engineers, even after a covering plan was persisted upstream.
    extra = snapshot.engineers[0].model_copy(
        update={"engineer_id": "covering-east-1", "input_order": 99}
    )
    inflated = snapshot.model_copy(update={"engineers": [*snapshot.engineers, extra]})
    isolated = calculate_policy_comparison(
        inflated.model_dump_json().encode(), "test", graph, settings, "ctx", 100
    )
    assert [r.summary for r in isolated.rows] == [r.summary for r in comparison.rows]


def test_policy_switch_is_cold_and_does_not_keep_previous_policy_memory(snapshot, graph):
    settings = SearchSettings(access_buffer_sec=0)
    first = solve(snapshot, GraphTravel(graph), settings)
    other = snapshot.model_copy(update={"policy": Policy(policy_id="eco", parameters={})})
    switched = solve(other, GraphTravel(graph), settings, memory=first.memory)
    assert switched.path == "COLD_START"
    assert switched.main == solve(other, GraphTravel(graph), settings).main


def test_equipment_toggle_applies_equally_and_keeps_input_immutable(snapshot, graph):
    request = snapshot.requests[0].model_copy(update={"required_equipment": "router"})
    task = snapshot.model_copy(update={"requests": [request]})
    settings = SearchSettings(access_buffer_sec=0)
    strict = solve(task, GraphTravel(graph), settings)
    relaxed = solve(task, GraphTravel(graph), replace(settings, equipment_enabled=False))
    assert strict.main.summary.assigned_count == strict.baseline.summary.assigned_count == 0
    assert relaxed.main.summary.assigned_count == relaxed.baseline.summary.assigned_count == 1
    assert task.requests[0].required_equipment == "router"


def test_balance_uses_minutes_when_job_counts_tie(snapshot, graph):
    second = snapshot.engineers[0].model_copy(update={"engineer_id": "eng-2", "input_order": 2})
    requests = [
        r.model_copy(
            update={
                "service_duration_sec": 3000 if i == 0 else 300,
                "location": snapshot.engineers[0].start_location,
            }
        )
        for i, r in enumerate(snapshot.requests)
    ]
    task = snapshot.model_copy(
        update={
            "requests": requests,
            "engineers": [snapshot.engineers[0], second],
            "policy": Policy(policy_id="balanced", parameters={}),
        }
    )
    travel = GraphTravel(graph)
    a, b, c = [r.request_id for r in requests]
    balanced = assemble_plan(
        task,
        [
            fixed_order(task, task.engineers[0], [a], travel),
            fixed_order(task, second, [b, c], travel),
        ],
    )
    overloaded = assemble_plan(
        task,
        [
            fixed_order(task, task.engineers[0], [a, b], travel),
            fixed_order(task, second, [c], travel),
        ],
    )
    assert max(r.metrics.assigned_count for r in balanced.routes) == 2
    assert max(r.metrics.assigned_count for r in overloaded.routes) == 2
    assert policy_score(task, balanced) < policy_score(task, overloaded)


def test_sla_protects_tight_window_when_total_start_delays_tie(snapshot, graph):
    start = snapshot.planning_as_of
    requests = [
        r.model_copy(
            update={
                "service_duration_sec": 300,
                "location": snapshot.engineers[0].start_location,
                "window_start_at": start,
                "window_end_at": start + (1000 if i == 0 else 10000),
            }
        )
        for i, r in enumerate(snapshot.requests[:2])
    ]
    task = snapshot.model_copy(
        update={"requests": requests, "policy": Policy(policy_id="sla", parameters={})}
    )
    travel = GraphTravel(graph)
    a, b = [r.request_id for r in requests]
    early = assemble_plan(task, [fixed_order(task, task.engineers[0], [a, b], travel)])
    risky = assemble_plan(task, [fixed_order(task, task.engineers[0], [b, a], travel)])
    assert early.summary.min_window_slack_sec == 1000
    assert risky.summary.min_window_slack_sec == 700
    assert policy_score(task, early) < policy_score(task, risky)
