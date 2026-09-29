"""Demand-matched covering crews and canonical route improvement."""

from __future__ import annotations

from typing import TYPE_CHECKING

from core.contracts import Engineer, EngineerRoute, Plan, Policy, Request, RouterTaskSnapshot
from core.policy import compile_policy
from core.route_search import improve_routes
from core.schedule import (
    TravelProvider,
    assemble_plan,
    baseline,
    eligible,
    fixed_order,
    release_at,
    score,
    transport_matches,
    validate_plan,
)

if TYPE_CHECKING:
    from core.engine import EngineMemory


def _project(snapshot: RouterTaskSnapshot, previous: Plan, travel: TravelProvider) -> Plan | None:
    routes = []
    orders = {
        r.engineer_id: [s.request_id for s in r.stops if s.kind == "job"] for r in previous.routes
    }
    current = {r.request_id: r for r in snapshot.requests}
    for engineer in snapshot.engineers:
        jobs = [
            j
            for j in orders.get(engineer.engineer_id, [])
            if j in current and eligible(snapshot, engineer, current[j])
        ]
        route = fixed_order(snapshot, engineer, jobs, travel)
        if route is None:
            return None
        routes.append(route)
    plan = assemble_plan(snapshot, routes)
    validate_plan(snapshot, plan, travel)
    return plan


def official_roster(snapshot: RouterTaskSnapshot) -> RouterTaskSnapshot:
    """Exclude synthesized covering crews from fixed-roster strategy comparisons."""
    engineers = [e for e in snapshot.engineers if not e.engineer_id.startswith("covering-")]
    return (
        snapshot.model_copy(update={"engineers": engineers})
        if len(engineers) != len(snapshot.engineers)
        else snapshot
    )


_COVERING_SKILLS: tuple[str, ...] = ("local", "connection", "emergency")


def _covering_clone(template: Engineer, index: int) -> Engineer:
    """Clone a compatible roster template as an online covering engineer.

    The template's transport, equipment, location and shift are retained.  A
    covering crew therefore cannot silently cross a region, change transport,
    or work outside the source roster's shift just because it is synthetic.
    """
    region = template.region or "any"
    return template.model_copy(
        update={
            "engineer_id": f"covering-{region}-{index}",
            "input_order": 10_000 + index,
            "skills": list(_COVERING_SKILLS),
            "availability": "online",
            "expected_online_at": None,
            "lunch_taken": False,
        }
    )


def _next_covering_index(engineers: list[Engineer]) -> int:
    """Continue covering-N ids after any extras already present on the snapshot."""
    highest = 0
    for engineer in engineers:
        prefix, _sep, tail = engineer.engineer_id.rpartition("-")
        if prefix.startswith("covering-") and tail.isdigit():
            highest = max(highest, int(tail))
    return highest + 1


def _covering_template_can_serve(
    snapshot: RouterTaskSnapshot, engineer: Engineer, request: Request
) -> bool:
    """Check static demand compatibility before cloning a covering template."""
    if request.region is not None and engineer.region not in (None, request.region):
        return False
    if not (
        transport_matches(request.required_transport, engineer)
    ):
        return False
    if (
        request.required_equipment is not None
        and engineer.equipment_stock.quantity(request.required_equipment) < 1
    ):
        return False
    release = release_at(snapshot, engineer)
    if release is None:
        return False
    finish = min(engineer.shift_end_at, snapshot.horizon_end_at)
    return max(release, request.ready_at) + request.service_duration_sec <= finish


