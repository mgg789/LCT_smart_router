"""Regression scenarios for hard constraints, hierarchy, lunches and replanning."""

import pytest
from core.contracts import RouterTaskSnapshot
from core.engine import SearchSettings, solve
from core.evidence import build_plan_evidence
from core.geo import GraphTravel, configure_travel
from core.schedule import baseline, score, validate_plan

SETTINGS = SearchSettings(
    time_limit_ms=1200,
    solution_limit=12,
    lunches_enabled=True,
    access_buffer_sec=0,
)


def changed(snapshot, edit):
    data = snapshot.model_dump()
    edit(data)
    return RouterTaskSnapshot.model_validate(data)


def test_baseline_order_and_main_improvement(snapshot, graph):
    travel = GraphTravel(graph)
    result = solve(snapshot, travel, SETTINGS)
    assert [s.request_id for s in result.baseline.routes[0].stops] == ["job-3", "job-2", "job-1"]
    assert result.main.summary.assigned_count == 3
    assert result.main.summary.travel_time_sec == 243
    assert score(snapshot, result.main) < score(snapshot, result.baseline)
    configured = configure_travel(travel, SETTINGS.technical(), snapshot.planning_as_of)
    validate_plan(snapshot, result.main, configured)


def test_travel_mode_applies_to_baseline_and_main(snapshot, graph):
    """Both plans use the selected timing policy while keeping graph distance."""
    graph_result = solve(
        snapshot,
        GraphTravel(graph),
        SearchSettings(time_limit_ms=1200, solution_limit=12),
    )
    fixed_result = solve(
        snapshot,
        GraphTravel(graph),
        SearchSettings(
            time_limit_ms=1200,
            solution_limit=12,
            travel_time_mode="fixed_normative",
        ),
    )

    assert graph_result.main.summary.travel_time_sec == 2043
    assert fixed_result.main.summary.travel_time_sec == 3600
    assert graph_result.main.summary.distance_km == fixed_result.main.summary.distance_km == 1.8
    assert all(
        leg.travel_time_sec == 1200
        for route in fixed_result.baseline.routes
        for leg in route.legs
        if leg.distance_km > 0
    )


def test_final_service_must_finish_in_shift(snapshot, graph):
    task = changed(
        snapshot, lambda d: d["engineers"][0].update(shift_end_at=d["planning_as_of"] + 650)
    )
    result = solve(task, GraphTravel(graph), SETTINGS)
    assert result.main.summary.assigned_count == 0
    assert result.main.is_usable


@pytest.mark.parametrize(
    "field,value,code",
    [
        ("skills", ["emergency"], "NO_SKILL_MATCH"),
        ("available_from", None, "NO_AVAILABLE_ENGINEER"),
        ("availability", "offline", "NO_AVAILABLE_ENGINEER"),
    ],
)
def test_unavailable_engineer(snapshot, graph, field, value, code):
    task = changed(snapshot, lambda d: d["engineers"][0].update({field: value}))
    result = solve(task, GraphTravel(graph), SETTINGS)
    assert result.main.summary.assigned_count == 0
    assert result.main.assignments[0].reasons[0].code == code


def test_transport_domain_does_not_allow_wrong_engineer(snapshot, graph):
    task = changed(snapshot, lambda d: d["requests"][0].update(required_transport="walk"))
    result = solve(task, GraphTravel(graph), SETTINGS)
    assignment = next(a for a in result.main.assignments if a.request_id == "job-1")
    assert assignment.status == "unassigned"
    assert assignment.reasons[0].code == "NO_TRANSPORT_MATCH"


def lunch_task(snapshot, *, required=False, taken=False, impossible=False):
    def edit(d):
        start = d["planning_as_of"]
        d["engineers"][0].update(
            lunch_taken=taken,
            lunch={
                "enabled": True,
                "required": required,
                "duration_sec": 900,
                "window_start_at": start + 1000,
                "window_end_at": start + (1100 if impossible else 2300),
            },
        )

    return changed(snapshot, edit)


def test_lunch_inside_model_and_no_second_lunch(snapshot, graph):
    travel = GraphTravel(graph)
    task = lunch_task(snapshot, required=True)
    result = solve(task, travel, SETTINGS)
    assert result.main.is_usable
    assert result.main.routes[0].lunch.status == "scheduled"
    assert result.main.summary.assigned_count == 3
    assert result.main.summary.lunch_time_sec == 900
    configured = configure_travel(travel, SETTINGS.technical(), task.planning_as_of)
    validate_plan(task, result.main, configured)
    taken = solve(lunch_task(snapshot, taken=True), travel, SETTINGS)
    assert taken.main.summary.lunch_time_sec == 0
    assert taken.main.routes[0].lunch.status == "already_taken"


