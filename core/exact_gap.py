"""Exact optimum for micro instances via exhaustive append-order enumeration.

The search walks the full state space of per-engineer visit sequences: a state
is one ordered (possibly empty) request sequence per engineer, and every state
is itself a complete candidate plan because appending may stop at any point.
Since a route's visit order can always be produced by appending in visit order,
the space covers every schedule the scheduler can express — the enumeration is
exact, not arrival-order-limited.

Feasibility is append-monotone: once a sequence prefix cannot be scheduled, no
extension of that prefix can be either, so infeasible successors are pruned
soundly. Lunches must be disabled in the instance (the caller verifies this),
because required-lunch placement is the one rule that breaks monotonicity.

Identical states reached through different append interleavings are memoized,
and the node cap keeps runs deterministic: enumeration either completes (status
"optimal") or stops at the cap (status "capped", no optimality claim). The
lexicographic objective mirrors the compact policy: fewest unassigned, then
fewest engineers used, then least travel time.
"""

from __future__ import annotations

import time as monotonic_time
from dataclasses import dataclass
from typing import Literal

from core.contracts import Engineer, RouterTaskSnapshot
from core.schedule import TravelProvider, _baseline_eligible, fixed_order

Objective = tuple[int, int, int]


class NodeCapExceeded(Exception):
    """Raised to unwind the search when the deterministic node budget is spent."""


@dataclass(frozen=True)
class ExactResult:
    """Complete-enumeration outcome for one micro instance."""

    status: Literal["optimal", "capped"]
    unassigned_count: int
    engineers_used: int
    travel_time_sec: int
    routes: dict[str, list[str]]
    route_builds: int
    elapsed_sec: float

    @property
    def objective(self) -> Objective:
        """The lexicographic score this result achieved."""
        return (self.unassigned_count, self.engineers_used, self.travel_time_sec)


def requires_lunchless_engineers(snapshot: RouterTaskSnapshot) -> None:
    """Refuse instances whose engineers still carry an active lunch window.

    Args:
        snapshot: Micro snapshot about to be enumerated exactly.

    Raises:
        ValueError: If any engineer keeps an enabled lunch, which would break
            the append monotonicity the pruning relies on.
    """
    active = [
        engineer.engineer_id
        for engineer in snapshot.engineers
        if engineer.lunch.enabled and not engineer.lunch_taken
    ]
    if active:
        raise ValueError(f"exact enumeration requires disabled lunches; active: {sorted(active)}")


def exact_micro(
    snapshot: RouterTaskSnapshot,
    travel: TravelProvider,
    *,
    max_route_builds: int = 1_500_000,
) -> ExactResult:
    """Enumerate every feasible schedule and return the exact optimum.

    Args:
        snapshot: Micro snapshot (few requests, few engineers, lunches disabled).
        travel: The same travel provider the heuristic plans were built with.
        max_route_builds: Deterministic budget of distinct prefix schedules to
            build before giving up the optimality claim.

    Returns:
        The exact best objective when enumeration completed, or the best
        incumbent with status "capped" when the budget ran out.
    """
    requires_lunchless_engineers(snapshot)
    engineers = sorted(snapshot.engineers, key=lambda e: e.input_order)
    eligible = [
        engineer
        for engineer in engineers
        if any(_baseline_eligible(snapshot, engineer, request) for request in snapshot.requests)
    ]
    requests = sorted(snapshot.requests, key=lambda r: r.arrival_order)
    eligible_ids = [engineer.engineer_id for engineer in eligible]
    cache: dict[tuple[str, tuple[str, ...]], object] = {}
    builds = 0
    best: tuple[Objective, tuple[tuple[str, ...], ...]] | None = None
    visited: set[tuple[tuple[str, ...], ...]] = set()

    def route_for(engineer: Engineer, seq: tuple[str, ...]):
        key = (engineer.engineer_id, seq)
        if key in cache:
            return cache[key]
        nonlocal builds
        builds += 1
        if builds > max_route_builds:
            raise NodeCapExceeded
        value = fixed_order(snapshot, engineer, list(seq), travel)
        cache[key] = value
        return value

    def score_state(state: tuple[tuple[str, ...], ...]) -> tuple[Objective, bool]:
        """Score one state; the second flag marks an internally consistent state."""
        assigned = sum(len(seq) for seq in state)
        travel_total = 0
        used = 0
        for engineer, seq in zip(eligible, state, strict=True):
            if not seq:
                continue
            route = route_for(engineer, seq)
            if route is None:
                return (len(requests), 0, 0), False
            travel_total += route.metrics.travel_time_sec
            used += 1
        return ((len(requests) - assigned, used, travel_total), True)

    started = monotonic_time.perf_counter()
    status: Literal["optimal", "capped"] = "optimal"
    try:

        def recurse(state: tuple[tuple[str, ...], ...]) -> None:
            nonlocal best
            if state in visited:
                return
            visited.add(state)
            (objective, consistent) = score_state(state)
            if not consistent:
                return
            if best is None or objective < best[0]:
                best = (objective, state)
            assigned_ids = {rid for seq in state for rid in seq}
            for index, engineer in enumerate(eligible):
                prefix = state[index]
                for request in requests:
                    if request.request_id in assigned_ids:
                        continue
                    if not _baseline_eligible(snapshot, engineer, request):
                        continue
                    successor = list(state)
                    successor[index] = prefix + (request.request_id,)
                    if route_for(engineer, successor[index]) is None:
                        continue
                    recurse(tuple(successor))

        recurse(tuple(() for _ in eligible))
    except NodeCapExceeded:
        status = "capped"
    elapsed = monotonic_time.perf_counter() - started
    if best is None:
        return ExactResult(
            status=status,
            unassigned_count=len(requests),
            engineers_used=0,
            travel_time_sec=0,
            routes={},
            route_builds=builds,
            elapsed_sec=elapsed,
        )
    score, final_state = best
    return ExactResult(
        status=status,
        unassigned_count=score[0],
        engineers_used=score[1],
        travel_time_sec=score[2],
        routes={
            engineer_id: list(seq)
            for engineer_id, seq in zip(eligible_ids, final_state, strict=True)
            if seq
        },
        route_builds=builds,
        elapsed_sec=elapsed,
    )
