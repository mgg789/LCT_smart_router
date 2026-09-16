"""Structured, calculation-backed evidence for UI and explanation-only LLMs."""

from __future__ import annotations

from core.contracts import (
    CandidateEvidence,
    Plan,
    PlanEvidence,
    RequestEvidence,
    RouterTaskSnapshot,
)
from core.schedule import TravelProvider, eligible, fixed_order, release_at


def build_plan_evidence(
    snapshot: RouterTaskSnapshot,
    plan: Plan,
    travel: TravelProvider,
    engineer_labels: dict[str, str] | None = None,
) -> PlanEvidence:
    """Derive UI/LLM evidence from a validated plan and the same travel context.

    The candidate checks are deliberately limited: ``solo_feasible`` proves that a
    request fits an otherwise empty route, while ``append_at_route_end_feasible``
    checks only the current route order with the request appended. Neither field
    claims that global bounded search proved impossibility.

    Args:
        snapshot: Exact remaining-work snapshot used by Engine.
        plan: Validated main or baseline plan for that snapshot.
        travel: The same immutable travel provider used for calculation.
        engineer_labels: Optional business labels keyed by engineer ID.

    Returns:
        Typed per-request factors and alternatives suitable for deterministic UI
        rendering or an explanation-only LLM prompt.
    """
    labels = engineer_labels or {}
    assignments = {assignment.request_id: assignment for assignment in plan.assignments}
    routes = {route.engineer_id: route for route in plan.routes}
    orders = {
        engineer.engineer_id: [
            stop.request_id
            for stop in (
                routes[engineer.engineer_id].stops
                if engineer.engineer_id in routes
                else ()
            )
            if stop.kind == "job" and stop.request_id is not None
        ]
        for engineer in snapshot.engineers
    }
    route_stops = {
        stop.request_id: (route, index, stop)
        for route in plan.routes
        for index, stop in enumerate(route.stops)
        if stop.kind == "job" and stop.request_id is not None
    }
    evidence = []
    for request in snapshot.requests:
        assignment = assignments[request.request_id]
        selected = route_stops.get(request.request_id)
        predecessor = None
        arrival = start = end = waiting = start_offset = end_margin = travel_time = None
        distance = None
        if selected:
            route, stop_index, stop = selected
            arrival, start, end = stop.arrival_at, stop.start_at, stop.end_at
            waiting = stop.start_at - stop.arrival_at
            start_offset = stop.start_at - request.window_start_at
            end_margin = request.window_end_at - stop.start_at
            for prior in reversed(route.stops[:stop_index]):
                if prior.kind == "job":
                    predecessor = prior.request_id
                    break
            leg_target = stop.stop_id
            if stop_index and route.stops[stop_index - 1].kind == "wait":
                leg_target = route.stops[stop_index - 1].stop_id
            leg = next((item for item in route.legs if item.to_stop_id == leg_target), None)
            if leg:
                travel_time, distance = leg.travel_time_sec, leg.distance_km

        candidates = []
        for engineer in snapshot.engineers:
            skill_match = request.required_skill in engineer.skills
            transport_match = request.required_transport in (None, engineer.transport_type)
            release = release_at(snapshot, engineer)
            available = release is not None
            static_ok = eligible(snapshot, engineer, request)
            solo = (
                fixed_order(snapshot, engineer, [request.request_id], travel) if static_ok else None
            )
            current = [job for job in orders[engineer.engineer_id] if job != request.request_id]
            current_route = fixed_order(snapshot, engineer, current, travel) if static_ok else None
            appended = (
                fixed_order(snapshot, engineer, current + [request.request_id], travel)
                if static_ok
                else None
            )
            appended_stop = (
                next(
                    stop
                    for stop in appended.stops
                    if stop.kind == "job" and stop.request_id == request.request_id
                )
                if appended is not None
                else None
            )
            blockers = []
            if not skill_match:
                blockers.append("skill_missing")
            if not transport_match:
                blockers.append("transport_mismatch")
            if not available:
                blockers.append("unavailable")
            if static_ok and solo is None:
                blockers.append("solo_schedule_infeasible")
            if static_ok and solo is not None and appended is None:
                blockers.append("current_route_append_infeasible")
            candidates.append(
                CandidateEvidence(
                    engineer_id=engineer.engineer_id,
                    label=labels.get(engineer.engineer_id),
                    skills=list(engineer.skills),
                    transport_type=engineer.transport_type,
                    release_at=release,
                    shift_end_at=engineer.shift_end_at,
                    skill_match=skill_match,
                    transport_match=transport_match,
                    available=available,
                    solo_feasible=solo is not None,
                    append_at_route_end_feasible=appended is not None,
                    append_start_at=appended_stop.start_at if appended_stop else None,
                    append_end_at=appended_stop.end_at if appended_stop else None,
                    append_incremental_travel_time_sec=(
                        appended.metrics.travel_time_sec - current_route.metrics.travel_time_sec
                        if appended is not None and current_route is not None
                        else None
                    ),
                    append_incremental_distance_km=(
                        round(appended.metrics.distance_km - current_route.metrics.distance_km, 3)
                        if appended is not None and current_route is not None
                        else None
                    ),
                    assigned_job_count=len(orders[engineer.engineer_id]),
                    blockers=blockers,
                )
            )
        evidence.append(
            RequestEvidence(
                request_id=request.request_id,
                status=assignment.status,
                priority=request.priority,
                required_skill=request.required_skill,
                required_transport=request.required_transport,
                service_duration_sec=request.service_duration_sec,
                window_start_at=request.window_start_at,
                window_end_at=request.window_end_at,
                engineer_id=assignment.engineer_id,
                stop_id=assignment.stop_id,
                predecessor_request_id=predecessor,
                arrival_at=arrival,
                start_at=start,
                end_at=end,
                waiting_time_sec=waiting,
                window_start_offset_sec=start_offset,
                window_end_margin_sec=end_margin,
                travel_time_sec=travel_time,
                distance_km=distance,
                reason_codes=[reason.code for reason in assignment.reasons],
                reasons=list(assignment.reasons),
                candidates=candidates,
            )
        )
    return PlanEvidence(requests=evidence)
