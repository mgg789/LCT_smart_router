"""Bounded OR-Tools search for staged route candidates."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from core.contracts import EquipmentType, GeoPoint, Plan, RouterTaskSnapshot
from core.policy import Criterion, criterion_values
from core.schedule import (
    TERMINAL_SHIFT_OVERTIME_SEC,
    TERMINAL_WINDOW_LATENESS_TOLERANCE_SEC,
    TravelProvider,
    assemble_plan,
    eligible,
    job_completion_limit,
    release_at,
    schedule_steps,
    terminal_eligible,
    terminal_release_at,
    validate_plan,
)

if TYPE_CHECKING:
    from core.engine import SearchSettings


@dataclass(frozen=True)
class _Node:
    kind: str
    point: GeoPoint
    service: int = 0
    job: str | None = None
    owner: int | None = None
    anchor: int | None = None


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
    time_horizon = horizon + (0 if settings.strict_time_windows else TERMINAL_SHIFT_OVERTIME_SEC)
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
        lunch_duration = engineer.lunch.duration_sec
        if lunch_duration is None:
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
                    lunch_duration,
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
            engineers[e].travel_profile(),
        )
        if key not in quote_cache:
            quote_cache[key] = travel.quote(
                nodes[a].point, nodes[b].point, engineers[e].travel_profile()
            )
        return quote_cache[key]

    # Resolve every external lookup before entering a C++ callback. Exceptions must
    # never cross SWIG and become an accidental zero-cost arc.
    physical = sorted(set(jobs.values()) | set(starts))
    profile_representatives = {}
    for e, engineer in enumerate(engineers):
        profile_representatives.setdefault(engineer.travel_profile(), e)
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
        if metric == "additional_engineers":
            if not engineers[e].engineer_id.startswith("covering-"):
                return 0
            first_anchor = nodes[a].kind == "start" or (
                nodes[a].kind == "lunch" and nodes[a].anchor == starts[e]
            )
            return int(nodes[b].kind == "job" and first_anchor)
        if metric == "extra_assignments":
            return int(
                nodes[b].kind == "job" and engineers[e].engineer_id.startswith("covering-")
            )
        if nodes[b].kind == "end":
            return nodes[a].service if metric == "clock" else 0
        road = quote(a, b, e)
        if road is None:
            if metric == "clock":
                return time_horizon + 1
            return horizon + 1 if metric != "distance" else distance_bound + 1
        if metric == "distance":
            return road.distance_m
        return road.duration_sec + (nodes[a].service if metric == "clock" else 0)

    callbacks: dict[str, list[int]] = {}
    for metric in (
        "clock",
        "travel",
        "distance",
        "engineers_used",
        "job_count",
        "additional_engineers",
        "extra_assignments",
    ):
        callbacks[metric] = [
            routing.RegisterTransitCallback(
                lambda a, b, e=e, metric=metric: transit(a, b, e, metric)
            )
            for e in range(len(engineers))
        ]
    routing.AddDimensionWithVehicleTransits(
        callbacks["clock"], time_horizon, time_horizon, False, "Time"
    )
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
        release = release_at(snapshot, engineer) or terminal_release_at(snapshot, engineer)
        if release is None:
            time_dimension.CumulVar(routing.Start(e)).SetRange(0, 0)
            time_dimension.CumulVar(routing.End(e)).SetRange(0, 0)
        else:
            time_dimension.CumulVar(routing.Start(e)).SetRange(release - origin, release - origin)
            time_dimension.CumulVar(routing.End(e)).SetRange(
                release - origin,
                job_completion_limit(snapshot, engineer, terminal=True, strict=settings.strict_time_windows) - origin,
            )
        routing.AddVariableMinimizedByFinalizer(time_dimension.CumulVar(routing.End(e)))

    # Coverage/lunch is a small, safely scalarized block. Lower resource stages
    # explicitly constrain these achieved counts and use their own units.
    lunch_weight = 1
    coverage_weight = len(engineers) + 1
    urgent_weight = (len(snapshot.requests) + 1) * coverage_weight
    connection_weight = (len(snapshot.requests) + 1) * (urgent_weight + coverage_weight)
    dispatcher_weight = (len(snapshot.requests) + 1) * (connection_weight + urgent_weight + coverage_weight)
    emergency_weight = (len(snapshot.requests) + 1) * (dispatcher_weight + connection_weight + urgent_weight + coverage_weight)
    for request in snapshot.requests:
        index = manager.NodeToIndex(jobs[request.request_id])
        allowed = [
            e
            for e, engineer in enumerate(engineers)
            if eligible(snapshot, engineer, request)
            or terminal_eligible(snapshot, engineer, request)
        ]
        routing.VehicleVar(index).SetValues([-1] + allowed)
        if request.manual_engineer_id is not None:
            routing.ActiveVar(index).SetValue(1)
        lower = max(0, request.ready_at - origin)
        # Time is the service start cumul.  Bound it by completion rather than arrival:
        # scheduling a 30-minute job at 10:18 for a window ending 10:20 must not pass
        # merely because its start fits.
        normal_upper = min(
            horizon,
            request.window_end_at
            + (0 if request.manual_window else settings.window_lateness_tolerance_sec)
            - request.service_duration_sec
            - origin,
        )
        terminal_upper = min(
            time_horizon,
            request.window_end_at
            + (0 if request.manual_window else max(
                settings.window_lateness_tolerance_sec,
                0 if settings.strict_time_windows else TERMINAL_WINDOW_LATENESS_TOLERANCE_SEC,
            ))
            - request.service_duration_sec
            - origin,
        )
        if not allowed or lower > terminal_upper or request.service_duration_sec > time_horizon:
            routing.ActiveVar(index).SetValue(0)
        else:
            time_dimension.CumulVar(index).SetRange(lower, terminal_upper)
            # The end cumul includes service at this node.  The extended shift
            # cap applies only when this exact job is directly followed by the
            # vehicle end, which also excludes a later lunch or another job.
            for e, engineer in enumerate(engineers):
                on_vehicle = solver.IsEqualCstVar(routing.VehicleVar(index), e)
                next_is_end = solver.IsEqualCstVar(routing.NextVar(index), routing.End(e))
                normal_limit = job_completion_limit(snapshot, engineer, terminal=False) - origin
                normal_window_limit = min(normal_upper, horizon)
                terminal_window_limit = terminal_upper
                inactive_time_slack = max(time_horizon * 2, time_horizon - normal_window_limit)
                solver.Add(
                    time_dimension.CumulVar(index) + request.service_duration_sec
                    <= normal_limit
                    + (0 if settings.strict_time_windows or engineer.manual_shift else TERMINAL_SHIFT_OVERTIME_SEC) * next_is_end
                    + inactive_time_slack * (1 - on_vehicle)
                )
                solver.Add(
                    time_dimension.CumulVar(index)
                    <= normal_window_limit
                    + (terminal_window_limit - normal_window_limit) * next_is_end
                    + inactive_time_slack * (1 - on_vehicle)
                )
            if stage == "window_start_delay" or (
                stage == "emergency_response_delay" and request.category == "emergency"
            ) or (stage == "dispatcher_response_delay" and request.dispatcher_priority
            ):
                time_dimension.SetCumulVarSoftUpperBound(index, lower, 1)
        penalty = (coverage_weight + (urgent_weight if request.priority == "urgent" else 0)
                   + (dispatcher_weight if request.dispatcher_priority else 0)
                   + (connection_weight if request.category == "connection" else 0)
                   + (emergency_weight if request.category == "emergency" else 0))
        routing.AddDisjunction([index], penalty if stage == "coverage" else 0)

    for e, alternatives in lunches.items():
        engineer = engineers[e]
        indices = [manager.NodeToIndex(n) for n in alternatives]
        for n, index in zip(alternatives, indices):
            routing.VehicleVar(index).SetValues([-1, e])
            anchor_node = nodes[n].anchor
            if anchor_node is None:
                routing.ActiveVar(index).SetValue(0)
                continue
            anchor = (
                routing.Start(e)
                if anchor_node == starts[e]
                else manager.NodeToIndex(anchor_node)
            )
            solver.Add(
                routing.ActiveVar(index) <= solver.IsEqualCstVar(routing.NextVar(anchor), index)
            )
            if nodes[anchor_node].kind == "job":
                solver.Add(routing.ActiveVar(index) <= routing.ActiveVar(anchor))
            if (
                engineer.lunch.window_start_at is None
                or engineer.lunch.window_end_at is None
                or engineer.lunch.duration_sec is None
            ):
                routing.ActiveVar(index).SetValue(0)
                continue
            lower = max(0, engineer.lunch.window_start_at - origin)
            upper = min(horizon, engineer.lunch.window_end_at - engineer.lunch.duration_sec - origin)
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
    emergency_drops = solver.Sum([1 - active_jobs[r.request_id] for r in snapshot.requests if r.category == "emergency"])
    connection_drops = solver.Sum([1 - active_jobs[r.request_id] for r in snapshot.requests if r.category == "connection"])
    emergency_delay = solver.Sum([
        solver.Max(time_dimension.CumulVar(manager.NodeToIndex(jobs[r.request_id]))
                   - max(0, r.ready_at - origin), 0) * active_jobs[r.request_id]
        for r in snapshot.requests if r.category == "emergency"
    ])
    dispatcher_drops = solver.Sum([1 - active_jobs[r.request_id] for r in snapshot.requests if r.dispatcher_priority])
    dispatcher_delay = solver.Sum([
        solver.Max(time_dimension.CumulVar(manager.NodeToIndex(jobs[r.request_id]))
                   - max(0, r.ready_at - origin), 0) * active_jobs[r.request_id]
        for r in snapshot.requests if r.dispatcher_priority
    ])
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
    reserve_indexes = [
        e
        for e, engineer in enumerate(engineers)
        if engineer.engineer_id.startswith("covering-")
    ]
    additional_engineers = (
        solver.Sum([used_expressions[e] for e in reserve_indexes])
        if reserve_indexes
        else solver.IntConst(0)
    )
    extra_assignments = (
        solver.Sum(
            [
                solver.IsEqualCstVar(routing.VehicleVar(manager.NodeToIndex(node)), e)
                for e in reserve_indexes
                for node in jobs.values()
            ]
        )
        if reserve_indexes
        else solver.IntConst(0)
    )
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
            "emergency_unassigned": emergency_drops,
            "emergency_response_delay": emergency_delay,
            "dispatcher_unassigned": dispatcher_drops,
            "dispatcher_response_delay": dispatcher_delay,
            "connection_unassigned": connection_drops,
            "urgent_unassigned": urgent_drops,
            "unassigned": all_drops,
            "missed_optional_lunches": missed_lunch,
            "travel_time": travel_sum,
            "distance": distance_sum,
            "engineers_used": engineers_used,
            "additional_engineers": additional_engineers,
            "extra_assignments": extra_assignments,
            "window_start_delay": window_start_delay,
            "max_jobs_per_engineer": max_jobs_per_engineer,
        }
        for criterion in (
            "emergency_unassigned",
            "emergency_response_delay",
            "dispatcher_unassigned",
            "dispatcher_response_delay",
            "connection_unassigned",
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
        "additional_engineers": callbacks["additional_engineers"],
        "extra_assignments": callbacks["extra_assignments"],
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
