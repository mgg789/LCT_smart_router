"""Manual constraints stay above policy goals while execution inputs remain immutable."""

from core.contracts import ManualDecision
from core.engine import SearchSettings, solve
from core.geo import GraphTravel

SETTINGS = SearchSettings(time_limit_ms=150, solution_limit=8, access_buffer_sec=0)


def decision(id, kind, target, priority=0, **values):
    return ManualDecision(id=id, kind=kind, target_id=target, priority=priority, **values)


def run(snapshot, graph, items):
    return solve(
        snapshot.model_copy(update={"manual_decisions": items}), GraphTravel(graph), SETTINGS
    )


def test_assignment_and_none(snapshot, graph):
    first, second = snapshot.requests[:2]
    engineer = snapshot.engineers[0]
    result = run(
        snapshot,
        graph,
        [
            decision("assign", "assignment", first.request_id, engineer_id=engineer.engineer_id),
            decision("none", "assignment", second.request_id, engineer_id=None),
        ],
    )
    assignments = {a.request_id: a for a in result.main.assignments}
    assert assignments[first.request_id].engineer_id == engineer.engineer_id
    assert assignments[second.request_id].status == "unassigned"
    assert result.main.manual_resolution.rejected_ids == []
    assert result.baseline.summary.assigned_count == 3
    assert snapshot.requests[1].manual_unassigned is False


def test_priority_conflict_reorders_assignments(snapshot, graph):
    start = snapshot.planning_as_of
    engineer = snapshot.engineers[0].model_copy(
        update={"shift_end_at": start + 600, "lunch_taken": True}
    )
    requests = [
        r.model_copy(
            update={
                "location": engineer.start_location,
                "window_start_at": start,
                "window_end_at": start + 600,
                "service_duration_sec": 600,
            }
        )
        for r in snapshot.requests[:2]
    ]
    task = snapshot.model_copy(update={"requests": requests, "engineers": [engineer]})
    items = [
        decision(
            "first", "assignment", requests[0].request_id, 0, engineer_id=engineer.engineer_id
        ),
        decision(
            "second", "assignment", requests[1].request_id, 1, engineer_id=engineer.engineer_id
        ),
        decision("shift", "shift", engineer.engineer_id, 0, start_at=start, end_at=start + 600),
    ]
    output = run(task, graph, items)
    assert "first" in output.main.manual_resolution.accepted_ids
    assert "second" in output.main.manual_resolution.rejected_ids
    assert {"first", "second"} <= set(output.main.manual_resolution.conflict_ids)
    items[0] = items[0].model_copy(update={"priority": 2})
    items[1] = items[1].model_copy(update={"priority": 0})
    output = run(task, graph, items)
    assert "second" in output.main.manual_resolution.accepted_ids
    assert "first" in output.main.manual_resolution.rejected_ids


def test_window_and_lunch_shift_are_real_constraints(snapshot, graph):
    start = snapshot.planning_as_of
    engineer = snapshot.engineers[0]
    request = snapshot.requests[0].model_copy(
        update={"location": engineer.start_location, "service_duration_sec": 600}
    )
    task = snapshot.model_copy(update={"requests": [request]})
    items = [
        decision("assign", "assignment", request.request_id, engineer_id=engineer.engineer_id),
        decision("window", "window", request.request_id, start_at=start + 600, end_at=start + 1200),
        decision("shift", "shift", engineer.engineer_id, start_at=start, end_at=start + 7200),
        decision(
            "lunch", "lunch", engineer.engineer_id, start_at=start + 2400, end_at=start + 6000
        ),
    ]
    output = run(task, graph, items)
    assert output.main.manual_resolution.rejected_ids == []
    stops = output.main.routes[0].stops
    job = next(s for s in stops if s.kind == "job")
    lunch = next(s for s in stops if s.kind == "lunch")
    assert start + 600 <= job.start_at and job.end_at <= start + 1200
    assert start + 2400 <= lunch.start_at and lunch.end_at <= start + 6000


def test_offline_and_expired_intents(snapshot, graph):
    task = snapshot.model_copy(
        update={
            "engineers": [
                snapshot.engineers[0].model_copy(
                    update={"availability": "offline", "expected_online_at": None}
                )
            ]
        }
    )
    output = run(
        task,
        graph,
        [
            decision(
                "offline",
                "assignment",
                snapshot.requests[0].request_id,
                engineer_id=task.engineers[0].engineer_id,
            ),
            decision("done", "window", "already-finished", start_at=0, end_at=1),
        ],
    )
    assert "offline" in output.main.manual_resolution.rejected_ids
    assert "done" in output.main.manual_resolution.accepted_ids
