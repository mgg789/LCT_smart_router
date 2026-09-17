"""Official-region benchmark and deterministic replanning acceptance scenarios."""

from __future__ import annotations

import time as monotonic_time
from dataclasses import dataclass
from datetime import date, datetime
from datetime import time as local_time
from typing import Literal
from zoneinfo import ZoneInfo

from core.contracts import Engineer, Plan, Request, RouterTaskSnapshot, Skill
from core.engine import EngineOutput, SearchSettings, solve
from core.evidence import PlanEvidence, build_plan_evidence
from core.geo import GraphTravel, RoadGraph, configure_travel, routing_context_version
from core.official import MultiZoneScenario, OfficialScenario
from core.schedule import validate_plan


@dataclass(frozen=True)
class EventRun:
    """One event's strict input, map context and validated Engine output."""

    event_id: str
    trigger: dict[str, str | int | float | list[str] | list[float]]
    snapshot: RouterTaskSnapshot
    graph: RoadGraph
    output: EngineOutput
    evidence: PlanEvidence
    changed_assignments: int
    context_changed: bool


@dataclass(frozen=True)
class BenchmarkRun:
    """Initial East calculation plus independent event replans from one stable plan."""

    scenario: OfficialScenario | MultiZoneScenario
    output: EngineOutput
    evidence: PlanEvidence
    elapsed_sec: float
    events: tuple[EventRun, ...]


def _model_snapshot(snapshot: RouterTaskSnapshot, **changes) -> RouterTaskSnapshot:
    payload = snapshot.model_dump()
    payload.update(changes)
    return RouterTaskSnapshot.model_validate(payload)


def _assignment_map(plan: Plan) -> dict[str, str | None]:
    return {assignment.request_id: assignment.engineer_id for assignment in plan.assignments}


def project_remaining_snapshot(
    snapshot: RouterTaskSnapshot,
    plan: Plan,
    event_at: int,
) -> RouterTaskSnapshot:
    """Create the remaining-work projection expected from Sys at an event time.

    Started jobs leave the request pool. Each engineer continues from the last known
    stop location and cannot accept new work before an in-progress stop completes.
    A travel leg crossing the event time is conservatively completed before release.

    Args:
        snapshot: Original full-day snapshot.
        plan: Validated plan currently applied by Sys.
        event_at: Absolute event timestamp in seconds.

    Returns:
        A new strict snapshot containing only unstarted and unassigned work.
    """
    if not snapshot.horizon_start_at <= event_at < snapshot.horizon_end_at:
        raise ValueError("event time lies outside the planning horizon")
    if not plan.is_usable:
        raise ValueError("remaining-work projection requires a usable applied plan")
    routes = {route.engineer_id: route for route in plan.routes}
    expected_engineers = {engineer.engineer_id for engineer in snapshot.engineers}
    if len(routes) != len(plan.routes) or set(routes) != expected_engineers:
        raise ValueError("applied plan must contain exactly one route per engineer")
    started = {
        stop.request_id
        for route in plan.routes
        for stop in route.stops
        if stop.kind == "job" and stop.request_id is not None and stop.start_at < event_at
    }
    remaining = [request for request in snapshot.requests if request.request_id not in started]
    engineers = []
    for engineer in snapshot.engineers:
        route = routes[engineer.engineer_id]
        point = engineer.start_location
        release = (
            None if engineer.available_from is None else max(event_at, engineer.available_from)
        )
        lunch_taken = engineer.lunch_taken
        for stop in route.stops:
            if stop.start_at >= event_at:
                break
            point = stop.location
            release = max(release or event_at, stop.end_at)
            if stop.kind == "lunch":
                lunch_taken = True
        for leg in route.legs:
            if leg.departure_at < event_at <= leg.arrival_at:
                target = next(
                    (stop for stop in route.stops if stop.stop_id == leg.to_stop_id), None
                )
                if target is None:
                    raise ValueError("travel leg target is absent from its engineer route")
                point = target.location
                release = max(release or event_at, leg.arrival_at)
                break
        engineers.append(
            engineer.model_copy(
                update={
                    "start_location": point,
                    "available_from": release,
                    "lunch_taken": lunch_taken,
                }
            )
        )
    return _model_snapshot(
        snapshot,
        planning_as_of=event_at,
        horizon_start_at=event_at,
        requests=[request.model_dump() for request in remaining],
        engineers=[engineer.model_dump() for engineer in engineers],
    )