def test_system_policy_disables_even_required_lunch(snapshot, graph):
    """The Router hard switch overrides per-engineer lunch input for both plans."""
    task = lunch_task(snapshot, required=True)
    output = solve(
        task,
        GraphTravel(graph),
        SearchSettings(time_limit_ms=600, solution_limit=8, lunches_enabled=False),
    )
    assert output.main.is_usable and output.baseline.is_usable
    assert output.main.routes[0].lunch.status == "disabled"
    assert output.baseline.routes[0].lunch.status == "disabled"
    assert all(stop.kind != "lunch" for stop in output.main.routes[0].stops)


def test_optional_lunch_search_preserves_lunch_off_job_coverage(snapshot, graph):
    """Optional lunch nodes may enrich a route but cannot consume bounded-search coverage."""
    task = lunch_task(snapshot, required=False)
    common = {
        "time_limit_ms": 120,
        "solution_limit": 4,
        "access_buffer_sec": 0,
    }
    without_lunch = solve(
        task,
        GraphTravel(graph),
        SearchSettings(lunches_enabled=False, **common),
    )
    with_lunch = solve(
        task,
        GraphTravel(graph),
        SearchSettings(lunches_enabled=True, **common),
    )

    assert with_lunch.main.summary.assigned_count == without_lunch.main.summary.assigned_count
    assert with_lunch.main.summary.urgent_assigned_count == (
        without_lunch.main.summary.urgent_assigned_count
    )
    assert with_lunch.main.routes[0].lunch.status in {"scheduled", "skipped_for_work"}


def test_region_isolation_is_static_and_missing_region_is_backward_compatible(snapshot, graph):
    """Explicitly different regions never match; omitted legacy regions remain compatible."""

    def isolate(data):
        data["engineers"][0]["region"] = "south"
        for request in data["requests"]:
            request["region"] = "east"

    isolated = changed(snapshot, isolate)
    blocked = solve(isolated, GraphTravel(graph), SETTINGS)
    assert blocked.main.summary.assigned_count == 0
    assert {reason.code for item in blocked.main.assignments for reason in item.reasons} == {
        "NO_REGION_MATCH"
    }

    compatible = solve(snapshot, GraphTravel(graph), SETTINGS)
    assert compatible.main.summary.assigned_count == len(snapshot.requests)


def test_required_lunch_failure_is_ready_unusable(snapshot, graph):
    task = lunch_task(snapshot, required=True, impossible=True)
    travel = GraphTravel(graph)
    result = solve(task, travel, SETTINGS)
    assert not result.main.is_usable
    assert result.main.routes == []
    assert result.main.alerts[0].code == "REQUIRED_LUNCH_UNPLACED"
    evidence = build_plan_evidence(task, result.main, travel)
    assert len(evidence.requests) == len(task.requests)


def test_empty_requests_and_lunch_only_engineer(snapshot, graph):
    task = changed(lunch_task(snapshot), lambda d: d.update(requests=[]))
    result = solve(task, GraphTravel(graph), SETTINGS)
    assert result.main.summary.engineers_used == 0
    assert result.main.summary.lunch_time_sec == 900
    empty = changed(snapshot, lambda d: d.update(requests=[], engineers=[]))
    assert solve(empty, GraphTravel(graph), SETTINGS).main.is_usable


def test_revalidation_uses_stable_reference_and_repairs(snapshot, graph):
    travel = GraphTravel(graph)
    settings = SearchSettings(time_limit_ms=1000, solution_limit=8, tolerance_sec=60)
    first = solve(snapshot, travel, settings)
    second_task = changed(snapshot, lambda d: d.update(planning_as_of=d["planning_as_of"] + 40))
    second = solve(second_task, travel, settings, first.memory)
    assert second.path == "REVALIDATE"
    third_task = changed(snapshot, lambda d: d.update(planning_as_of=d["planning_as_of"] + 80))
    third = solve(third_task, travel, settings, second.memory)
    assert third.path == "REPAIR_AND_IMPROVE"
    cancelled = changed(snapshot, lambda d: d["requests"].pop(0))
    result = solve(cancelled, travel, settings, first.memory)
    assert "job-1" not in [a.request_id for a in result.main.assignments]


