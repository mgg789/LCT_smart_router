"""OR-Tools Routing Engine with lunch alternatives and bounded hierarchical search.

Search stages preserve achieved senior criteria. No result claims proven global
optimality. Engine owns all route choices; Runtime only validates and publishes.
"""

import time
from dataclasses import dataclass, replace

from core.contracts import (
    Plan,
    Policy,
    RouterTaskSnapshot,
    RouterTechnicalSettings,
    TravelTimeMode,
)
from core.engine_covering import (
    _canonical_plan,
    _cover_leftovers,
    _improve_covering,
    _project,
)
from core.engine_covering import (
    _covering_clone as _covering_clone,
)
from core.engine_covering import (
    _covering_extra_engineers as _covering_extra_engineers,
)
from core.engine_covering import (
    _union_memory_engineers as _union_memory_engineers,
)
from core.engine_covering import (
    official_roster as official_roster,
)
from core.engine_equipment import _rescue_equipment_handoffs, _rescue_office_pickups
from core.engine_search import _search
from core.geo import configure_travel, routing_context_version
from core.policy import Criterion, PolicySpec, compile_policy
from core.route_search import improve_routes
from core.schedule import (
    TravelProvider,
    baseline,
    lunch_coverage_alerts,
    score,
    validate_plan,
)


@dataclass(frozen=True)
class SearchSettings:
    """Technical budget, independent of business policy; one seed/thread by design."""

    time_limit_ms: int = 3000
    solution_limit: int = 10000
    lunches_enabled: bool = False
    traffic_enabled: bool = True
    equipment_enabled: bool = True
    equipment_transfers_enabled: bool = False
    metro_enabled: bool = False
    # Strict windows are the default; explicit legacy settings may still opt into
    # bounded completion grace for scenarios that require it.
    strict_time_windows: bool = True
    window_lateness_tolerance_sec: int = 600
    departure_lateness_tolerance_sec: int = 0
    task_start_lateness_tolerance_sec: int = 0
    travel_time_mode: TravelTimeMode = "graph_with_access_buffer"
    access_buffer_sec: int = 600
    fixed_travel_time_sec: int = 1200
    early_finish_replan_threshold_sec: int = 900
    task_overrun_tolerance_sec: int = 600
    tolerance_sec: int | None = None

    def __post_init__(self):
        if self.tolerance_sec is not None:
            if self.tolerance_sec < 0 or self.departure_lateness_tolerance_sec:
                raise ValueError("invalid or conflicting legacy tolerance")
            if self.strict_time_windows and self.tolerance_sec > 0:
                raise ValueError("legacy tolerance requires strict_time_windows=False")
            object.__setattr__(self, "departure_lateness_tolerance_sec", self.tolerance_sec)
            object.__setattr__(self, "task_start_lateness_tolerance_sec", self.tolerance_sec)
        if (
            not 0 <= self.window_lateness_tolerance_sec <= 1200
            or self.time_limit_ms < 1
            or self.solution_limit < 1
            or self.departure_lateness_tolerance_sec < 0
            or self.task_start_lateness_tolerance_sec < 0
            or self.travel_time_mode not in ("graph_with_access_buffer", "fixed_normative")
            or self.access_buffer_sec < 0
            or self.fixed_travel_time_sec < 1
            or self.early_finish_replan_threshold_sec < 0
            or self.task_overrun_tolerance_sec < 0
            or self.access_buffer_sec > 86400
            or self.fixed_travel_time_sec > 86400
            or self.early_finish_replan_threshold_sec > 86400
            or self.task_overrun_tolerance_sec > 86400
        ):
            raise ValueError("invalid search settings")

    def technical(self) -> RouterTechnicalSettings:
        """Expose only persisted context controls, excluding per-run search budgets."""
        return RouterTechnicalSettings(
            strict_time_windows=self.strict_time_windows,
            lunches_enabled=self.lunches_enabled,
            traffic_enabled=self.traffic_enabled,
            equipment_enabled=self.equipment_enabled,
            equipment_transfers_enabled=self.equipment_transfers_enabled,
            metro_enabled=self.metro_enabled,
            window_lateness_tolerance_sec=self.window_lateness_tolerance_sec,
            departure_lateness_tolerance_sec=self.departure_lateness_tolerance_sec,
            task_start_lateness_tolerance_sec=self.task_start_lateness_tolerance_sec,
            travel_time_mode=self.travel_time_mode,
            access_buffer_sec=self.access_buffer_sec,
            fixed_travel_time_sec=self.fixed_travel_time_sec,
            early_finish_replan_threshold_sec=self.early_finish_replan_threshold_sec,
            task_overrun_tolerance_sec=self.task_overrun_tolerance_sec,
        )