def _covering_extra_engineers(
    snapshot: RouterTaskSnapshot,
    requests: list[Request],
    travel: TravelProvider | None = None,
) -> list[Engineer]:
    """Create deterministic extras matched to demand and hard constraints."""
    demands = list(requests)
    templates = [
        engineer
        for engineer in snapshot.engineers
        if not engineer.engineer_id.startswith("covering-")
    ]
    if not demands or not templates:
        return []
    templates.sort(key=lambda engineer: (engineer.input_order, engineer.engineer_id))
    start = _next_covering_index(snapshot.engineers)
    extras: list[Engineer] = []
    for offset, request in enumerate(demands):
        candidates: list[tuple[Engineer, EngineerRoute | None]] = []
        for template in templates:
            if not _covering_template_can_serve(snapshot, template, request):
                continue
            clone = _covering_clone(template, start + offset)
            route = (
                fixed_order(snapshot, clone, [request.request_id], travel)
                if travel is not None
                else None
            )
            if travel is None:
                # The static checks above remain the safe fallback for direct
                # helper callers that do not have a travel provider.
                candidates.append((clone, None))
            elif route is not None:
                candidates.append((clone, route))
        if not candidates:
            continue
        # Prefer actual route cost when available, then stable roster order.
        extras.append(
            min(
                candidates,
                key=lambda item: (
                    item[1].metrics.travel_time_sec if item[1] is not None else 0,
                    round(item[1].metrics.distance_km * 1000) if item[1] is not None else 0,
                    item[0].input_order,
                    item[0].engineer_id,
                ),
            )[0]
        )
    return extras


def _union_memory_engineers(
    snapshot: RouterTaskSnapshot, memory: EngineMemory | None
) -> RouterTaskSnapshot:
    """Reuse only assigned covering extras; never resurrect removed originals."""
    snapshot = official_roster(snapshot)
    if memory is None or not memory.plan.is_usable:
        return snapshot
    # Synthetic capacity comes from roster templates. Recreate it when shifts,
    # equipment or availability change instead of retaining stale capacity.
    if official_roster(memory.snapshot).engineers != snapshot.engineers:
        return snapshot
    known = {engineer.engineer_id for engineer in snapshot.engineers}
    used = {
        route.engineer_id
        for route in memory.plan.routes
        if route.engineer_id.startswith("covering-") and route.metrics.assigned_count > 0
    }
    extras = [
        engineer
        for engineer in memory.snapshot.engineers
        if engineer.engineer_id not in known
        and engineer.engineer_id in used
        and engineer.engineer_id.startswith("covering-")
        and any(
            _covering_template_can_serve(snapshot, engineer, request)
            for request in snapshot.requests
        )
    ]
    if not extras:
        return snapshot
    return snapshot.model_copy(update={"engineers": [*snapshot.engineers, *extras]})


def _canonical_plan(
    snapshot: RouterTaskSnapshot,
    routes: list[EngineerRoute],
    travel: TravelProvider,
) -> Plan:
    """Materialize one route per input engineer in canonical roster order."""
    by_id = {route.engineer_id: route for route in routes}
    ordered: list[EngineerRoute] = []
    for engineer in snapshot.engineers:
        route = by_id.get(engineer.engineer_id)
        if route is None:
            route = fixed_order(snapshot, engineer, [], travel)
        if route is None:
            raise ValueError(f"RESULT_INVALID: no canonical route for {engineer.engineer_id}")
        ordered.append(route)
    plan = assemble_plan(snapshot, ordered)
    validate_plan(snapshot, plan, travel)
    return plan


def _covering_search_snapshot(snapshot: RouterTaskSnapshot) -> RouterTaskSnapshot:
    """Use covering's extra-aware resource ordering for heuristic search."""
    return snapshot.model_copy(update={"policy": Policy(policy_id="covering", parameters={})})


def _improve_covering(
    snapshot: RouterTaskSnapshot,
    seed: Plan | None,
    travel: TravelProvider,
    effort: int = 3000,
    construct: bool = True,
) -> Plan:
    """Improve all routes together, retaining exact canonical validation."""
    search_snapshot = _covering_search_snapshot(snapshot)
    projected = _project(search_snapshot, seed, travel) if seed is not None else None
    if projected is None or not projected.is_usable:
        projected = baseline(search_snapshot, travel)
    if not projected.is_usable:
        return projected
    priority_seed = baseline(search_snapshot, travel, prioritized=True)
    seeds = [plan for plan in (projected, priority_seed) if plan.is_usable]
    candidates = improve_routes(search_snapshot, travel, seeds, effort, construct=construct)
    usable = [candidate for candidate in candidates if candidate.is_usable]
    chosen = (
        min(usable, key=lambda candidate: score(search_snapshot, candidate))
        if usable
        else projected
    )
    return _canonical_plan(search_snapshot, chosen.routes, travel)