def test_task_start_tolerance_is_independent_from_departure_tolerance(snapshot, graph):
    """A bounded departure drift still repairs when downstream start drift is too large."""
    travel = GraphTravel(graph)
    first = solve(snapshot, travel, SearchSettings(time_limit_ms=800, solution_limit=8))

    def delay(data):
        data["planning_as_of"] += 40
        data["engineers"][0]["available_from"] += 40

    delayed = changed(snapshot, delay)
    strict = SearchSettings(
        time_limit_ms=800,
        solution_limit=8,
        departure_lateness_tolerance_sec=60,
        task_start_lateness_tolerance_sec=30,
    )
    relaxed = SearchSettings(
        time_limit_ms=800,
        solution_limit=8,
        departure_lateness_tolerance_sec=60,
        task_start_lateness_tolerance_sec=60,
    )
    assert solve(delayed, travel, strict, first.memory).path == "REPAIR_AND_IMPROVE"
    assert solve(delayed, travel, relaxed, first.memory).path == "REVALIDATE"


def test_deterministic_golden(snapshot, graph):
    plans = [solve(snapshot, GraphTravel(graph), SETTINGS).main.model_dump() for _ in range(3)]
    assert plans[0] == plans[1] == plans[2]
    assert plans[0]["summary"] == {
        "distance_km": 1.8,
        "travel_time_sec": 243,
        "work_time_sec": 1800,
        "waiting_time_sec": 0,
        "lunch_time_sec": 0,
        "assigned_count": 3,
        "requests_total": 3,
        "unassigned_count": 0,
        "urgent_total": 0,
        "urgent_assigned_count": 0,
        "engineers_used": 1,
    }


def test_validator_detects_corruption(snapshot, graph):
    travel = GraphTravel(graph)
    plan = baseline(snapshot, travel)
    bad = plan.model_copy(
        update={"summary": plan.summary.model_copy(update={"travel_time_sec": 0})}
    )
    with pytest.raises(ValueError, match="totals"):
        validate_plan(snapshot, bad, travel)


def test_urgent_dominates_ordinary_coverage(snapshot, graph):
    def edit(d):
        start = d["planning_as_of"]
        d["engineers"][0]["shift_end_at"] = start + 1800
        d["requests"][0].update(priority="urgent", service_duration_sec=1500)

    task = changed(snapshot, edit)
    result = solve(task, GraphTravel(graph), SETTINGS)
    assert result.main.summary.urgent_assigned_count == 1
    assert result.main.summary.assigned_count == 1
    assert result.baseline.summary.urgent_assigned_count == 0
    assert result.baseline.summary.assigned_count == 2


def test_revalidate_cannot_silently_drop_previous_assignment(snapshot, graph):
    task = changed(
        snapshot, lambda d: d["engineers"][0].update(shift_end_at=d["planning_as_of"] + 720)
    )
    travel = GraphTravel(graph)
    settings = SearchSettings(
        time_limit_ms=500,
        solution_limit=6,
        tolerance_sec=1000,
        access_buffer_sec=0,
    )
    first = solve(task, travel, settings)
    assert first.main.summary.assigned_count == 1
    late = changed(
        task, lambda d: d["engineers"][0].update(available_from=d["planning_as_of"] + 661)
    )
    result = solve(late, travel, settings, first.memory)
    assert result.path != "REVALIDATE"


def test_unusable_assignments_still_validated(snapshot, graph):
    task = lunch_task(snapshot, required=True, impossible=True)
    travel = GraphTravel(graph)
    plan = baseline(task, travel)
    assignments = list(plan.assignments)
    assignments[0] = assignments[0].model_copy(update={"engineer_id": "invented"})
    with pytest.raises(ValueError, match="unusable assignment link"):
        validate_plan(task, plan.model_copy(update={"assignments": assignments}), travel)


def test_forged_lunch_status_rejected(snapshot, graph):
    task = lunch_task(snapshot, impossible=True)
    travel = GraphTravel(graph)
    plan = baseline(task, travel)
    route = plan.routes[0]
    forged = route.model_copy(
        update={"lunch": route.lunch.model_copy(update={"status": "required_conflict"})}
    )
    with pytest.raises(ValueError, match="lunch status"):
        validate_plan(task, plan.model_copy(update={"routes": [forged]}), travel)


def test_technical_array_reordering_keeps_revalidation(snapshot, graph):
    travel = GraphTravel(graph)
    first = solve(snapshot, travel, SETTINGS)
    reordered = changed(snapshot, lambda d: d["requests"].reverse())
    result = solve(reordered, travel, SETTINGS, first.memory)
    assert result.path == "REVALIDATE"
    assert result.main.routes == first.main.routes
