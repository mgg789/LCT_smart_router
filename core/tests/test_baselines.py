"""Greedy baseline planners: same rules as FIFO, different ordering and choice."""

from core.baselines import greedy_nearest, greedy_urgency
from core.contracts import RouterTaskSnapshot
from core.geo import GraphTravel
from core.schedule import baseline as fifo
from core.schedule import validate_plan

START = 1786946400


def _assignment_map(plan):
    return {
        assignment.request_id: assignment.engineer_id
        for assignment in plan.assignments
        if assignment.status == "assigned"
    }


def _engineer(engineer_id, input_order, graph, node_index):
    return {
        "engineer_id": engineer_id,
        "input_order": input_order,
        "skills": ["local"],
        "transport_type": "car",
        "shift_start_at": START,
        "shift_end_at": START + 8 * 3600,
        "start_location": graph.nodes[node_index].location.model_dump(),
        "available_from": START,
        "availability": "online",
        "expected_online_at": None,
        "lunch_taken": False,
        "lunch": {
            "enabled": False,
            "duration_sec": None,
            "window_start_at": None,
            "window_end_at": None,
            "required": False,
        },
        "equipment_stock": {"router": 0, "set_top_box": 0, "smart_speaker": 0},
    }


def _request(request_id, graph, node_index, arrival_order, *, priority="normal", **overrides):
    payload = {
        "request_id": request_id,
        "arrival_order": arrival_order,
        "location": graph.nodes[node_index].location.model_dump(),
        "service_duration_sec": 600,
        "window_start_at": START,
        "window_end_at": START + 7 * 3600,
        "priority": priority,
        "required_skill": "local",
        "required_transport": None,
    }
    payload.update(overrides)
    return payload


def _snapshot(graph, engineers, requests):
    return RouterTaskSnapshot.model_validate(
        {
            "schema_version": "1.0",
            "planning_as_of": START,
            "horizon_start_at": START,
            "horizon_end_at": START + 8 * 3600,
            "engineers": engineers,
            "requests": requests,
            "policy": {"policy_id": "fast", "parameters": {}},
        }
    )


def test_greedy_nearest_covers_the_same_day_as_fifo(graph, snapshot):
    travel = GraphTravel(graph)
    plan = greedy_nearest(snapshot, travel)
    validate_plan(snapshot, plan, travel)
    assert plan.is_usable
    assert plan.summary.assigned_count == 3


def test_greedy_nearest_prefers_the_closer_engineer_over_input_order(graph):
    travel = GraphTravel(graph)
    engineers = [
        _engineer("eng-far", 0, graph, 0),
        _engineer("eng-near", 1, graph, 2),
    ]
    requests = [_request("job-at-two", graph, 2, 0)]
    snapshot = _snapshot(graph, engineers, requests)
    plan = greedy_nearest(snapshot, travel)
    validate_plan(snapshot, plan, travel)
    assert _assignment_map(plan)["job-at-two"] == "eng-near"


def test_greedy_urgency_serves_the_narrow_urgent_window_first(graph):
    travel = GraphTravel(graph)
    engineers = [_engineer("eng-1", 0, graph, 0)]
    requests = [
        _request(
            "job-long-normal",
            graph,
            1,
            0,
            service_duration_sec=7200,
            window_end_at=START + 7 * 3600,
        ),
        _request(
            "job-urgent",
            graph,
            2,
            1,
            priority="urgent",
            work_category="emergency",
            window_start_at=START + 3600,
            window_end_at=START + 7200,
        ),
    ]
    snapshot = _snapshot(graph, engineers, requests)
    fifo_plan = fifo(snapshot, travel)
    greedy_plan = greedy_urgency(snapshot, travel)
    validate_plan(snapshot, fifo_plan, travel)
    validate_plan(snapshot, greedy_plan, travel)
    assert fifo_plan.summary.urgent_assigned_count == 0
    assert greedy_plan.summary.urgent_assigned_count == 1
    assert greedy_plan.summary.assigned_count == 2


def test_greedy_baselines_are_deterministic(graph, snapshot):
    travel = GraphTravel(graph)
    first = greedy_nearest(snapshot, travel)
    second = greedy_nearest(snapshot, travel)
    assert first.model_dump_json() == second.model_dump_json()
    assert (
        greedy_urgency(snapshot, travel).model_dump_json()
        == greedy_urgency(snapshot, travel).model_dump_json()
    )
