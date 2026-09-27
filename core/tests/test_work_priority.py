"""Business priority is independent of skills, travel presets and binary urgency."""

import pytest
from core.engine import SearchSettings, solve
from core.geo import GraphTravel
from core.schedule import validate_plan

POLICIES = ["fast", "compact", "sla", "balanced", "eco", "covering"]
SETTINGS = SearchSettings(time_limit_ms=200, solution_limit=8, access_buffer_sec=0)


def task_with(snapshot, categories, *, capacity=8 * 3600):
    """Put known-at-start jobs at the depot so the test isolates business ordering."""
    now = snapshot.planning_as_of
    engineer = snapshot.engineers[0].model_copy(update={"shift_end_at": now + capacity})
    jobs = [
        snapshot.requests[0].model_copy(
            update={
                "request_id": f"{category}-{index}",
                "arrival_order": index,
                "work_category": category,
                "priority": "normal",
                "required_skill": "local",
                "location": engineer.start_location,
                "received_at": now,
                "window_start_at": now,
                "window_end_at": now + capacity,
                "service_duration_sec": 6000 if category == "emergency" else 1800,
            }
        )
        for index, category in enumerate(categories)
    ]
    return snapshot.model_copy(
        update={"engineers": [engineer], "requests": jobs, "horizon_end_at": now + capacity}
    )


@pytest.mark.parametrize("policy", POLICIES)
@pytest.mark.parametrize("traffic", [True, False])
def test_known_emergency_goes_first_under_every_policy(snapshot, graph, policy, traffic):
    task = task_with(snapshot, ["service", "connection", "emergency"])
    task = task.model_copy(update={"policy": task.policy.model_copy(update={"policy_id": policy})})
    result = solve(
        task,
        GraphTravel(graph),
        SearchSettings(
            time_limit_ms=200, solution_limit=8, access_buffer_sec=0, traffic_enabled=traffic
        ),
    )
    stops = [stop for route in result.main.routes for stop in route.stops if stop.kind == "job"]
    first = min(stops, key=lambda stop: stop.start_at)
    assert first.request_id == "emergency-2"
    assert first.start_at == task.planning_as_of
    assert first.end_at - first.start_at == 6000
    validate_plan(task, result.main, GraphTravel(graph))


def test_emergency_uses_first_free_suitable_crew_without_interrupting_work(snapshot, graph):
    task = task_with(snapshot, ["service", "emergency"])
    now = task.planning_as_of
    # Sys removes the started job and projects its actual end and location as release.
    busy = task.engineers[0].model_copy(update={"available_from": now + 7200})
    earlier = busy.model_copy(
        update={"engineer_id": "free-earlier", "input_order": 1, "available_from": now + 900}
    )
    task = task.model_copy(update={"engineers": [busy, earlier]})
    result = solve(task, GraphTravel(graph), SETTINGS)
    route = next(
        route
        for route in result.main.routes
        if any(s.request_id == "emergency-1" for s in route.stops)
    )
    stop = next(s for s in route.stops if s.request_id == "emergency-1")
    assert route.engineer_id == "free-earlier"
    assert stop.start_at == now + 900
    assert all(
        s.start_at >= now + 7200
        for r in result.main.routes
        if r.engineer_id == busy.engineer_id
        for s in r.stops
    )


def test_receipt_time_replans_future_route_and_two_hour_reference_never_drops_emergency(
    snapshot, graph
):
    task = task_with(snapshot, ["service", "emergency"])
    now = task.planning_as_of
    emergency = task.requests[1].model_copy(update={"received_at": now + 3600})
    task = task.model_copy(update={"requests": [task.requests[0], emergency]})
    result = solve(task, GraphTravel(graph), SETTINGS)
    stop = next(
        s for r in result.main.routes for s in r.stops if s.request_id == emergency.request_id
    )
    assert stop.start_at == now + 3600
    late_task = task.model_copy(
        update={
            "engineers": [task.engineers[0].model_copy(update={"available_from": now + 4 * 3600})]
        }
    )
    late = solve(late_task, GraphTravel(graph), SETTINGS)
    late_stop = next(
        s for r in late.main.routes for s in r.stops if s.request_id == emergency.request_id
    )
    assert late_stop.start_at == now + 4 * 3600


def test_connection_beats_urgent_repair_when_only_one_job_fits(snapshot, graph):
    task = task_with(snapshot, ["service", "connection"], capacity=1800)
    task = task.model_copy(
        update={
            "requests": [
                task.requests[0].model_copy(update={"priority": "urgent"}),
                task.requests[1],
            ]
        }
    )
    result = solve(task, GraphTravel(graph), SETTINGS)
    assert [a.request_id for a in result.main.assignments if a.status == "assigned"] == [
        "connection-1"
    ]


@pytest.mark.parametrize("policy", POLICIES)
def test_dispatcher_override_follows_emergency_and_precedes_connection(snapshot, graph, policy):
    task = task_with(snapshot, ["connection", "service", "emergency"])
    task = task.model_copy(update={
        "policy": task.policy.model_copy(update={"policy_id": policy}),
        "requests": [task.requests[0], task.requests[1].model_copy(update={"dispatcher_priority": True}), task.requests[2]],
    })
    result = solve(task, GraphTravel(graph), SETTINGS)
    jobs = sorted((s for r in result.main.routes for s in r.stops if s.kind == "job"), key=lambda s: s.start_at)
    assert [s.request_id for s in jobs] == ["emergency-2", "service-1", "connection-0"]
    validate_plan(task, result.main, GraphTravel(graph))


def test_dispatcher_override_wins_limited_capacity_over_connection(snapshot, graph):
    task = task_with(snapshot, ["connection", "service"], capacity=1800)
    task = task.model_copy(update={"requests": [task.requests[0], task.requests[1].model_copy(update={"dispatcher_priority": True})]})
    result = solve(task, GraphTravel(graph), SETTINGS)
    assert [a.request_id for a in result.main.assignments if a.status == "assigned"] == ["service-1"]
