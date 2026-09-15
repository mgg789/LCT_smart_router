"""OR-Tools Routing Engine with lunch alternatives and bounded hierarchical search.

Search stages preserve achieved senior criteria. No result claims proven global
optimality. Engine owns all route choices; Runtime only validates and publishes.
"""

import time
from dataclasses import dataclass

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from core.contracts import GeoPoint, Plan, RouterTaskSnapshot
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
    solution_limit: int = 64
    tolerance_sec: int = 0

    def __post_init__(self):
        if self.time_limit_ms < 1 or self.solution_limit < 1 or self.tolerance_sec < 0:
            raise ValueError("invalid search settings")


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
        ignore = {"available_from", "position_observed_at"}
        if a.model_dump(exclude=ignore) != b.model_dump(exclude=ignore):
            return False
        if a.available_from is None or b.available_from is None:
            if a.available_from != b.available_from:
                return False
        elif abs(a.available_from - b.available_from) > tolerance:
            return False
    return True


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
    for e in range(len(engineers)):
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
        if nodes[b].kind == "end":
            return nodes[a].service if metric == "clock" else 0
        road = quote(a, b, e)
        if road is None:
            return horizon + 1 if metric != "distance" else distance_bound + 1
        if metric == "distance":
            return road.distance_m
        return road.duration_sec + (nodes[a].service if metric == "clock" else 0)

    callbacks: dict[str, list[int]] = {}
    for metric in ("clock", "travel", "distance"):
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
        upper = min(horizon, request.window_end_at - origin)
        if not allowed or lower > upper or request.service_duration_sec > horizon:
            routing.ActiveVar(index).SetValue(0)
        else:
            time_dimension.CumulVar(index).SetRange(lower, upper)
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
    if incumbent is not None and stage != "coverage":
        incumbent_score = score(snapshot, incumbent)
        for expression, value in zip((urgent_drops, all_drops, missed_lunch), incumbent_score[:3]):
            solver.Add(expression <= value)
        if stage == "distance":
            solver.Add(travel_sum <= incumbent_score[3])
    zero = routing.RegisterTransitCallback(lambda a, b: 0)
    for e in range(len(engineers)):
        routing.SetArcCostEvaluatorOfVehicle(
            zero if stage == "coverage" else callbacks[stage][e], e
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


def solve(
    snapshot: RouterTaskSnapshot,
    travel: TravelProvider,
    settings: SearchSettings | None = None,
    memory: EngineMemory | None = None,
    context_version: str | None = None,
) -> EngineOutput:
    """Compute baseline and bounded main, preserving feasible small-change ordering.

    The three search stages optimize coverage/lunch, travel, then metres. Engineer count
    is the final comparator tie-break among candidates, not a proof of minimum fleet.
    """
    settings = settings or SearchSettings()
    context_version = context_version or travel.version
    base = baseline(snapshot, travel)
    validate_plan(snapshot, base, travel)
    compatible = memory is not None and memory.context_version == context_version
    projected = (
        _project(snapshot, memory.plan, travel) if compatible and memory.plan.is_usable else None
    )
    same_assignments = (
        projected is not None
        and memory is not None
        and {a.request_id: a.engineer_id for a in projected.assignments}
        == {a.request_id: a.engineer_id for a in memory.plan.assignments}
    )
    if same_assignments and _small_change(memory.snapshot, snapshot, settings.tolerance_sec):
        return EngineOutput(projected, base, "REVALIDATE", memory)
    path = "REPAIR_AND_IMPROVE" if projected else "COLD_START"
    candidates = [p for p in (base, projected) if p is not None and p.is_usable]
    incumbent = min(candidates, key=lambda p: score(snapshot, p)) if candidates else None
    deadline = time.monotonic() + settings.time_limit_ms / 1000
    for i, stage in enumerate(("coverage", "travel", "distance")):
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            break
        candidate = _search(snapshot, travel, settings, stage, incumbent, remaining // (3 - i))
        if candidate is not None and (
            incumbent is None or score(snapshot, candidate) < score(snapshot, incumbent)
        ):
            incumbent = candidate
    main = incumbent or base
    validate_plan(snapshot, main, travel)
    return EngineOutput(
        main, base, path, EngineMemory(snapshot.model_copy(deep=True), main, context_version)
    )
