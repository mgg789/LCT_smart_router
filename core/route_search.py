"""Deterministic insertion and neighbourhood search with departure-time costs.

Every changed route is evaluated at its actual successive departure times. The
search never substitutes a planning-time matrix for time-window feasibility.
Operation limits bound effort independently of machine speed; no optimality claim.
"""

from dataclasses import dataclass

from core.contracts import EngineerRoute, Plan, RouterTaskSnapshot
from core.geo import quote_at
from core.policy import compile_policy
from core.schedule import (
    TERMINAL_WINDOW_LATENESS_TOLERANCE_SEC,
    TravelProvider,
    assemble_plan,
    eligible,
    fixed_order,
    job_completion_limit,
    release_at,
    terminal_eligible,
    terminal_release_at,
    validate_plan,
)


@dataclass(frozen=True)
class RouteState:
    """Exact route costs in seconds/metres, with original-window slack."""

    jobs: tuple[str, ...]
    travel: int = 0
    distance: int = 0
    busy: int = 0
    urgent: int = 0
    late: int = 0
    lateness: int = 0
    slack: int | None = None
    delay: int = 0
    lunch_missed: int = 0


class RouteEvaluator:
    """Cache exact fixed-order costs; materialize only accepted final routes.

    The fast path mirrors schedule_steps without allocating route/geometry models.
    Lunch routes use the canonical scheduler, including required-lunch failure.
    """

    def __init__(self, snapshot: RouterTaskSnapshot, travel: TravelProvider):
        self.snapshot = snapshot
        self.travel = travel
        self.requests = {r.request_id: r for r in snapshot.requests}
        self.engineers = sorted(snapshot.engineers, key=lambda e: e.engineer_id)
        self.allowed = {
            r.request_id: [
                i
                for i, e in enumerate(self.engineers)
                if eligible(snapshot, e, r) or terminal_eligible(snapshot, e, r)
            ]
            for r in snapshot.requests
        }
        self.releases = [release_at(snapshot, e) for e in self.engineers]
        self.terminal_releases = [terminal_release_at(snapshot, e) for e in self.engineers]
        self.ends = [min(e.shift_end_at, snapshot.horizon_end_at) for e in self.engineers]
        self.cache: dict[tuple[int, tuple[str, ...]], RouteState | None] = {}
        self.evaluations = 0
        self.tolerance = getattr(
            getattr(travel, "settings", None), "window_lateness_tolerance_sec", 0
        )

    def evaluate(self, index: int, jobs: tuple[str, ...]) -> RouteState | None:
        """Return exact costs or infeasibility, keyed by engineer and complete order."""
        key = (index, jobs)
        if key in self.cache:
            return self.cache[key]
        self.evaluations += 1
        state = self._evaluate(index, jobs)
        self.cache[key] = state
        return state

    def _evaluate(self, index: int, jobs: tuple[str, ...]) -> RouteState | None:
        engineer = self.engineers[index]
        release = self.releases[index]
        if release is None and len(jobs) == 1:
            release = self.terminal_releases[index]
        if release is None:
            return None if jobs else RouteState(jobs)
        if any(index not in self.allowed[job] for job in jobs):
            return None
        if engineer.lunch.enabled and not engineer.lunch_taken:
            route = fixed_order(self.snapshot, engineer, list(jobs), self.travel)
            return self.from_route(route) if route is not None else None
        clock, point = release, engineer.start_location
        travel = distance = urgent = late = lateness = delay = 0
        slack = None
        stock = engineer.equipment_stock.model_dump()
        for position, job in enumerate(jobs):
            request = self.requests[job]
            if request.required_equipment is not None:
                stock[request.required_equipment] -= 1
                if stock[request.required_equipment] < 0:
                    return None
            road = quote_at(self.travel, point, request.location, engineer.transport_type, clock)
            if road is None:
                return None
            start = max(clock + road.duration_sec, request.window_start_at)
            clock = start + request.service_duration_sec
            margin = request.window_end_at - clock
            window_tolerance = max(
                self.tolerance,
                TERMINAL_WINDOW_LATENESS_TOLERANCE_SEC if position == len(jobs) - 1 else 0,
            )
            if margin < -window_tolerance or clock > job_completion_limit(
                self.snapshot, engineer, terminal=position == len(jobs) - 1
            ):
                return None
            travel += road.duration_sec
            distance += road.distance_m
            urgent += request.priority == "urgent"
            late += margin < 0
            lateness += max(0, -margin)
            slack = margin if slack is None else min(slack, margin)
            delay += start - request.window_start_at
            point = request.location
        return RouteState(
            jobs, travel, distance, clock - release, urgent, late, lateness, slack, delay
        )

    def from_route(self, route: EngineerRoute) -> RouteState:
        """Convert canonical lunch/baseline routes to the same score representation."""
        stops = [s for s in route.stops if s.kind == "job"]
        slacks = [self.requests[s.request_id].window_end_at - s.end_at for s in stops]
        m = route.metrics
        engineer = next(e for e in self.engineers if e.engineer_id == route.engineer_id)
        missed = int(
            engineer.lunch.enabled
            and not engineer.lunch_taken
            and not engineer.lunch.required
            and route.lunch.status != "scheduled"
        )
        return RouteState(
            tuple(s.request_id for s in stops),
            m.travel_time_sec,
            round(m.distance_km * 1000),
            m.work_time_sec + m.travel_time_sec + m.waiting_time_sec + m.lunch_time_sec,
            sum(self.requests[s.request_id].priority == "urgent" for s in stops),
            sum(s < 0 for s in slacks),
            sum(max(0, -s) for s in slacks),
            min(slacks, default=None),
            sum(s.start_at - self.requests[s.request_id].window_start_at for s in stops),
            missed,
        )

    def score(self, states: list[RouteState], policy_id: str) -> tuple[int, ...]:
        """Match public policy_score; counts are negated up to constant totals."""
        slacks = [s.slack for s in states if s.slack is not None]
        loads = [s.busy for i, s in enumerate(states) if self.releases[i] is not None]
        utilization = [
            (s.busy * 10000 + max(1, self.ends[i] - self.releases[i]) - 1)
            // max(1, self.ends[i] - self.releases[i])
            for i, s in enumerate(states)
            if self.releases[i] is not None
        ]
        values = {
            "urgent_unassigned": -sum(s.urgent for s in states),
            "unassigned": -sum(len(s.jobs) for s in states),
            "missed_optional_lunches": sum(s.lunch_missed for s in states),
            "travel_time": sum(s.travel for s in states),
            "distance": sum(s.distance for s in states),
            "engineers_used": sum(bool(s.jobs) for s in states),
            "additional_engineers": sum(
                bool(state.jobs) and engineer.engineer_id.startswith("covering-")
                for engineer, state in zip(self.engineers, states)
            ),
            "window_start_delay": sum(s.delay for s in states),
            "max_jobs_per_engineer": max((len(s.jobs) for s in states), default=0),
            "total_lateness": sum(s.lateness for s in states),
            "window_end_risk": -min(slacks) if slacks else 0,
            "max_workload_ratio": max(utilization, default=0),
            "workload_spread": max(loads, default=0) - min(loads, default=0),
        }
        policy = self.snapshot.policy.model_copy(update={"policy_id": policy_id})
        return tuple(values[c] for c in compile_policy(policy).ordered_criteria)

    def materialize(self, states: list[RouteState]) -> Plan | None:
        """Build and independently validate routes using the canonical scheduler."""
        routes = [
            fixed_order(self.snapshot, e, list(s.jobs), self.travel)
            for e, s in zip(self.engineers, states)
        ]
        if any(route is None for route in routes):
            return None
        plan = assemble_plan(self.snapshot, routes)
        validate_plan(self.snapshot, plan, self.travel)
        return plan


