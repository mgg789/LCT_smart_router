"""Dispatcher pins are hard input constraints in every routing path."""

import pytest
from core.contracts import RouterTaskSnapshot
from core.engine import SearchSettings, solve
from core.geo import GraphTravel
from pydantic import ValidationError


def pinned_snapshot(snapshot, *, order=None, offline=False):
    """Create two eligible crews and pin selected work to the second one."""
    data = snapshot.model_dump()
    second = {**data["engineers"][0], "engineer_id": "eng-2", "input_order": 1}
    if offline:
        second.update(availability="offline", expected_online_at=None)
    data["engineers"].append(second)
    pinned = set(order or ["job-1"])
    for request in data["requests"]:
        if request["request_id"] in pinned:
            request["pinned_engineer_id"] = "eng-2"
    if order:
        data["pinned_orders"] = [{"engineer_id": "eng-2", "request_ids": order}]
    return RouterTaskSnapshot.model_validate(data)


@pytest.mark.parametrize("traffic", [False, True])
@pytest.mark.parametrize("policy", ["fast", "compact", "sla", "balanced", "eco", "covering"])
def test_assignment_pin_survives_automatic_solve(snapshot, graph, traffic, policy):
    task = pinned_snapshot(snapshot)
    task = task.model_copy(update={"policy": task.policy.model_copy(update={"policy_id": policy})})
    output = solve(
        task, GraphTravel(graph), SearchSettings(time_limit_ms=200, traffic_enabled=traffic)
    )
    assert output.main.is_usable
    assert output.main.summary.assigned_count == 3
    assigned = {row.request_id: row.engineer_id for row in output.main.assignments}
    assert assigned["job-1"] == "eng-2"


@pytest.mark.parametrize("traffic", [False, True])
def test_relative_order_pin_leaves_other_work_automatic(snapshot, graph, traffic):
    task = pinned_snapshot(snapshot, order=["job-3", "job-1"])
    output = solve(
        task, GraphTravel(graph), SearchSettings(time_limit_ms=200, traffic_enabled=traffic)
    )
    assert output.main.is_usable
    assert output.main.summary.assigned_count == 3
    route = next(route for route in output.main.routes if route.engineer_id == "eng-2")
    jobs = [stop.request_id for stop in route.stops if stop.kind == "job"]
    assert jobs.index("job-3") < jobs.index("job-1")


@pytest.mark.parametrize("traffic", [False, True])
def test_unavailable_pinned_engineer_does_not_silently_release_the_pin(snapshot, graph, traffic):
    task = pinned_snapshot(snapshot, offline=True)
    output = solve(
        task, GraphTravel(graph), SearchSettings(time_limit_ms=200, traffic_enabled=traffic)
    )
    assert not output.main.is_usable
    assert not output.main.routes
    assert all(row.status == "unassigned" for row in output.main.assignments)
    assert any(alert.code == "DISPATCHER_CONSTRAINT_CONFLICT" for alert in output.main.alerts)


def test_replanning_preserves_pins_while_other_work_changes(snapshot, graph):
    task = pinned_snapshot(snapshot, order=["job-3", "job-1"])
    settings = SearchSettings(time_limit_ms=200)
    first = solve(task, GraphTravel(graph), settings)
    data = task.model_dump()
    data["requests"][1]["priority"] = "urgent"
    updated = RouterTaskSnapshot.model_validate(data)
    second = solve(updated, GraphTravel(graph), settings, first.memory)
    assert second.main.is_usable
    route = next(route for route in second.main.routes if route.engineer_id == "eng-2")
    jobs = [stop.request_id for stop in route.stops if stop.kind == "job"]
    assert jobs.index("job-3") < jobs.index("job-1")


def test_missing_pinned_roster_is_a_conflict_and_inconsistent_order_is_refused(snapshot, graph):
    data = snapshot.model_dump()
    data["requests"][0]["pinned_engineer_id"] = "unknown"
    missing_roster = RouterTaskSnapshot.model_validate(data)
    result = solve(missing_roster, GraphTravel(graph), SearchSettings(time_limit_ms=100))
    assert not result.main.is_usable
    assert any(row.code == "DISPATCHER_CONSTRAINT_CONFLICT" for row in result.main.alerts)
    data["requests"][0]["pinned_engineer_id"] = "eng-1"
    data["pinned_orders"] = [{"engineer_id": "eng-1", "request_ids": ["job-1", "job-2"]}]
    with pytest.raises(ValidationError):
        RouterTaskSnapshot.model_validate(data)


def test_absent_pins_do_not_change_the_wire_document(snapshot):
    encoded = snapshot.model_dump()
    assert "pinned_orders" not in encoded
    assert all("pinned_engineer_id" not in row for row in encoded["requests"])
