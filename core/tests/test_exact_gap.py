"""Exact micro-instance enumeration: optimum, capping and lunch guard."""

import pytest
from core.contracts import RouterTaskSnapshot
from core.exact_gap import exact_micro, requires_lunchless_engineers
from core.geo import GraphTravel
from core.schedule import baseline as fifo

START = 1786946400


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


def _request(request_id, graph, node_index, arrival_order):
    return {
        "request_id": request_id,
        "arrival_order": arrival_order,
        "location": graph.nodes[node_index].location.model_dump(),
        "service_duration_sec": 600,
        "window_start_at": START,
        "window_end_at": START + 7 * 3600,
        "priority": "normal",
        "required_skill": "local",
        "required_transport": None,
    }


def _snapshot(graph, engineers, requests):
    return RouterTaskSnapshot.model_validate(
        {
            "schema_version": "1.0",
            "planning_as_of": START,
            "horizon_start_at": START,
            "horizon_end_at": START + 8 * 3600,
            "engineers": engineers,
            "requests": requests,
            "policy": {"policy_id": "compact", "parameters": {}},
        }
    )


def _three_job_instance(graph):
    engineers = [_engineer("eng-a", 0, graph, 0), _engineer("eng-b", 1, graph, 3)]
    requests = [
        _request("job-1", graph, 1, 0),
        _request("job-2", graph, 2, 1),
        _request("job-3", graph, 3, 2),
    ]
    return _snapshot(graph, engineers, requests)


def test_exact_micro_finds_the_single_crew_plan(graph):
    """Compact objective prefers one busy crew over two, then least travel."""
    snapshot = _three_job_instance(graph)
    travel = GraphTravel(graph)
    result = exact_micro(snapshot, travel)
    assert result.status == "optimal"
    assert result.unassigned_count == 0
    assert result.engineers_used == 1
    # eng-b starts at job-3's node: hops 3->2->1 cost 60 s each, one idle crew.
    assert result.travel_time_sec == 120
    assert result.routes == {"eng-b": ["job-3", "job-2", "job-1"]}


def test_exact_micro_never_loses_to_the_fifo_heuristic(graph):
    snapshot = _three_job_instance(graph)
    travel = GraphTravel(graph)
    result = exact_micro(snapshot, travel)
    plan = fifo(snapshot, travel)
    heuristic = (
        plan.summary.unassigned_count,
        plan.summary.engineers_used,
        plan.summary.travel_time_sec,
    )
    assert heuristic >= result.objective


def test_exact_micro_reports_capped_without_optimality_claim(graph):
    snapshot = _three_job_instance(graph)
    result = exact_micro(snapshot, GraphTravel(graph), max_route_builds=1)
    assert result.status == "capped"


def test_exact_micro_refuses_active_lunches(graph):
    snapshot = _three_job_instance(graph)
    lunch = snapshot.model_copy(
        update={
            "engineers": [
                engineer.model_copy(
                    update={
                        "lunch": engineer.lunch.model_copy(
                            update={
                                "enabled": True,
                                "required": True,
                                "duration_sec": 1800,
                                "window_start_at": START + 3600,
                                "window_end_at": START + 5 * 3600,
                            }
                        )
                    }
                )
                for engineer in snapshot.engineers
            ]
        }
    )
    with pytest.raises(ValueError, match="disabled lunches"):
        requires_lunchless_engineers(lunch)