def apply_traffic_multiplier(
    graph: RoadGraph,
    *,
    lat_min: float,
    lat_max: float,
    lon_min: float,
    lon_max: float,
    multiplier: float,
) -> RoadGraph:
    """Multiply travel seconds for directed edges touching a geographic zone.

    This benchmark graph is an all-pairs matrix, so zone membership is based on
    edge endpoints rather than hidden intermediate road geometry. Distance remains
    unchanged; the changed graph content produces a new context version.

    Args:
        graph: Immutable source graph to clone.
        lat_min: Southern edge of the affected WGS84 box.
        lat_max: Northern edge of the affected WGS84 box.
        lon_min: Western edge of the affected WGS84 box.
        lon_max: Eastern edge of the affected WGS84 box.
        multiplier: Factor applied to every transport duration on selected edges.

    Returns:
        A new graph with unchanged distances and multiplied selected durations.

    Raises:
        ValueError: If the multiplier is not an increase or the box selects no edge.
    """
    if multiplier <= 1:
        raise ValueError("traffic multiplier must exceed one")
    locations = {node.node_id: node.location for node in graph.nodes}

    def inside(node_id: str) -> bool:
        point = locations[node_id]
        return lat_min <= point.lat <= lat_max and lon_min <= point.lon <= lon_max

    changed = 0
    edges = []
    for edge in graph.edges:
        if inside(edge.source) or inside(edge.target):
            changed += 1
            durations = {
                profile: max(1, round(seconds * multiplier))
                for profile, seconds in edge.duration_sec.items()
            }
            edges.append(edge.model_copy(update={"duration_sec": durations}))
        else:
            edges.append(edge)
    if not changed:
        raise ValueError("traffic zone did not select any graph edges")
    return graph.model_copy(
        update={
            "version": f"{graph.version}:traffic-x{multiplier:g}",
            "source": f"{graph.source} Traffic multiplier x{multiplier:g} on {changed} edges.",
            "edges": edges,
        }
    )


def _with_new_request(
    snapshot: RouterTaskSnapshot,
    source_snapshot: RouterTaskSnapshot,
    *,
    request_id: str,
    priority: Literal["normal", "urgent"],
    skill: Skill,
    location_request_id: str,
    window_start_at: int,
    window_end_at: int,
    service_duration_sec: int,
) -> RouterTaskSnapshot:
    source = next(
        request for request in source_snapshot.requests if request.request_id == location_request_id
    )
    request = Request.model_validate(
        {
            "request_id": request_id,
            "arrival_order": max(
                (item.arrival_order for item in source_snapshot.requests), default=-1
            )
            + 1,
            "location": source.location.model_dump(),
            "service_duration_sec": service_duration_sec,
            "window_start_at": window_start_at,
            "window_end_at": window_end_at,
            "priority": priority,
            "required_skill": skill,
            "required_transport": None,
        }
    )
    return _model_snapshot(
        snapshot,
        requests=[item.model_dump() for item in snapshot.requests] + [request.model_dump()],
    )


def _with_offline_engineer(snapshot: RouterTaskSnapshot, engineer_id: str) -> RouterTaskSnapshot:
    engineers = [
        engineer.model_copy(update={"availability": "offline", "expected_online_at": None})
        if engineer.engineer_id == engineer_id
        else engineer
        for engineer in snapshot.engineers
    ]
    return _model_snapshot(snapshot, engineers=[engineer.model_dump() for engineer in engineers])


def _with_technical_stop(
    snapshot: RouterTaskSnapshot, engineer_ids: set[str], duration_sec: int
) -> RouterTaskSnapshot:
    engineers: list[Engineer] = []
    for engineer in snapshot.engineers:
        if engineer.engineer_id in engineer_ids:
            engineers.append(
                engineer.model_copy(
                    update={
                        "available_from": max(snapshot.planning_as_of, engineer.available_from or 0)
                        + duration_sec
                    }
                )
            )
        else:
            engineers.append(engineer)
    return _model_snapshot(snapshot, engineers=[engineer.model_dump() for engineer in engineers])


