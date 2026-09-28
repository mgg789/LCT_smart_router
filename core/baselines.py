"""Deterministic greedy baselines sharing the exact FIFO eligibility rules.

Both planners are append-only: a request may only extend a route tail, under
the same constraints and the same terminal-overtime reservation as the exact
FIFO baseline. Only the request order and the engineer choice differ, so the
benchmark comparison isolates the value of the optimizer, not of relaxed rules.
"""

from __future__ import annotations

from typing import Callable

from core.contracts import Plan, Request, RouterTaskSnapshot
from core.schedule import (
    TravelProvider,
    _baseline_eligible,
    assemble_plan,
    fixed_order,
    job_completion_limit,
)

_EngineerChoice = Callable[[Request, list[tuple], dict[str, int | None]], object]


def _incremental_travel(candidates: list[tuple], previous: dict[str, object]) -> tuple:
    """Pick the append with the smallest travel delta over the engineer's route.

    An unused engineer pays the whole route from its start location; a busy one
    pays only the delta, including any lunch re-placement that the append causes.
    Ties fall back to the candidate order, which is deterministic by input order.
    """

    def cost(item: tuple) -> int:
        route, engineer = item
        prior = previous.get(engineer.engineer_id)
        base = prior.metrics.travel_time_sec if prior is not None else 0
        return route.metrics.travel_time_sec - base

    return min(candidates, key=cost)


def _greedy(
    snapshot: RouterTaskSnapshot,
    travel: TravelProvider,
    *,
    order_key: Callable[[Request], tuple],
    choose: _EngineerChoice,
) -> Plan:
    """Append-only pass with pluggable ordering and engineer choice, then leftovers.

    The first pass reserves terminal overtime exactly like the FIFO baseline; the
    deferred leftover pass accepts any feasible append so that known-late crews
    keep their historical second chance.
    """
    engineers = sorted(snapshot.engineers, key=lambda e: e.input_order)
    orders: dict[str, list[str]] = {e.engineer_id: [] for e in engineers}
    previous: dict[str, object] = {e.engineer_id: None for e in engineers}
    deferred: list[Request] = []
    for request in sorted(snapshot.requests, key=order_key):
        candidates = []
        for engineer in engineers:
            order = orders[engineer.engineer_id] + [request.request_id]
            route = (
                fixed_order(snapshot, engineer, order, travel)
                if _baseline_eligible(snapshot, engineer, request)
                else None
            )
            uses_terminal_overtime = bool(
                route
                and route.finish_at is not None
                and route.finish_at > job_completion_limit(snapshot, engineer, terminal=False)
            )
            if route is not None and not uses_terminal_overtime:
                candidates.append((route, engineer))
        if candidates:
            route, engineer = choose(request, candidates, previous)
            orders[engineer.engineer_id] = orders[engineer.engineer_id] + [request.request_id]
            previous[engineer.engineer_id] = route
        else:
            deferred.append(request)
    for request in deferred:
        feasible = []
        for engineer in engineers:
            order = orders[engineer.engineer_id] + [request.request_id]
            route = (
                fixed_order(snapshot, engineer, order, travel)
                if _baseline_eligible(snapshot, engineer, request)
                else None
            )
            if route is not None:
                feasible.append((route, engineer))
        if feasible:
            route, engineer = choose(request, feasible, previous)
            orders[engineer.engineer_id] = orders[engineer.engineer_id] + [request.request_id]
            previous[engineer.engineer_id] = route
    routes, conflicts = [], []
    for engineer in snapshot.engineers:
        route = fixed_order(snapshot, engineer, orders[engineer.engineer_id], travel)
        if route is None:
            conflicts.append(engineer.engineer_id)
        else:
            routes.append(route)
    return assemble_plan(snapshot, [] if conflicts else routes, conflicts)


def greedy_nearest(snapshot: RouterTaskSnapshot, travel: TravelProvider) -> Plan:
    """Greedy nearest-append baseline: arrival order, cheapest travel increment.

    The classic dispatcher heuristic "send whoever is closest". Shares FIFO's
    append-only eligibility; differs only in choosing the cheapest engineer
    instead of the first in input order.
    """
    return _greedy(
        snapshot,
        travel,
        order_key=lambda r: (int(r.manual_engineer_id is None), r.arrival_order),
        choose=lambda _request, candidates, previous: _incremental_travel(candidates, previous),
    )


def greedy_urgency(snapshot: RouterTaskSnapshot, travel: TravelProvider) -> Plan:
    """Urgency-first greedy baseline: emergencies first, then cheapest append.

    Adds priority awareness to the nearest heuristic; the ordering key is the
    same lexicographic seed the engine uses, so the comparison shows what the
    bounded optimizer adds beyond a priority-aware greedy dispatcher.
    """
    return _greedy(
        snapshot,
        travel,
        order_key=lambda r: (
            int(r.manual_engineer_id is None),
            r.priority_tier,
            r.ready_at,
            r.arrival_order,
        ),
        choose=lambda _request, candidates, previous: _incremental_travel(candidates, previous),
    )


def engineer_routes(plan: Plan) -> dict[str, list[str]]:
    """Extract the per-engineer visit order of an assigned plan for evaluators."""
    return {
        route.engineer_id: [
            stop.request_id for stop in route.stops if stop.kind == "job" and stop.request_id
        ]
        for route in plan.routes
        if route.metrics.assigned_count > 0
    }
