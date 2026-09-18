"""OR-Tools Routing Engine with lunch alternatives and bounded hierarchical search.

Search stages preserve achieved senior criteria. No result claims proven global
optimality. Engine owns all route choices; Runtime only validates and publishes.
"""

import time
from dataclasses import dataclass

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from core.contracts import (
    Engineer,
    EngineerRoute,
    EquipmentType,
    GeoPoint,
    Plan,
    Policy,
    Request,
    RouterTaskSnapshot,
    RouterTechnicalSettings,
    TravelTimeMode,
)
from core.geo import configure_travel, routing_context_version
from core.policy import Criterion, PolicySpec, compile_policy, criterion_values
from core.route_search import improve_routes
from core.schedule import (
    TravelProvider,
    assemble_plan,
    baseline,
    eligible,
    fixed_order,
    release_at,
    schedule_steps,
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
    window_lateness_tolerance_sec: int = 0
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
            lunches_enabled=self.lunches_enabled,
            traffic_enabled=self.traffic_enabled,
            equipment_enabled=self.equipment_enabled,
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


@dataclass(frozen=True)
class _Node:
    kind: str
    point: GeoPoint
    service: int = 0
    job: str | None = None
    owner: int | None = None
    anchor: int | None = None


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


def _search(
    snapshot: RouterTaskSnapshot,
    travel: TravelProvider,
    settings: SearchSettings,
    stage: str,
    incumbent: Plan | None,
    budget_ms: int,
    preserved_criteria: tuple[Criterion, ...] = (),
) -> Plan | None:
    engineers = sorted(snapshot.engineers, key=lambda e: e.engineer_id)
    if not engineers:
        return assemble_plan(snapshot, [])
    origin = snapshot.horizon_start_at
    horizon = snapshot.horizon_end_at - origin
    if horizon > 31 * 86400:
        raise ValueError("HORIZON_RANGE: v1 supports at most 31 days per snapshot")
    nodes: list[_Node] = []
    jobs: dict[str, int] = {}
    for request in sorted(snapshot.requests, key=lambda r: r.request_id):
        jobs[request.request_id] = len(nodes)
        nodes.append(
            _Node("job", request.location, request.service_duration_sec, request.request_id)
        )
    starts, ends = [], []
    for e, engineer in enumerate(engineers):
        starts.append(len(nodes))
        nodes.append(_Node("start", engineer.start_location, owner=e))
        ends.append(len(nodes))
        nodes.append(_Node("end", engineer.start_location, owner=e))
    lunches: dict[int, list[int]] = {}
    request_by_id = {r.request_id: r for r in snapshot.requests}
    for e, engineer in enumerate(engineers):
        if not engineer.lunch.enabled or engineer.lunch_taken:
            continue
        anchors = [starts[e]] + [
            index for key, index in jobs.items() if eligible(snapshot, engineer, request_by_id[key])
        ]
        lunches[e] = []
        for anchor in anchors:
            lunches[e].append(len(nodes))
            nodes.append(
                _Node(
                    "lunch",
                    nodes[anchor].point,
                    engineer.lunch.duration_sec,
                    owner=e,
                    anchor=anchor,
                )
            )
    manager = pywrapcp.RoutingIndexManager(len(nodes), len(engineers), starts, ends)
    routing = pywrapcp.RoutingModel(manager)
    solver = routing.solver()
    quote_cache = {}

    def quote(a: int, b: int, e: int):
        key = (
            nodes[a].point.lat,
            nodes[a].point.lon,
            nodes[b].point.lat,
            nodes[b].point.lon,
            engineers[e].transport_type,
        )
        if key not in quote_cache:
            quote_cache[key] = travel.quote(
                nodes[a].point, nodes[b].point, engineers[e].transport_type
            )
        return quote_cache[key]

    # Resolve every external lookup before entering a C++ callback. Exceptions must
    # never cross SWIG and become an accidental zero-cost arc.
    physical = sorted(set(jobs.values()) | set(starts))
    profile_representatives = {}
    for e, engineer in enumerate(engineers):
        profile_representatives.setdefault(engineer.transport_type, e)
    for e in profile_representatives.values():
        for a in physical:
            for b in physical:
                quote(a, b, e)

    maximum_distance = max((q.distance_m for q in quote_cache.values() if q), default=0)
    distance_bound = max(1, (len(snapshot.requests) + len(engineers)) * maximum_distance)
    if distance_bound >= 2**60:
        raise ValueError("POLICY_COST_RANGE")

    def transit(a_index: int, b_index: int, e: int, metric: str) -> int:
        a, b = manager.IndexToNode(a_index), manager.IndexToNode(b_index)
        if a_index == b_index:
            return 0
        if metric == "engineers_used":
            first_anchor = nodes[a].kind == "start" or (
                nodes[a].kind == "lunch" and nodes[a].anchor == starts[e]
            )
            return int(nodes[b].kind == "job" and first_anchor)
        if metric == "job_count":
            return int(nodes[b].kind == "job")
        if nodes[b].kind == "end":
            return nodes[a].service if metric == "clock" else 0
        road = quote(a, b, e)
        if road is None:
            return horizon + 1 if metric != "distance" else distance_bound + 1
        if metric == "distance":
            return road.distance_m
        return road.duration_sec + (nodes[a].service if metric == "clock" else 0)

    callbacks: dict[str, list[int]] = {}
    for metric in ("clock", "travel", "distance", "engineers_used", "job_count"):
        callbacks[metric] = [
            routing.RegisterTransitCallback(
                lambda a, b, e=e, metric=metric: transit(a, b, e, metric)
            )
            for e in range(len(engineers))
        ]
    routing.AddDimensionWithVehicleTransits(callbacks["clock"], horizon, horizon, False, "Time")
    routing.AddDimensionWithVehicleTransits(callbacks["travel"], 0, horizon, True, "Travel")
    routing.AddDimensionWithVehicleTransits(
        callbacks["distance"], 0, distance_bound, True, "Distance"
    )
    routing.AddDimensionWithVehicleTransits(
        callbacks["job_count"], 0, max(1, len(snapshot.requests)), True, "JobCount"
    )
    equipment_types: tuple[EquipmentType, ...] = ("router", "set_top_box", "smart_speaker")
    for equipment_type in equipment_types:

        def equipment_demand(index: int, required: EquipmentType = equipment_type) -> int:
            node = nodes[manager.IndexToNode(index)]
            return int(
                node.kind == "job"
                and node.job is not None
                and request_by_id[node.job].required_equipment == required
            )

        callback = routing.RegisterUnaryTransitCallback(equipment_demand)
        routing.AddDimensionWithVehicleCapacity(
            callback,
            0,
            [engineer.equipment_stock.quantity(equipment_type) for engineer in engineers],
            True,
            f"Equipment_{equipment_type}",
        )
    time_dimension = routing.GetDimensionOrDie("Time")
    for e, engineer in enumerate(engineers):
        release = release_at(snapshot, engineer)
        if release is None:
            time_dimension.CumulVar(routing.Start(e)).SetRange(0, 0)
            time_dimension.CumulVar(routing.End(e)).SetRange(0, 0)
        else:
            time_dimension.CumulVar(routing.Start(e)).SetRange(release - origin, release - origin)
            time_dimension.CumulVar(routing.End(e)).SetRange(
                release - origin, min(engineer.shift_end_at, snapshot.horizon_end_at) - origin
            )
        routing.AddVariableMinimizedByFinalizer(time_dimension.CumulVar(routing.End(e)))

    # Coverage/lunch is a small, safely scalarized block. Lower resource stages
    # explicitly constrain these achieved counts and use their own units.
    lunch_weight = 1
    coverage_weight = len(engineers) + 1
    urgent_weight = (len(snapshot.requests) + 1) * coverage_weight
    for request in snapshot.requests:
        index = manager.NodeToIndex(jobs[request.request_id])
        allowed = [
            e for e, engineer in enumerate(engineers) if eligible(snapshot, engineer, request)
        ]
        routing.VehicleVar(index).SetValues([-1] + allowed)
        lower = max(0, request.window_start_at - origin)
        upper = min(
            horizon, request.window_end_at + settings.window_lateness_tolerance_sec - origin
        )
        if not allowed or lower > upper or request.service_duration_sec > horizon:
            routing.ActiveVar(index).SetValue(0)
        else:
            time_dimension.CumulVar(index).SetRange(lower, upper)
            if stage == "window_start_delay":
                time_dimension.SetCumulVarSoftUpperBound(index, lower, 1)
        penalty = coverage_weight + (urgent_weight if request.priority == "urgent" else 0)
        routing.AddDisjunction([index], penalty if stage == "coverage" else 0)

    for e, alternatives in lunches.items():
        engineer = engineers[e]
        indices = [manager.NodeToIndex(n) for n in alternatives]
        for n, index in zip(alternatives, indices):
            routing.VehicleVar(index).SetValues([-1, e])
            anchor = (
                routing.Start(e)
                if nodes[n].anchor == starts[e]
                else manager.NodeToIndex(nodes[n].anchor)
            )
            solver.Add(
                routing.ActiveVar(index) <= solver.IsEqualCstVar(routing.NextVar(anchor), index)
            )
            if nodes[nodes[n].anchor].kind == "job":
                solver.Add(routing.ActiveVar(index) <= routing.ActiveVar(anchor))
            lower = max(0, engineer.lunch.window_start_at - origin)
            upper = min(
                horizon, engineer.lunch.window_end_at - engineer.lunch.duration_sec - origin
            )
            if release_at(snapshot, engineer) is None or lower > upper:
                routing.ActiveVar(index).SetValue(0)
            else:
                time_dimension.CumulVar(index).SetRange(lower, upper)
        routing.AddDisjunction(
            indices,
            -1 if engineer.lunch.required else (lunch_weight if stage == "coverage" else 0),
            1,
        )

    active_jobs = {key: routing.ActiveVar(manager.NodeToIndex(n)) for key, n in jobs.items()}
    urgent_drops = solver.Sum(
        [1 - active_jobs[r.request_id] for r in snapshot.requests if r.priority == "urgent"]
    )
    all_drops = solver.Sum([1 - active for active in active_jobs.values()])
    missed_lunch = solver.Sum(
        [
            1 - solver.Sum([routing.ActiveVar(manager.NodeToIndex(n)) for n in group])
            for e, group in lunches.items()
            if not engineers[e].lunch.required
        ]
    )
    travel_sum = solver.Sum(
        [
            routing.GetDimensionOrDie("Travel").CumulVar(routing.End(e))
            for e in range(len(engineers))
        ]
    )
    distance_sum = solver.Sum(
        [
            routing.GetDimensionOrDie("Distance").CumulVar(routing.End(e))
            for e in range(len(engineers))
        ]
    )
    used_expressions = []
    for e in range(len(engineers)):
        assigned = [
            solver.IsEqualCstVar(routing.VehicleVar(manager.NodeToIndex(node)), e)
            for node in jobs.values()
        ]
        used_expressions.append(solver.Max(assigned) if assigned else solver.IntConst(0))
    engineers_used = solver.Sum(used_expressions)
    window_start_delay = solver.Sum(
        [
            solver.Max(
                time_dimension.CumulVar(manager.NodeToIndex(jobs[request.request_id]))
                - max(0, request.window_start_at - origin),
                0,
            )
            for request in snapshot.requests
        ]
    )
    job_count_dimension = routing.GetDimensionOrDie("JobCount")
    max_jobs_per_engineer = solver.Max(
        [job_count_dimension.CumulVar(routing.End(e)) for e in range(len(engineers))]
    )
    if incumbent is not None and stage != "coverage":
        values = criterion_values(snapshot, incumbent)
        expressions = {
            "urgent_unassigned": urgent_drops,
            "unassigned": all_drops,
            "missed_optional_lunches": missed_lunch,
            "travel_time": travel_sum,
            "distance": distance_sum,
            "engineers_used": engineers_used,
            "window_start_delay": window_start_delay,
            "max_jobs_per_engineer": max_jobs_per_engineer,
        }
        for criterion in (
            "urgent_unassigned",
            "unassigned",
            "missed_optional_lunches",
            *preserved_criteria,
        ):
            solver.Add(expressions[criterion] <= values[criterion])
    zero = routing.RegisterTransitCallback(lambda a, b: 0)
    objective_callbacks = {
        "travel_time": callbacks["travel"],
        "distance": callbacks["distance"],
        "engineers_used": callbacks["engineers_used"],
    }
    if stage == "max_jobs_per_engineer":
        job_count_dimension.SetGlobalSpanCostCoefficient(1)
    for e in range(len(engineers)):
        routing.SetArcCostEvaluatorOfVehicle(
            (objective_callbacks[stage][e] if stage in objective_callbacks else zero),
            e,
        )
    parameters = pywrapcp.DefaultRoutingSearchParameters()
    parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    )
    parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    parameters.time_limit.FromMilliseconds(max(1, budget_ms))
    parameters.solution_limit = settings.solution_limit
    parameters.sat_parameters.num_search_workers = 1
    parameters.sat_parameters.random_seed = 42
    routing.CloseModelWithParameters(parameters)
    seed = None
    if incumbent is not None:
        previous = {r.engineer_id: r for r in incumbent.routes}
        seed_routes = []
        for e, engineer in enumerate(engineers):
            sequence = []
            anchor = starts[e]
            route = previous.get(engineer.engineer_id)
            for stop in route.stops if route else []:
                if stop.kind == "job":
                    if stop.request_id in jobs:
                        anchor = jobs[stop.request_id]
                        sequence.append(anchor)
                elif stop.kind == "lunch":
                    match = next((n for n in lunches.get(e, []) if nodes[n].anchor == anchor), None)
                    if match is not None:
                        sequence.append(match)
            seed_routes.append(sequence)
        seed = routing.ReadAssignmentFromRoutes(seed_routes, True)
    solution = (
        routing.SolveFromAssignmentWithParameters(seed, parameters)
        if seed is not None
        else routing.SolveWithParameters(parameters)
    )
    if solution is None:
        return None
    routes = {}
    for e, engineer in enumerate(engineers):
        index = solution.Value(routing.NextVar(routing.Start(e)))
        steps = []
        while not routing.IsEnd(index):
            node = nodes[manager.IndexToNode(index)]
            steps.append(node.job if node.kind == "job" else None)
            index = solution.Value(routing.NextVar(index))
        route = schedule_steps(snapshot, engineer, steps, travel)
        if route is None:
            return None
        routes[engineer.engineer_id] = route
    plan = assemble_plan(snapshot, [routes[e.engineer_id] for e in snapshot.engineers])
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
    if request.required_transport not in (None, engineer.transport_type):
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
    return max(release, request.window_start_at) + request.service_duration_sec <= finish


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
        engineer for engineer in memory.snapshot.engineers if engineer.engineer_id not in known
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
    candidates = improve_routes(
        search_snapshot, travel, [projected], effort, construct=construct
    )
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
        engineer
        for engineer in snapshot.engineers
        if engineer.engineer_id.startswith("covering-")
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
                if not engineer.engineer_id.startswith("covering-")
                or engineer.engineer_id in used
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
        # Preserve the senior coverage/lateness criteria exactly while reducing
        # the number of used extras.  Remaining impossible jobs therefore do
        # not block a safe reduction attempt.
        if (
            current_score is not None
            and trial_score[:4] == current_score[:4]
            and trial_score[4] <= current_score[4]
        ):
            current_snapshot, current = trial_snapshot, trial
    final_used = {r.engineer_id for r in current.routes if r.metrics.assigned_count > 0}
    current_snapshot = current_snapshot.model_copy(update={"engineers": [
        e for e in current_snapshot.engineers
        if not e.engineer_id.startswith("covering-") or e.engineer_id in final_used
    ]})
    final = _canonical_plan(current_snapshot, current.routes, travel) if current.is_usable else current
    validate_plan(current_snapshot, final, travel)
    return current_snapshot.engineers, final.routes


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
    travel = configure_travel(travel, settings.technical(), snapshot.planning_as_of)
    snapshot = apply_system_policy(snapshot, settings)
    search_snapshot = _without_optional_lunches(snapshot)
    policy: PolicySpec = compile_policy(search_snapshot.policy)
    context_version = context_version or default_context_version
    base = baseline(snapshot, travel)
    validate_plan(snapshot, base, travel)
    compatible = (
        memory is not None
        and memory.context_version == context_version
        and memory.snapshot.policy == snapshot.policy
    )
    projected = (
        _project(snapshot, memory.plan, travel) if compatible and memory.plan.is_usable else None
    )
    same_assignments = (
        projected is not None
        and memory is not None
        and {a.request_id: a.engineer_id for a in projected.assignments}
        == {a.request_id: a.engineer_id for a in memory.plan.assignments}
    )
    if (
        same_assignments
        and _small_change(memory.snapshot, snapshot, settings.departure_lateness_tolerance_sec)
        and _task_starts_within_tolerance(
            memory.plan, projected, settings.task_start_lateness_tolerance_sec
        )
    ):
        return EngineOutput(projected, base, "REVALIDATE", memory)
    path = "REPAIR_AND_IMPROVE" if projected else "COLD_START"
    search_base = base if search_snapshot is snapshot else baseline(search_snapshot, travel)
    validate_plan(search_snapshot, search_base, travel)
    search_projected = (
        _project(search_snapshot, memory.plan, travel)
        if compatible and memory is not None and memory.plan.is_usable
        else None
    )
    candidates = [
        plan for plan in (search_base, search_projected) if plan is not None and plan.is_usable
    ]
    incumbent = (
        min(candidates, key=lambda plan: score(search_snapshot, plan)) if candidates else None
    )
    deadline = time.monotonic() + settings.time_limit_ms / 1000
    # Static OR-Tools remains a seed generator only when forecast traffic is disabled.
    # Departure-dependent routes are optimized by exact whole-route evaluation.
    stages = policy.search_stages if not settings.traffic_enabled else ()
    stages = tuple(
        stage
        for stage in stages
        if stage
        not in ("total_lateness", "window_end_risk", "max_workload_ratio", "workload_spread")
    )
    for i, stage in enumerate(stages):
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            break
        candidate = _search(
            search_snapshot,
            travel,
            settings,
            stage,
            incumbent,
            remaining // (len(stages) - i),
            tuple(stages[1:i]),
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
    validate_plan(snapshot, main, travel)
    return EngineOutput(
        main, base, path, EngineMemory(snapshot.model_copy(deep=True), main, context_version)
    )