def run_replanning_events(
    scenario: OfficialScenario,
    initial: EngineOutput,
    settings: SearchSettings,
) -> tuple[EventRun, ...]:
    """Run five independent replans from a common applied East plan.

    Events cover a normal request, urgent request, engineer loss, simultaneous
    immediate technical stops and a geographic traffic-context change.

    Args:
        scenario: Prepared official East snapshot and graph.
        initial: Applied initial Engine output used as stable memory.
        settings: Bounded settings applied independently to every event.

    Returns:
        Five validated runs with triggers, detailed evidence and assignment deltas.
    """
    zone = ZoneInfo(scenario.config.timezone)
    local_day = date.fromisoformat(scenario.config.local_date)
    event_at = int(datetime.combine(local_day, local_time(15, 0), tzinfo=zone).timestamp())
    initial_snapshot = initial.memory.snapshot
    remaining = project_remaining_snapshot(initial_snapshot, initial.main, event_at)
    base_travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), remaining.planning_as_of
    )
    base_context_version = routing_context_version(base_travel, settings.technical())
    event_inputs = [
        (
            "new_normal_request",
            {
                "type": "new_request",
                "occurred_at": event_at,
                "request_id": "event-normal-1",
                "priority": "normal",
                "location_source_request_id": "73572",
            },
            _with_new_request(
                remaining,
                initial_snapshot,
                request_id="event-normal-1",
                priority="normal",
                skill="connection",
                location_request_id="73572",
                window_start_at=event_at + 3600,
                window_end_at=event_at + 3 * 3600,
                service_duration_sec=2700,
            ),
            scenario.graph,
            base_travel,
        ),
        (
            "new_urgent_request",
            {
                "type": "new_request",
                "occurred_at": event_at,
                "request_id": "event-urgent-1",
                "priority": "urgent",
                "location_source_request_id": "4893",
            },
            _with_new_request(
                remaining,
                initial_snapshot,
                request_id="event-urgent-1",
                priority="urgent",
                skill="emergency",
                location_request_id="4893",
                window_start_at=event_at + 1800,
                window_end_at=event_at + 2 * 3600 + 1800,
                service_duration_sec=3600,
            ),
            scenario.graph,
            base_travel,
        ),
        (
            "engineer_offline",
            {
                "type": "engineer_offline",
                "occurred_at": event_at,
                "engineer_ids": ["east-team-02"],
            },
            _with_offline_engineer(remaining, "east-team-02"),
            scenario.graph,
            base_travel,
        ),
        (
            "two_technical_stops_15m",
            {
                "type": "technical_stop",
                "occurred_at": event_at,
                "engineer_ids": ["east-team-01", "east-team-02"],
                "duration_sec": 900,
            },
            _with_technical_stop(remaining, {"east-team-01", "east-team-02"}, 900),
            scenario.graph,
            base_travel,
        ),
    ]
    traffic_graph = apply_traffic_multiplier(
        scenario.graph,
        lat_min=55.7,
        lat_max=55.715,
        lon_min=37.76,
        lon_max=37.79,
        multiplier=3.0,
    )
    affected_edges = sum(
        original.duration_sec != changed.duration_sec
        for original, changed in zip(scenario.graph.edges, traffic_graph.edges, strict=True)
    )
    event_inputs.append(
        (
            "district_traffic_x3",
            {
                "type": "traffic_multiplier",
                "occurred_at": event_at,
                "multiplier": 3.0,
                "bounding_box": [55.7, 37.76, 55.715, 37.79],
                "affected_directed_edges": affected_edges,
            },
            remaining,
            traffic_graph,
            configure_travel(GraphTravel(traffic_graph), settings.technical()),
        )
    )
    previous_assignments = _assignment_map(initial.main)
    labels = {
        engineer_id: str(details["control_team"])
        for engineer_id, details in scenario.engineer_details.items()
    }
    runs = []
    for event_id, trigger, snapshot, graph, travel in event_inputs:
        travel = configure_travel(travel, settings.technical(), snapshot.planning_as_of)
        event_context_version = routing_context_version(travel, settings.technical())
        output = solve(
            snapshot,
            travel,
            settings,
            memory=initial.memory,
            context_version=event_context_version,
        )
        effective_snapshot = output.memory.snapshot
        validate_plan(effective_snapshot, output.main, travel)
        current = _assignment_map(output.main)
        changed = sum(
            previous_assignments.get(request_id) != engineer_id
            for request_id, engineer_id in current.items()
        )
        runs.append(
            EventRun(
                event_id=event_id,
                trigger=trigger,
                snapshot=snapshot,
                graph=graph,
                output=output,
                evidence=build_plan_evidence(effective_snapshot, output.main, travel, labels),
                changed_assignments=changed,
                context_changed=event_context_version != base_context_version,
            )
        )
    return tuple(runs)