def improve_routes(
    snapshot: RouterTaskSnapshot,
    travel: TravelProvider,
    seeds: list[Plan],
    effort: int = 3000,
    *,
    construct: bool = True,
) -> list[Plan]:
    """Return a reproducible portfolio; preserve every supplied feasible seed.

    `effort` is the configured nominal search budget in milliseconds. Deterministic
    route-evaluation quotas bound local search; wall-clock runtime is measured by
    the caller separately. Construction passes also defer terminal-only visits so
    an early relaxed deadline cannot consume the entire remaining route.
    """
    evaluator = RouteEvaluator(snapshot, travel)
    empty = [evaluator.evaluate(i, ()) for i in range(len(evaluator.engineers))]
    if any(state is None for state in empty):
        return seeds
    policy_id = snapshot.policy.policy_id
    portfolio: list[list[RouteState]] = []
    for plan in seeds:
        if plan.is_usable:
            by_id = {r.engineer_id: r for r in plan.routes}
            if all(e.engineer_id in by_id for e in evaluator.engineers):
                portfolio.append(
                    [evaluator.from_route(by_id[e.engineer_id]) for e in evaluator.engineers]
                )
    requests = sorted(snapshot.requests, key=lambda r: r.request_id)
    # All policies see the same constructive candidates, including both travel
    # units. Scarce qualifications are allocated before broadly compatible jobs.
    variants = (
        ("fast", lambda r: (r.priority != "urgent", r.window_end_at, r.service_duration_sec)),
        (
            "compact",
            lambda r: (
                r.priority != "urgent",
                len(evaluator.allowed[r.request_id]),
                r.window_end_at,
                r.service_duration_sec,
            ),
        ),
        (
            "eco",
            lambda r: (
                r.priority != "urgent",
                r.window_end_at - r.window_start_at,
                r.window_start_at,
            ),
        ),
        ("balanced", lambda r: (r.priority != "urgent", r.window_start_at, r.window_end_at)),
    )

    def insert(states, request, objective, excluded=-1, *, regular_only=False):
        best = None
        for i in evaluator.allowed[request.request_id]:
            if i == excluded:
                continue
            old = states[i]
            for pos in range(len(old.jobs) + 1):
                jobs = old.jobs[:pos] + (request.request_id,) + old.jobs[pos:]
                candidate = evaluator.evaluate(i, jobs)
                if (
                    regular_only
                    and candidate is not None
                    and candidate.slack is not None
                    and candidate.slack < -evaluator.tolerance
                ):
                    continue
                if candidate is not None:
                    states[i] = candidate
                    key = evaluator.score(states, objective)
                    if best is None or key < best[0]:
                        best = (key, i, candidate)
            states[i] = old
        if best is not None:
            states[best[1]] = best[2]
        return best is not None

    for objective, order in variants if construct else ():
        states = list(empty)
        for request in sorted(requests, key=order):
            insert(states, request, objective)
        portfolio.append(states)
        # Preserve the original candidate, but also construct the ordinary day
        # first. Terminal grace is an end-of-route recovery, not a reason to stop
        # searching at an early window while later jobs remain feasible.
        states = list(empty)
        for request in sorted(requests, key=order):
            insert(states, request, objective, regular_only=True)
        assigned = {job for state in states for job in state.jobs}
        for request in sorted(requests, key=order):
            if request.request_id not in assigned:
                insert(states, request, objective)
        portfolio.append(states)
    # Truly independent regions may select different construction orders. A weak
    # seed in one disconnected component must not discard a strong seed elsewhere.
    regions = {e.region for e in evaluator.engineers}
    if None not in regions and all(r.region in regions for r in requests):
        combined = list(empty)
        for region in sorted(regions):
            indices = [i for i, e in enumerate(evaluator.engineers) if e.region == region]
            choices = []
            for candidate in portfolio:
                partial = list(empty)
                for i in indices:
                    partial[i] = candidate[i]
                choices.append(partial)
            best = min(choices, key=lambda s: evaluator.score(s, policy_id))
            for i in indices:
                combined[i] = best[i]
        portfolio.append(combined)
    if not portfolio:
        return seeds
    states = list(min(portfolio, key=lambda s: evaluator.score(s, policy_id)))
    quota = evaluator.evaluations + max(1000, effort * 8)
    # Relocation permits consolidation, route reordering and workload balancing.
    # After each improving pass, try every previously uncovered job again.
    for _ in range(4):
        changed = False
        assigned = {job for state in states for job in state.jobs}
        for request in sorted(requests, key=variants[0][1]):
            if request.request_id not in assigned:
                changed |= insert(states, request, policy_id)
        current_score = evaluator.score(states, policy_id)
        for source in range(len(states)):
            for job in tuple(states[source].jobs):
                if evaluator.evaluations >= quota:
                    break
                original = list(states)
                reduced = evaluator.evaluate(
                    source, tuple(j for j in states[source].jobs if j != job)
                )
                if reduced is None:
                    continue
                states[source] = reduced
                # Refill with uncovered work before restoring the removed job.
                # Otherwise a terminal-only late visit is immediately reinserted
                # and can block every later window, even when replacing it would
                # increase coverage. Accept or roll back the whole neighbourhood.
                previously_assigned = {j for state in original for j in state.jobs}
                for request in sorted(requests, key=variants[0][1]):
                    if evaluator.evaluations >= quota:
                        break
                    if request.request_id not in previously_assigned:
                        insert(states, request, policy_id)
                insert(states, evaluator.requests[job], policy_id)
                candidate_score = evaluator.score(states, policy_id)
                if candidate_score < current_score:
                    current_score = candidate_score
                    changed = True
                else:
                    states = original
            if evaluator.evaluations >= quota:
                break
        if not changed or evaluator.evaluations >= quota:
            break
    portfolio.append(states)
    # Consolidating an entire route can require neutral/worse intermediate moves.
    # Evaluate it as one transaction so compact can actually release an engineer.
    for source in sorted(range(len(states)), key=lambda i: len(states[i].jobs)):
        if not states[source].jobs:
            continue
        candidate = list(states)
        jobs = candidate[source].jobs
        candidate[source] = empty[source]
        if all(
            insert(candidate, evaluator.requests[job], policy_id, excluded=source)
            for job in sorted(jobs, key=lambda j: evaluator.requests[j].window_end_at)
        ):
            if evaluator.score(candidate, policy_id) < evaluator.score(states, policy_id):
                states = candidate
                portfolio.append(states)
    # Deterministic destroy/reinsert escapes insertion-only local minima. Rebuild
    # a small neighbourhood, then accept the complete plan only if it improves.
    quota = evaluator.evaluations + max(1000, effort * 20)
    for round_index in range(8):
        if evaluator.evaluations >= quota:
            break
        candidate = list(states)
        for i, state in enumerate(candidate):
            take = [job for j, job in enumerate(state.jobs) if (j + i + round_index) % 3 == 0]
            reduced = evaluator.evaluate(i, tuple(job for job in state.jobs if job not in take))
            if reduced is not None:
                candidate[i] = reduced
        assigned = {job for state in candidate for job in state.jobs}
        objective, order = variants[round_index % len(variants)]
        for request in sorted(requests, key=order):
            if request.request_id not in assigned:
                insert(candidate, request, objective)
        if evaluator.score(candidate, policy_id) < evaluator.score(states, policy_id):
            states = candidate
            portfolio.append(states)
    plans = list(seeds)
    # Keep only distinct orders; scores are always recomputed from actual plans.
    seen = set()
    for states in portfolio:
        identity = tuple(s.jobs for s in states)
        if identity not in seen:
            seen.add(identity)
            plan = evaluator.materialize(states)
            if plan is not None:
                plans.append(plan)
    return plans
