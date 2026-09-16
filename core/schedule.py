"""Pure fixed-order scheduling, baseline and independent result validation."""

from typing import Protocol

from core.contracts import (
    Assignment,
    Engineer,
    EngineerRoute,
    Geometry,
    GeoPoint,
    LunchResult,
    Plan,
    PlanMetrics,
    PlanningAlert,
    Reason,
    Request,
    RouteLeg,
    RouteMetrics,
    RouterTaskSnapshot,
    RouteStop,
    Transport,
)
from core.geo import TravelQuote
from core.policy import policy_score


class TravelProvider(Protocol):
    """Immutable map context; return None only for known unreachable travel."""

    version: str

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Return costs and path geometry from the same resource version."""
        ...


def release_at(snapshot: RouterTaskSnapshot, engineer: Engineer) -> int | None:
    """Conservative release; unknown or expired offline forecasts are unavailable."""
    if engineer.available_from is None:
        return None
    release = max(
        snapshot.planning_as_of,
        snapshot.horizon_start_at,
        engineer.shift_start_at,
        engineer.available_from,
    )
    if engineer.availability == "offline":
        if (
            engineer.expected_online_at is None
            or engineer.expected_online_at < snapshot.planning_as_of
        ):
            return None
        release = max(release, engineer.expected_online_at)
    return release if release <= min(engineer.shift_end_at, snapshot.horizon_end_at) else None


def eligible(snapshot: RouterTaskSnapshot, engineer: Engineer, request: Request) -> bool:
    """Check static skill/transport/release constraints without assigning a job."""
    return (
        request.required_skill in engineer.skills
        and request.required_transport in (None, engineer.transport_type)
        and release_at(snapshot, engineer) is not None
    )


def reason(code: str, text: str, *, outcome: bool = False, **facts) -> Reason:
    """Create structured evidence with explicit proof-versus-search distinction."""
    return Reason(
        code=code,
        text=text,
        basis="calculation_outcome" if outcome else "constraint_check",
        facts=facts,
    )


def route_metrics(stops: list[RouteStop], legs: list[RouteLeg]) -> RouteMetrics:
    """Recompute arithmetic from actual intervals; lunch is not work."""
    return RouteMetrics(
        distance_km=sum(round(leg.distance_km * 1000) for leg in legs) / 1000,
        travel_time_sec=sum(leg.travel_time_sec for leg in legs),
        work_time_sec=sum(s.end_at - s.start_at for s in stops if s.kind == "job"),
        waiting_time_sec=sum(s.end_at - s.start_at for s in stops if s.kind == "wait"),
        lunch_time_sec=sum(s.end_at - s.start_at for s in stops if s.kind == "lunch"),
        assigned_count=sum(s.kind == "job" for s in stops),
    )


def schedule_steps(
    snapshot: RouterTaskSnapshot,
    engineer: Engineer,
    steps: list[str | None],
    travel: TravelProvider,
) -> EngineerRoute | None:
    """Schedule a fixed order as early as possible; None is an explicit lunch step.

    Returns None on infeasibility. Does not change assignments or invent availability.
    Lunch location is the continuation point or the preceding job's location.
    """
    requests = {r.request_id: r for r in snapshot.requests}
    release = release_at(snapshot, engineer)
    if release is None and steps:
        return None
    if len([x for x in steps if x is not None]) != len(set(x for x in steps if x is not None)):
        return None
    lunch_count = steps.count(None)
    active_lunch = engineer.lunch.enabled and not engineer.lunch_taken
    if lunch_count > 1 or (lunch_count and not active_lunch):
        return None
    if active_lunch and engineer.lunch.required and lunch_count != 1:
        return None
    clock = release or 0
    location = engineer.start_location
    stops: list[RouteStop] = []
    legs: list[RouteLeg] = []
    lunch_stop = None
    end_limit = min(engineer.shift_end_at, snapshot.horizon_end_at)

    def add_stop(
        kind: str, request_id: str | None, arrival: int, start: int, end: int, point: GeoPoint
    ) -> RouteStop:
        stop = RouteStop(
            stop_id=f"{engineer.engineer_id}:{len(stops)}",
            sequence=len(stops),
            kind=kind,
            request_id=request_id,
            location=point,
            arrival_at=arrival,
            start_at=start,
            end_at=end,
        )
        stops.append(stop)
        return stop

    for request_id in steps:
        if request_id is None:
            lunch = engineer.lunch
            start = max(clock, lunch.window_start_at)
            end = start + lunch.duration_sec
            if end > min(end_limit, lunch.window_end_at):
                return None
            if start > clock:
                add_stop("wait", None, clock, clock, start, location)
            lunch_stop = add_stop("lunch", None, clock, start, end, location).stop_id
            clock = end
            continue
        request = requests.get(request_id)
        if request is None or not eligible(snapshot, engineer, request):
            return None
        quote = travel.quote(location, request.location, engineer.transport_type)
        if quote is None:
            return None
        arrival = clock + quote.duration_sec
        start = max(arrival, request.window_start_at)
        end = start + request.service_duration_sec
        if start > request.window_end_at or end > end_limit:
            return None
        previous_stop = stops[-1].stop_id if stops else None
        if start > arrival:
            first_stop = add_stop("wait", None, arrival, arrival, start, request.location)
            job = add_stop("job", request_id, arrival, start, end, request.location)
        else:
            job = add_stop("job", request_id, arrival, start, end, request.location)
            first_stop = job
        legs.append(
            RouteLeg(
                leg_id=f"{engineer.engineer_id}:leg:{len(legs)}",
                from_stop_id=previous_stop,
                to_stop_id=first_stop.stop_id,
                departure_at=clock,
                arrival_at=arrival,
                travel_time_sec=quote.duration_sec,
                distance_km=quote.distance_m / 1000,
                geometry=Geometry(points=list(quote.points)),
            )
        )
        clock, location = end, request.location
    if not engineer.lunch.enabled:
        lunch_result = LunchResult(status="disabled")
    elif engineer.lunch_taken:
        lunch_result = LunchResult(status="already_taken")
    elif lunch_stop:
        lunch_result = LunchResult(status="scheduled", stop_id=lunch_stop)
    else:
        lunch_result = LunchResult(
            status="not_scheduled",
            reasons=[
                reason(
                    "LUNCH_NOT_PLACED",
                    "No feasible lunch was found in this fixed-order candidate.",
                    outcome=True,
                )
            ],
            alert_id=f"lunch:{engineer.engineer_id}",
        )
    return EngineerRoute(
        engineer_id=engineer.engineer_id,
        start_location=engineer.start_location,
        start_at=release if stops else None,
        finish_at=clock if stops else None,
        stops=stops,
        legs=legs,
        lunch=lunch_result,
        metrics=route_metrics(stops, legs),
    )


def fixed_order(
    snapshot: RouterTaskSnapshot, engineer: Engineer, jobs: list[str], travel: TravelProvider
) -> EngineerRoute | None:
    """Try permitted lunch anchors without reordering jobs; prefer a feasible lunch."""
    if engineer.lunch.enabled and not engineer.lunch_taken:
        for position in range(len(jobs) + 1):
            route = schedule_steps(
                snapshot, engineer, jobs[:position] + [None] + jobs[position:], travel
            )
            if route is not None:
                return route
        if engineer.lunch.required:
            return None
    route = schedule_steps(snapshot, engineer, jobs, travel)
    if route and route.lunch.status == "not_scheduled" and jobs:
        # Only claim work displaced lunch when removing work really restores it.
        if schedule_steps(snapshot, engineer, [None], travel) is not None:
            lunch = route.lunch.model_copy(
                update={
                    "status": "skipped_for_work",
                    "reasons": [
                        reason(
                            "LUNCH_SKIPPED_FOR_WORK",
                            "Lunch fits without these jobs but not with this order.",
                            outcome=True,
                        )
                    ],
                }
            )
            route = route.model_copy(update={"lunch": lunch})
    return route


def unassigned_reason(snapshot: RouterTaskSnapshot, request: Request) -> Reason:
    """State only static impossibility proven by data, otherwise report search outcome."""
    skilled = [e for e in snapshot.engineers if request.required_skill in e.skills]
    transport = [e for e in skilled if request.required_transport in (None, e.transport_type)]
    if not skilled:
        return reason(
            "NO_SKILL_MATCH", "No engineer has the required skill.", skill=request.required_skill
        )
    if not transport:
        return reason("NO_TRANSPORT_MATCH", "No skilled engineer has the required transport.")
    if not any(release_at(snapshot, e) is not None for e in transport):
        return reason(
            "NO_AVAILABLE_ENGINEER", "No compatible engineer has known usable availability."
        )
    return reason(
        "NO_FEASIBLE_ASSIGNMENT_FOUND", "The bounded search found no assignment.", outcome=True
    )


def assemble_plan(
    snapshot: RouterTaskSnapshot, routes: list[EngineerRoute], conflicts: list[str] | None = None
) -> Plan:
    """Assemble assignments and independently summed metrics without changing routes."""
    conflicts = conflicts or []
    assigned = {
        s.request_id: (route.engineer_id, s.stop_id)
        for route in routes
        for s in route.stops
        if s.kind == "job"
    }
    assignments = []
    for request in snapshot.requests:
        owner = assigned.get(request.request_id)
        assignments.append(
            Assignment(
                request_id=request.request_id,
                status="assigned" if owner else "unassigned",
                engineer_id=owner[0] if owner else None,
                stop_id=owner[1] if owner else None,
                reasons=[
                    reason(
                        "CONSTRAINTS_SATISFIED",
                        "Skill, transport and schedule constraints verified.",
                    )
                    if owner
                    else unassigned_reason(snapshot, request)
                ],
            )
        )
    totals = {
        name: sum(getattr(r.metrics, name) for r in routes) for name in RouteMetrics.model_fields
    }
    totals["distance_km"] = sum(round(r.metrics.distance_km * 1000) for r in routes) / 1000
    summary = PlanMetrics(
        **totals,
        requests_total=len(snapshot.requests),
        unassigned_count=len(snapshot.requests) - len(assigned),
        urgent_total=sum(r.priority == "urgent" for r in snapshot.requests),
        urgent_assigned_count=sum(
            r.priority == "urgent" and r.request_id in assigned for r in snapshot.requests
        ),
        engineers_used=sum(r.metrics.assigned_count > 0 for r in routes),
    )
    alerts = [
        PlanningAlert(
            alert_id=f"lunch:{r.engineer_id}",
            code=r.lunch.reasons[0].code,
            severity="warning",
            engineer_ids=[r.engineer_id],
            request_ids=[],
            reasons=r.lunch.reasons,
        )
        for r in routes
        if r.lunch.alert_id
    ]
    for engineer_id in conflicts:
        alerts.append(
            PlanningAlert(
                alert_id=f"lunch:{engineer_id}",
                code="REQUIRED_LUNCH_UNPLACED",
                severity="error",
                engineer_ids=[engineer_id],
                request_ids=[],
                reasons=[
                    reason(
                        "REQUIRED_LUNCH_UNPLACED",
                        "No feasible required lunch candidate found.",
                        outcome=True,
                    )
                ],
            )
        )
    return Plan(
        is_usable=not conflicts,
        routes=routes,
        assignments=assignments,
        summary=summary,
        alerts=alerts,
    )


def baseline(snapshot: RouterTaskSnapshot, travel: TravelProvider) -> Plan:
    """FIFO jobs, first feasible engineer in input_order, append only; no optimization."""
    engineers = sorted(snapshot.engineers, key=lambda e: e.input_order)
    orders: dict[str, list[str]] = {e.engineer_id: [] for e in engineers}
    for request in sorted(snapshot.requests, key=lambda r: r.arrival_order):
        for engineer in engineers:
            order = orders[engineer.engineer_id] + [request.request_id]
            if eligible(snapshot, engineer, request) and fixed_order(
                snapshot, engineer, order, travel
            ):
                orders[engineer.engineer_id] = order
                break
    routes, conflicts = [], []
    for engineer in snapshot.engineers:
        route = fixed_order(snapshot, engineer, orders[engineer.engineer_id], travel)
        if route is None:
            conflicts.append(engineer.engineer_id)
        else:
            routes.append(route)
    # An unusable alternative must not expose a partially executable route set.
    return assemble_plan(snapshot, [] if conflicts else routes, conflicts)


def score(snapshot: RouterTaskSnapshot, plan: Plan) -> tuple[int, ...]:
    """Compare a candidate with the exact versioned policy selected by the snapshot."""
    return policy_score(snapshot, plan)


def validate_plan(snapshot: RouterTaskSnapshot, plan: Plan, travel: TravelProvider) -> None:
    """Raise ValueError on identity, timing, travel, metrics or lunch contract violations."""

    def require(condition: bool, message: str):
        if not condition:
            raise ValueError(f"RESULT_INVALID: {message}")

    require(len(plan.assignments) == len(snapshot.requests), "assignment count")
    require(
        {a.request_id for a in plan.assignments} == {r.request_id for r in snapshot.requests},
        "assignment identities",
    )
    if not plan.is_usable:
        require(not plan.routes, "unusable routes must not be executable")
        for assignment in plan.assignments:
            require(assignment.status == "unassigned", "unusable assignment status")
            require(
                assignment.engineer_id is None and assignment.stop_id is None,
                "unusable assignment link",
            )
            require(bool(assignment.reasons), "missing explanation")
        require(plan.summary == assemble_plan(snapshot, []).summary, "unusable plan totals")
        require(
            any(a.code == "REQUIRED_LUNCH_UNPLACED" for a in plan.alerts),
            "unusable plan needs a supported conflict reason",
        )
        return
    require(len(plan.routes) == len(snapshot.engineers), "route count")
    require(
        {r.engineer_id for r in plan.routes} == {e.engineer_id for e in snapshot.engineers},
        "engineer identities",
    )
    engineers = {e.engineer_id: e for e in snapshot.engineers}
    observed: dict[str, tuple[str, str]] = {}
    for route in plan.routes:
        engineer = engineers[route.engineer_id]
        steps = [s.request_id if s.kind == "job" else None for s in route.stops if s.kind != "wait"]
        expected = schedule_steps(snapshot, engineer, steps, travel)
        require(expected is not None, "hard schedule constraints")
        require(
            route.stops == expected.stops and route.legs == expected.legs,
            "interval/path arithmetic",
        )
        require(
            route.start_location == expected.start_location
            and route.start_at == expected.start_at
            and route.finish_at == expected.finish_at,
            "route bounds",
        )
        require(route.metrics == route_metrics(route.stops, route.legs), "route metrics")
        for stop in route.stops:
            if stop.kind == "job":
                require(stop.request_id not in observed, "duplicate assigned job")
                observed[stop.request_id] = (route.engineer_id, stop.stop_id)
        if expected.lunch.status in ("scheduled", "disabled", "already_taken"):
            require(
                route.lunch.status == expected.lunch.status
                and route.lunch.stop_id == expected.lunch.stop_id,
                "lunch result",
            )
        else:
            require(route.lunch.status in ("not_scheduled", "skipped_for_work"), "lunch status")
            require(
                route.lunch.stop_id is None
                and bool(route.lunch.reasons)
                and route.lunch.alert_id == f"lunch:{engineer.engineer_id}",
                "lunch explanation",
            )
            if route.lunch.status == "skipped_for_work":
                feasible = fixed_order(
                    snapshot, engineer, [s for s in steps if s is not None], travel
                )
                require(
                    feasible is not None and feasible.lunch.status != "scheduled",
                    "lunch could fit with these jobs",
                )
                require(
                    bool(steps) and schedule_steps(snapshot, engineer, [None], travel) is not None,
                    "work did not displace lunch",
                )
                require(
                    route.lunch.reasons[0].code == "LUNCH_SKIPPED_FOR_WORK", "lunch reason code"
                )
            else:
                require(route.lunch.reasons[0].code == "LUNCH_NOT_PLACED", "lunch reason code")
    for assignment in plan.assignments:
        owner = observed.get(assignment.request_id)
        require(
            (assignment.engineer_id, assignment.stop_id) == (owner or (None, None)),
            "assignment link",
        )
        require(assignment.status == ("assigned" if owner else "unassigned"), "assignment status")
        require(bool(assignment.reasons), "missing explanation")
    assembled = assemble_plan(snapshot, plan.routes)
    require(plan.summary == assembled.summary, "plan totals")
    require(plan.alerts == assembled.alerts, "plan alerts")