def run_official_benchmark(
    scenario: OfficialScenario | MultiZoneScenario,
    settings: SearchSettings,
    *,
    event_settings: SearchSettings | None = None,
) -> BenchmarkRun:
    """Calculate the official baseline/main pair, evidence and optional events.

    Args:
        scenario: Prepared official East snapshot and graph.
        settings: Bounded settings for the initial plan.
        event_settings: Per-event settings, or ``None`` to skip event calculations.

    Returns:
        The validated initial output, evidence, elapsed time and event runs.
    """
    travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
    )
    context_version = routing_context_version(travel, settings.technical())
    started = monotonic_time.perf_counter()
    output = solve(scenario.snapshot, travel, settings, context_version=context_version)
    elapsed = monotonic_time.perf_counter() - started
    effective_snapshot = output.memory.snapshot
    validate_plan(effective_snapshot, output.main, travel)
    labels = {
        engineer_id: str(details["control_team"])
        for engineer_id, details in scenario.engineer_details.items()
    }
    evidence = build_plan_evidence(effective_snapshot, output.main, travel, labels)
    events = (
        run_replanning_events(scenario, output, event_settings)
        if event_settings is not None
        and isinstance(scenario, OfficialScenario)
        and scenario.config.region == "east"
        else ()
    )
    return BenchmarkRun(scenario, output, evidence, elapsed, events)


def benchmark_payload(run: BenchmarkRun) -> dict:
    """Serialize plans, detailed evidence and event deltas as JSON-compatible data.

    Args:
        run: Completed official benchmark run.

    Returns:
        A dictionary ready for UTF-8 JSON serialization by the CLI.
    """

    before = {assignment.request_id: assignment for assignment in run.output.main.assignments}

    def changes(event: EventRun) -> list[dict[str, object]]:
        after = {assignment.request_id: assignment for assignment in event.output.main.assignments}
        result = []
        for request_id, assignment in after.items():
            previous = before.get(request_id)
            if previous is None or previous.engineer_id != assignment.engineer_id:
                result.append(
                    {
                        "request_id": request_id,
                        "before_status": previous.status if previous else None,
                        "before_engineer_id": previous.engineer_id if previous else None,
                        "after_status": assignment.status,
                        "after_engineer_id": assignment.engineer_id,
                    }
                )
        return result

    config = run.scenario.config if isinstance(run.scenario, OfficialScenario) else None
    return {
        "schema_version": "1.0",
        "scenario_id": config.scenario_id if config else run.scenario.scenario_id,
        "source": {
            "requests": len(run.scenario.snapshot.requests),
            "engineers": len(run.scenario.snapshot.engineers),
            "geocode_quality": run.scenario.geocode_quality,
            "zones": [config.region] if config else list(run.scenario.zones),
        },
        "assumptions": config.assumptions if config else run.scenario.assumptions,
        "search": {
            "path": run.output.path,
            "elapsed_sec": run.elapsed_sec,
        },
        "main": run.output.main.model_dump(),
        "baseline": run.output.baseline.model_dump(),
        "evidence": run.evidence.model_dump(),
        "request_details": run.scenario.request_details,
        "engineer_details": run.scenario.engineer_details,
        "events": [
            {
                "event_id": event.event_id,
                "trigger": event.trigger,
                "search_path": event.output.path,
                "context_changed": event.context_changed,
                "changed_assignments": event.changed_assignments,
                "assignment_changes": changes(event),
                "summary": event.output.main.summary.model_dump(),
                "main": event.output.main.model_dump(),
                "baseline": event.output.baseline.model_dump(),
                "evidence": event.evidence.model_dump(),
                "unassigned_request_ids": [
                    assignment.request_id
                    for assignment in event.output.main.assignments
                    if assignment.status == "unassigned"
                ],
            }
            for event in run.events
        ],
    }
