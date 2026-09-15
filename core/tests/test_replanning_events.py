"""Acceptance checks for the five required live replanning events."""

import pytest
from core.benchmark import _with_new_request, project_remaining_snapshot


def _by_id(events):
    return {event.event_id: event for event in events}


def test_new_normal_and_urgent_requests_are_inserted(official_east_events):
    events = _by_id(official_east_events)
    normal = events["new_normal_request"]
    urgent = events["new_urgent_request"]
    for event, request_id in (
        (normal, "event-normal-1"),
        (urgent, "event-urgent-1"),
    ):
        assignment = next(
            item for item in event.output.main.assignments if item.request_id == request_id
        )
        assert assignment.status == "assigned"
        assert event.output.path == "REPAIR_AND_IMPROVE"
        assert event.changed_assignments >= 1
    assert urgent.output.main.summary.urgent_total == normal.output.main.summary.urgent_total + 1
    assert urgent.output.main.summary.urgent_assigned_count == (
        normal.output.main.summary.urgent_assigned_count + 1
    )


def test_offline_engineer_receives_no_remaining_work(official_east_events):
    event = _by_id(official_east_events)["engineer_offline"]
    engineer = next(item for item in event.snapshot.engineers if item.engineer_id == "east-team-02")
    route = next(item for item in event.output.main.routes if item.engineer_id == "east-team-02")
    assert engineer.availability == "offline"
    assert not [stop for stop in route.stops if stop.kind == "job"]
    assert event.output.main.is_usable


def test_two_technical_stops_delay_both_engineers(official_east_events):
    event = _by_id(official_east_events)["two_technical_stops_15m"]
    assert event.trigger["duration_sec"] == 900
    for engineer_id in ("east-team-01", "east-team-02"):
        engineer = next(
            item for item in event.snapshot.engineers if item.engineer_id == engineer_id
        )
        route = next(item for item in event.output.main.routes if item.engineer_id == engineer_id)
        assert engineer.available_from is not None
        assert route.start_at is None or route.start_at >= engineer.available_from
    assert event.output.main.is_usable


def test_district_traffic_invalidates_context_and_multiplies_edges(
    official_east_scenario, official_east_events
):
    event = _by_id(official_east_events)["district_traffic_x3"]
    changed = 0
    for before, after in zip(official_east_scenario.graph.edges, event.graph.edges, strict=True):
        if before.duration_sec != after.duration_sec:
            changed += 1
            assert all(
                after.duration_sec[profile] == round(seconds * 3)
                for profile, seconds in before.duration_sec.items()
            )
    assert changed == event.trigger["affected_directed_edges"]
    assert changed > 0
    assert event.context_changed
    assert event.output.path == "COLD_START"
    assert event.output.main.is_usable


def test_every_event_has_llm_ready_evidence(official_east_events):
    for event in official_east_events:
        assert len(event.evidence.requests) == len(event.snapshot.requests)
        assert all(
            len(request.candidates) == len(event.snapshot.engineers)
            for request in event.evidence.requests
        )


def test_new_request_can_arrive_after_all_prior_work_left_the_pool(official_east_scenario):
    snapshot = official_east_scenario.snapshot.model_copy(update={"requests": []})
    created = _with_new_request(
        snapshot,
        official_east_scenario.snapshot,
        request_id="event-late",
        priority="normal",
        skill="local",
        location_request_id="73572",
        window_start_at=snapshot.horizon_start_at,
        window_end_at=snapshot.horizon_end_at,
        service_duration_sec=900,
    )
    assert (
        created.requests[0].arrival_order
        == max(request.arrival_order for request in official_east_scenario.snapshot.requests) + 1
    )


def test_projection_rejects_an_unusable_or_partial_plan(official_east_scenario, official_east_run):
    event_at = official_east_scenario.snapshot.horizon_start_at + 3600
    unusable = official_east_run.output.main.model_copy(update={"is_usable": False})
    with pytest.raises(ValueError, match="usable applied plan"):
        project_remaining_snapshot(official_east_scenario.snapshot, unusable, event_at)
    partial = official_east_run.output.main.model_copy(
        update={"routes": official_east_run.output.main.routes[:-1]}
    )
    with pytest.raises(ValueError, match="one route per engineer"):
        project_remaining_snapshot(official_east_scenario.snapshot, partial, event_at)