def _cover_leftovers(
    snapshot: RouterTaskSnapshot,
    first: Plan,
    travel: TravelProvider,
    effort: int = 3000,
) -> tuple[list[Engineer], list[EngineerRoute]]:
    """Cover leftovers with demand-matched extras and a bounded global improve.

    The heuristic first optimizes the complete original roster, then adds one
    feasible template per remaining demand.  It subsequently tries removing
    each used extra and re-optimizing, so an extra is retained only when the
    current plan still needs it.  This is deterministic and explicitly makes
    no global optimality claim.
    """
    leftover_ids = {item.request_id for item in first.assignments if item.status == "unassigned"}
    leftover_requests = [
        request for request in snapshot.requests if request.request_id in leftover_ids
    ]
    if not leftover_requests:
        canonical = _canonical_plan(snapshot, first.routes, travel)
        return snapshot.engineers, canonical.routes

    original = official_roster(snapshot)
    existing_extras = [
        engineer for engineer in snapshot.engineers if engineer.engineer_id.startswith("covering-")
    ]
    extras = _covering_extra_engineers(snapshot, leftover_requests, travel)
    expanded = original.model_copy(
        update={"engineers": [*original.engineers, *existing_extras, *extras]}
    )
    seed = _project(expanded, first, travel)
    improved = _improve_covering(expanded, seed, travel, effort)

    # Remove unused extras before trying the more expensive greedy reduction.
    used = {
        route.engineer_id
        for route in improved.routes
        if route.engineer_id.startswith("covering-") and route.metrics.assigned_count > 0
    }
    current_snapshot = expanded.model_copy(
        update={
            "engineers": [
                engineer
                for engineer in expanded.engineers
                if not engineer.engineer_id.startswith("covering-") or engineer.engineer_id in used
            ]
        }
    )
    current = (
        _canonical_plan(current_snapshot, improved.routes, travel)
        if improved.is_usable
        else improved
    )
    for extra_id in sorted(used):
        if extra_id not in {e.engineer_id for e in current_snapshot.engineers}:
            continue
        trial_snapshot = current_snapshot.model_copy(
            update={
                "engineers": [
                    engineer
                    for engineer in current_snapshot.engineers
                    if engineer.engineer_id != extra_id
                ]
            }
        )
        try:
            trial_seed = _project(trial_snapshot, current, travel)
            trial = _improve_covering(
                trial_snapshot,
                trial_seed,
                travel,
                max(100, min(effort, 300)),
                construct=False,
            )
        except ValueError:
            continue
        current_score = (
            score(_covering_search_snapshot(current_snapshot), current)
            if current.is_usable
            else None
        )
        trial_score = score(_covering_search_snapshot(trial_snapshot), trial)
        extra_index = compile_policy(_covering_search_snapshot(current_snapshot).policy).ordered_criteria.index("additional_engineers")
        # Preserve the senior coverage/lateness criteria exactly while reducing
        # the number of used extras.  Remaining impossible jobs therefore do
        # not block a safe reduction attempt.
        if (
            current_score is not None
            and trial_score[:extra_index] == current_score[:extra_index]
            and trial_score[extra_index] <= current_score[extra_index]
        ):
            current_snapshot, current = trial_snapshot, trial
    final_used = {r.engineer_id for r in current.routes if r.metrics.assigned_count > 0}
    current_snapshot = current_snapshot.model_copy(
        update={
            "engineers": [
                e
                for e in current_snapshot.engineers
                if not e.engineer_id.startswith("covering-") or e.engineer_id in final_used
            ]
        }
    )
    final = (
        _canonical_plan(current_snapshot, current.routes, travel) if current.is_usable else current
    )
    validate_plan(current_snapshot, final, travel)
    return current_snapshot.engineers, final.routes
