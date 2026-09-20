"""Lunch alerts require an independently feasible coverage witness."""

from core.contracts import RouterTaskSnapshot
from core.geo import GraphTravel
from core.schedule import assemble_plan, baseline, fixed_order, lunch_coverage_alerts, validate_plan


def test_lunch_witness_preserves_actual_plan(snapshot, graph):
    data = snapshot.model_dump()
    start = snapshot.planning_as_of
    engineer = data["engineers"][0]
    engineer["shift_end_at"] = start + 3000
    engineer["lunch"] = dict(
        enabled=True,
        required=True,
        duration_sec=900,
        window_start_at=start + 100,
        window_end_at=start + 1000,
    )
    data["horizon_end_at"] = start + 3000
    data["requests"] = data["requests"][:2]
    for request in data["requests"]:
        request.update(
            service_duration_sec=1800,
            window_end_at=start + 3000,
            location=engineer["start_location"],
        )
    task = RouterTaskSnapshot.model_validate(data)
    travel = GraphTravel(graph)
    route = fixed_order(task, task.engineers[0], [task.requests[0].request_id], travel)
    assert route is not None
    plan = assemble_plan(task, [route])
    alerts = lunch_coverage_alerts(task, plan, travel)
    assert len(alerts) == 1
    assert alerts[0].reasons[0].facts["additional_assigned_count"] == 1
    assert route.lunch.status == "scheduled"
    assert plan.summary.assigned_count == 1
    validate_plan(task, plan.model_copy(update={"alerts": plan.alerts + alerts}), travel)
    passed = task.model_copy(update={"planning_as_of": start + 100})
    assert lunch_coverage_alerts(passed, plan, travel) == []


def test_no_lunch_alert_without_unassigned_demand(snapshot, graph):
    travel = GraphTravel(graph)
    route = fixed_order(
        snapshot, snapshot.engineers[0], [r.request_id for r in snapshot.requests], travel
    )
    assert route is not None
    assert lunch_coverage_alerts(snapshot, assemble_plan(snapshot, [route]), travel) == []


def test_required_lunch_of_no_show_does_not_block_working_engineer(snapshot, graph):
    data = snapshot.model_dump()
    absent = dict(data["engineers"][0])
    absent.update(
        engineer_id="absent", input_order=99, availability="offline", expected_online_at=None
    )
    absent["lunch"] = dict(
        enabled=True,
        required=True,
        duration_sec=1800,
        window_start_at=snapshot.planning_as_of + 100,
        window_end_at=snapshot.planning_as_of + 7200,
    )
    data["engineers"].append(absent)
    task = RouterTaskSnapshot.model_validate(data)
    travel = GraphTravel(graph)
    plan = baseline(task, travel)
    assert plan.is_usable
    assert plan.summary.assigned_count > 0
    assert not any("absent" in alert.engineer_ids for alert in plan.alerts)
    assert not next(r for r in plan.routes if r.engineer_id == "absent").stops
    validate_plan(task, plan, travel)


def test_lunch_position_minimizes_finish_instead_of_first_feasible(snapshot, graph):
    data = snapshot.model_dump()
    start = snapshot.planning_as_of
    engineer = data["engineers"][0]
    engineer["lunch"] = dict(
        enabled=True,
        required=True,
        duration_sec=300,
        window_start_at=start + 4000,
        window_end_at=start + 7000,
    )
    data["requests"] = data["requests"][:2]
    for request in data["requests"]:
        request.update(
            location=engineer["start_location"],
            service_duration_sec=300,
            window_start_at=start,
            window_end_at=start + 7000,
        )
    task = RouterTaskSnapshot.model_validate(data)
    route = fixed_order(
        task, task.engineers[0], [r.request_id for r in task.requests], GraphTravel(graph)
    )
    assert route is not None
    assert [s.kind for s in route.stops if s.kind != "wait"] == ["job", "job", "lunch"]
    assert route.finish_at == start + 4300
