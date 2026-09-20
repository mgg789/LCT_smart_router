"""Window suggestions must be actual route witnesses and must not mutate inputs."""

import pytest
from core.geo import GraphTravel
from core.schedule import fixed_order
from core.window_proposal import propose_window


def test_finds_verified_insertion_and_preserves_input(snapshot, graph):
    before = snapshot.model_dump()
    travel = GraphTravel(graph)
    result = propose_window(
        snapshot, travel, "job-2", {"eng-1": ["job-1", "job-3"]}, snapshot.horizon_end_at
    )
    assert result["status"] == "available"
    proposal = result["proposal"]
    assert proposal["windowStartAt"] <= proposal["serviceStartAt"]
    assert proposal["serviceEndAt"] <= proposal["windowEndAt"] <= snapshot.horizon_end_at
    narrowed = snapshot.model_copy(
        update={
            "requests": [
                job.model_copy(
                    update={
                        "window_start_at": proposal["windowStartAt"],
                        "window_end_at": proposal["windowEndAt"],
                    }
                )
                if job.request_id == "job-2"
                else job
                for job in snapshot.requests
            ]
        }
    )
    assert any(
        fixed_order(narrowed, narrowed.engineers[0], order, travel) is not None
        for order in [
            ["job-2", "job-1", "job-3"],
            ["job-1", "job-2", "job-3"],
            ["job-1", "job-3", "job-2"],
        ]
    )
    assert snapshot.model_dump() == before


def test_no_slot_when_shift_is_over(snapshot, graph):
    task = snapshot.model_copy(update={"planning_as_of": snapshot.horizon_end_at + 1})
    assert propose_window(task, GraphTravel(graph), "job-1", {}, snapshot.horizon_end_at) == {
        "status": "none",
        "proposal": None,
    }


def test_no_slot_without_required_skill(snapshot, graph):
    task = snapshot.model_copy(
        update={
            "engineers": [
                engineer.model_copy(update={"skills": ["emergency"]})
                for engineer in snapshot.engineers
            ]
        }
    )
    assert (
        propose_window(task, GraphTravel(graph), "job-1", {}, snapshot.horizon_end_at)["status"]
        == "none"
    )


def test_unknown_routes_are_not_silently_dropped(snapshot, graph):
    with pytest.raises(ValueError, match="INVALID_PREVIEW_ROUTES"):
        propose_window(
            snapshot, GraphTravel(graph), "job-1", {"eng-1": ["foreign"]}, snapshot.horizon_end_at
        )