@dataclass(frozen=True)
class EngineMemory:
    """Stable reference for timing drift; revalidation never moves this anchor."""

    snapshot: RouterTaskSnapshot
    plan: Plan
    context_version: str


@dataclass(frozen=True)
class EngineOutput:
    """Both plans plus the selected replanning path and next stable reference."""

    main: Plan
    baseline: Plan
    path: str
    memory: EngineMemory


def _small_change(old: RouterTaskSnapshot, new: RouterTaskSnapshot, tolerance: int) -> bool:
    if old.policy != new.policy or {r.request_id: r for r in old.requests} != {
        r.request_id: r for r in new.requests
    }:
        return False
    if (old.horizon_start_at, old.horizon_end_at) != (new.horizon_start_at, new.horizon_end_at):
        return False
    if abs(old.planning_as_of - new.planning_as_of) > tolerance:
        return False
    if len(old.engineers) != len(new.engineers):
        return False
    previous_engineers = {e.engineer_id: e for e in old.engineers}
    if set(previous_engineers) != {e.engineer_id for e in new.engineers}:
        return False
    for b in new.engineers:
        a = previous_engineers[b.engineer_id]
        ignore = {"available_from"}
        if a.model_dump(exclude=ignore) != b.model_dump(exclude=ignore):
            return False
        if a.available_from is None or b.available_from is None:
            if a.available_from != b.available_from:
                return False
        elif abs(a.available_from - b.available_from) > tolerance:
            return False
    return True


def _task_starts_within_tolerance(previous: Plan, projected: Plan, tolerance: int) -> bool:
    """Accept revalidation only while every retained job's later start stays bounded."""
    old_starts = {
        stop.request_id: stop.start_at
        for route in previous.routes
        for stop in route.stops
        if stop.kind == "job" and stop.request_id is not None
    }
    new_starts = {
        stop.request_id: stop.start_at
        for route in projected.routes
        for stop in route.stops
        if stop.kind == "job" and stop.request_id is not None
    }
    return all(
        request_id in old_starts and start_at - old_starts[request_id] <= tolerance
        for request_id, start_at in new_starts.items()
    )


def apply_system_policy(
    snapshot: RouterTaskSnapshot, settings: SearchSettings
) -> RouterTaskSnapshot:
    """Apply Router-owned hard switches without mutating the sys publication."""
    if not settings.equipment_enabled:
        snapshot = snapshot.model_copy(
            update={
                "requests": [
                    request.model_copy(update={"required_equipment": None})
                    for request in snapshot.requests
                ]
            }
        )
    if settings.lunches_enabled:
        return snapshot
    engineers = []
    for engineer in snapshot.engineers:
        if engineer.manual_lunch:
            engineers.append(engineer)
            continue
        lunch = engineer.lunch.model_copy(
            update={
                "enabled": False,
                "duration_sec": None,
                "window_start_at": None,
                "window_end_at": None,
                "required": False,
            }
        )
        engineers.append(engineer.model_copy(update={"lunch": lunch}))
    return snapshot.model_copy(update={"engineers": engineers}, deep=True)


def _without_optional_lunches(snapshot: RouterTaskSnapshot) -> RouterTaskSnapshot:
    """Remove optional lunch nodes for the bounded job-coverage search only."""
    engineers = []
    changed = False
    for engineer in snapshot.engineers:
        lunch = engineer.lunch
        if lunch.enabled and not lunch.required and not engineer.lunch_taken:
            changed = True
            lunch = lunch.model_copy(
                update={
                    "enabled": False,
                    "duration_sec": None,
                    "window_start_at": None,
                    "window_end_at": None,
                }
            )
        engineers.append(engineer.model_copy(update={"lunch": lunch}))
    return snapshot.model_copy(update={"engineers": engineers}, deep=True) if changed else snapshot


def _solve_covering(
    snapshot: RouterTaskSnapshot,
    travel: TravelProvider,
    settings: SearchSettings,
    memory: EngineMemory | None,
    context_version: str | None,
) -> EngineOutput:
    """Optimize the original roster, then cover remaining demand heuristically.

    A prior usable plan is projected when possible, while only persisted
    ``covering-*`` crews are reused.  The FIFO baseline always stays on the
    original roster, and the final route list follows that roster before any
    retained extras.
    """
    original = official_roster(snapshot)
    if memory is not None and memory.context_version != context_version:
        memory = None
    aligned = _union_memory_engineers(original, memory)
    first_baseline = baseline(original, travel)
    validate_plan(original, first_baseline, travel)
    path = "COVERING_COLD"
    first_main: Plan | None = None
    if memory is not None and memory.plan.is_usable:
        try:
            projected = _project(aligned, memory.plan, travel)
        except ValueError:
            projected = None
        if projected is not None and projected.is_usable:
            first_main = projected
            path = "COVERING_FROM_MEMORY"
    if first_main is None:
        compact = original.model_copy(update={"policy": Policy(policy_id="compact", parameters={})})
        first = _solve_prepared(compact, travel, settings, None, context_version)
        first_main = first.main
        path = first.path
        aligned = original

    # A memory plan may contain only the original roster while aligned has
    # reusable extras.  Projecting into the aligned snapshot gives improve_routes
    # a complete seed without changing any already known route order.
    aligned_seed = _project(aligned, first_main, travel)
    first_main = _improve_covering(aligned, aligned_seed, travel, settings.time_limit_ms)
    leftover_ids = {
        item.request_id for item in first_main.assignments if item.status == "unassigned"
    }
    if not leftover_ids:
        used = {
            route.engineer_id for route in first_main.routes if route.metrics.assigned_count > 0
        }
        kept = [
            engineer
            for engineer in aligned.engineers
            if not engineer.engineer_id.startswith("covering-") or engineer.engineer_id in used
        ]
        covered = aligned.model_copy(update={"engineers": kept, "policy": snapshot.policy})
        main = _canonical_plan(covered, first_main.routes, travel)
        return EngineOutput(
            main,
            first_baseline,
            path,
            EngineMemory(covered, main, context_version or ""),
        )
    covered_engineers, merged_routes = _cover_leftovers(
        aligned, first_main, travel, settings.time_limit_ms
    )
    covered = aligned.model_copy(update={"engineers": covered_engineers, "policy": snapshot.policy})
    main = _canonical_plan(covered, merged_routes, travel)
    return EngineOutput(
        main,
        first_baseline,
        path,
        EngineMemory(covered, main, context_version or ""),
    )


def solve(
    snapshot: RouterTaskSnapshot,
    travel: TravelProvider,
    settings: SearchSettings | None = None,
    memory: EngineMemory | None = None,
    context_version: str | None = None,
) -> EngineOutput:
    """Compute baseline and bounded main, preserving feasible small-change ordering.

    Policy stages preserve achieved coverage/lunch criteria before their resource order.
    Fast keeps engineer count as a final candidate tie-break; compact optimizes it first.
    Covering first adds the fewest extra engineers that assign every remaining request.
    """
    settings = settings or SearchSettings()
    if snapshot.manual_decisions:
        from core.manual_planning import solve_manual
        return solve_manual(snapshot, travel, settings, context_version)
    if snapshot.policy.policy_id == "covering":
        default_context_version = routing_context_version(travel, settings.technical())
        travel = configure_travel(travel, settings.technical(), snapshot.planning_as_of)
        snapshot = apply_system_policy(snapshot, settings)
        return _solve_covering(
            snapshot, travel, settings, memory, context_version or default_context_version
        )
    return _solve_prepared(official_roster(snapshot), travel, settings, memory, context_version)


def _solve_prepared(
    snapshot: RouterTaskSnapshot,
    travel: TravelProvider,
    settings: SearchSettings | None = None,
    memory: EngineMemory | None = None,
    context_version: str | None = None,
) -> EngineOutput:
    """Run the existing baseline + staged search on an already expanded snapshot."""
    settings = settings or SearchSettings()
    default_context_version = routing_context_version(travel, settings.technical())
    if settings.strict_time_windows:
        settings = replace(settings, window_lateness_tolerance_sec=0,
                           departure_lateness_tolerance_sec=0,
                           task_start_lateness_tolerance_sec=0, task_overrun_tolerance_sec=0,
                           tolerance_sec=None)
    travel = configure_travel(travel, settings.technical(), snapshot.planning_as_of)
    snapshot = apply_system_policy(snapshot, settings)
    search_snapshot = _without_optional_lunches(snapshot)
    policy: PolicySpec = compile_policy(search_snapshot.policy)
    context_version = context_version or default_context_version
    base = _rescue_office_pickups(snapshot, _rescue_equipment_handoffs(snapshot, baseline(snapshot, travel), travel, settings), travel, settings)
    validate_plan(snapshot, base, travel)
    priority_seed = baseline(snapshot, travel, prioritized=True)
    compatible = (
        memory is not None
        and memory.context_version == context_version
        and memory.snapshot.policy == snapshot.policy
    )
    projected = None
    if compatible and memory is not None and memory.plan.is_usable:
        candidate = _project(snapshot, memory.plan, travel)
        if candidate is not None:
            projected = candidate
            same_assignments = {
                a.request_id: a.engineer_id for a in candidate.assignments
            } == {a.request_id: a.engineer_id for a in memory.plan.assignments}
            if (
                same_assignments
                and (not priority_seed.is_usable or score(snapshot, candidate) <= score(snapshot, priority_seed))
                and _small_change(memory.snapshot, snapshot, settings.departure_lateness_tolerance_sec)
                and _task_starts_within_tolerance(
                    memory.plan, candidate, settings.task_start_lateness_tolerance_sec
                )
            ):
                projected = candidate.model_copy(
                    update={
                        "alerts": candidate.alerts
                        + lunch_coverage_alerts(snapshot, candidate, travel)
                    }
                )
                return EngineOutput(projected, base, "REVALIDATE", memory)
    path = "REPAIR_AND_IMPROVE" if projected else "COLD_START"
    search_base = base if search_snapshot is snapshot else baseline(search_snapshot, travel)
    validate_plan(search_snapshot, search_base, travel)
    search_projected = (
        _project(search_snapshot, memory.plan, travel)
        if compatible and memory is not None and memory.plan.is_usable
        else None
    )
    search_priority = priority_seed if search_snapshot is snapshot else baseline(search_snapshot, travel, prioritized=True)
    candidates = [
        plan for plan in (search_base, search_projected, search_priority) if plan is not None and plan.is_usable
    ]
    incumbent = (
        min(candidates, key=lambda plan: score(search_snapshot, plan)) if candidates else None
    )
    deadline = time.monotonic() + settings.time_limit_ms / 1000
    # Static OR-Tools remains a seed generator only when forecast traffic is disabled.
    # Departure-dependent routes are optimized by exact whole-route evaluation.
    stages: tuple[str, ...] = (
        tuple(stage for stage in policy.search_stages) if not settings.traffic_enabled else ()
    )
    stages = tuple(
        stage
        for stage in stages
        if stage
        not in ("total_lateness", "window_end_risk", "max_workload_ratio", "workload_spread")
    )
    if stages and any(r.dispatcher_priority for r in search_snapshot.requests):
        stages = (stages[0], "dispatcher_response_delay", *stages[1:])
    if stages and any(r.category == "emergency" for r in search_snapshot.requests):
        stages = (stages[0], "emergency_response_delay", *stages[1:])
    for i, stage in enumerate(stages):
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            break
        preserved_criteria: tuple[Criterion, ...] = tuple(
            stage
            for stage in stages[1:i]
            if stage
            in (
                "emergency_response_delay",
                "dispatcher_response_delay",
                "additional_engineers",
                "extra_assignments",
                "travel_time",
                "distance",
                "engineers_used",
                "window_start_delay",
                "max_jobs_per_engineer",
            )
        )
        candidate = _search(
            search_snapshot,
            travel,
            settings,
            stage,
            incumbent,
            remaining // (len(stages) - i),
            preserved_criteria,
        )
        if candidate is not None and (
            incumbent is None
            or score(search_snapshot, candidate) < score(search_snapshot, incumbent)
        ):
            incumbent = candidate
    candidates = improve_routes(
        search_snapshot,
        travel,
        [plan for plan in (search_base, incumbent) if plan is not None and plan.is_usable],
        settings.time_limit_ms,
    )
    search_main = (
        min(candidates, key=lambda plan: score(search_snapshot, plan))
        if candidates
        else search_base
    )
    if search_snapshot is snapshot:
        main = search_main
    else:
        main = _project(snapshot, search_main, travel)
        if main is None:
            raise ValueError("OPTIONAL_LUNCH_ENRICHMENT_FAILED")
    main = _rescue_office_pickups(snapshot, _rescue_equipment_handoffs(snapshot, main, travel, settings), travel, settings)
    validate_plan(snapshot, main, travel)
    main = main.model_copy(
        update={"alerts": main.alerts + lunch_coverage_alerts(snapshot, main, travel)}
    )
    return EngineOutput(
        main, base, path, EngineMemory(snapshot.model_copy(deep=True), main, context_version)
    )
