"""OR-Tools routing model: static VRPTW fit to the LCT case.

One :func:`solve` call builds a multi-depot VRPTW from a
:class:`core.types.SolverInput` and returns raw route data. Constraint map
(context/26 case, context/27 §3 skeleton, context/15 §2.2):

- engineers are independent vehicles with their own start/end depots
  ("engineer from home" is a separate depot, never one shared depot);
- the time dimension carries travel + service as transit and waiting as
  slack (capped, see :data:`MAX_WAIT_MIN`);
- request windows: hard upper bound for ``window_strict`` / VIP requests,
  soft upper bound (per-minute penalty ``weights.sla``) otherwise; the
  window lower bound is always hard (a client is not available earlier);
- engineer shifts: departure fixed at shift start, return by shift end;
- skills / equipment / vehicle-class / shift-window compatibility is
  resolved by a prefilter into ``SetAllowedVehiclesForIndex`` — the same
  candidate lists feed the explanation layer;
- a request the solver cannot insert is dropped via a disjunction penalty
  (``UNASSIGNED_PENALTY``), i.e. SLA violations are minimized rather than
  rendering the model infeasible.

Determinism (context/27 §10): requests are sorted by id, the first-solution
strategy and metaheuristic are fixed, the CP search is single-threaded. A
wall-clock ``time_limit`` can make the GLS stopping point vary between runs,
so callers who need bit-identical plans (golden test, demo replay) must pass
``solution_limit`` instead of relying on time alone.

Time units: integer seconds inside the model (AGENTS.md §9.2), minutes at
this module's boundary.
"""

from __future__ import annotations

import time as time_mod
from dataclasses import dataclass, field

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from core.matrix import build_travel_minutes
from core.types import Assignment, Engineer, LatLon, Request, SolverInput

# Objective weights (context/04 §4): a dropped request costs 1e6, lateness
# weights.sla per minute (applied per second inside the model), travel 1.
UNASSIGNED_PENALTY = 1_000_000

# Waiting slack cap. The context/27 §3 snippet uses 60 min; that would make a
# request whose window opens >60 min past the previous stop's service end
# unassignable, so the core allows up to 4 h of waiting.
MAX_WAIT_MIN = 240

HORIZON_MIN = 24 * 60


@dataclass(frozen=True)
class CandidateInfo:
    """Prefilter verdict for one request (context/11 §3 candidate list).

    Attributes:
        feasible: engineer ids that pass every compatibility check.
        blocked: engineer id → blocking code (``skill_missing``,
            ``equipment_missing``, ``vehicle_class``, ``shift_window``);
            the first failing check wins.
    """

    request_id: str
    feasible: tuple[str, ...]
    blocked: dict[str, str] = field(default_factory=dict)


@dataclass
class SolveOutput:
    """Raw solver result handed to the metrics/reasons layers.

    ``routes`` / ``route_nodes`` are ordered visit lists per engineer;
    ``engineer_span_min`` holds (start, end) cumul per engineer in
    minutes-of-day for workload metrics; ``matrix_min`` is the node-indexed
    travel matrix reused by the explanation layer.
    """

    assignments: list[Assignment]
    unassigned_ids: list[str]
    routes: dict[str, list[str]]
    route_nodes: dict[str, list[int]]
    matrix_min: list[list[int]]
    request_pos: dict[str, int]
    engineer_pos: dict[str, int]
    engineer_span_min: dict[str, tuple[int, int]]
    return_travel_min: dict[str, int]
    candidates: dict[str, CandidateInfo]
    solve_ms: int


def _equipment_shortage(engineer: Engineer, required: dict[str, int]) -> bool:
    """True when the engineer's kit does not cover the required quantities."""
    return any(engineer.equipment.count(item) < qty for item, qty in required.items())


def _vehicle_rejected(request: Request, engineer: Engineer) -> bool:
    """True when the engineer's vehicle class is not allowed for the request."""
    return "any" not in request.allowed_vehicle_classes and (
        engineer.vehicle_class not in request.allowed_vehicle_classes
    )


def prefilter(input_data: SolverInput) -> dict[str, CandidateInfo]:
    """Compute per-request candidate engineers and blocking reasons.

    Checks, in order of specificity: required skills, required equipment
    (with quantities), allowed vehicle classes, and a conservative
    shift-overlap check (the window must intersect the shift; travel and
    service feasibility are left to the solver).

    Args:
        input_data: parsed solver input.

    Returns:
        Map request id → :class:`CandidateInfo`.
    """
    result: dict[str, CandidateInfo] = {}
    for request in input_data.requests:
        feasible: list[str] = []
        blocked: dict[str, str] = {}
        for engineer in input_data.engineers:
            if not set(request.required_skills) <= set(engineer.skills):
                blocked[engineer.id] = "skill_missing"
            elif _equipment_shortage(engineer, request.required_equipment):
                blocked[engineer.id] = "equipment_missing"
            elif _vehicle_rejected(request, engineer):
                blocked[engineer.id] = "vehicle_class"
            elif (
                request.window_open_min >= engineer.shift_end_min
                or request.window_close_min <= engineer.shift_start_min
            ):
                blocked[engineer.id] = "shift_window"
            else:
                feasible.append(engineer.id)
        result[request.id] = CandidateInfo(request_id=request.id, feasible=tuple(feasible), blocked=blocked)
    return result


@dataclass(frozen=True)
class _Nodes:
    """Node indexing shared by the matrix and the routing model."""

    starts: tuple[int, ...]
    ends: tuple[int, ...]
    request_pos: dict[str, int]  # request id → node offset (2K + pos)


def _build_nodes(input_data: SolverInput, sorted_requests: tuple[Request, ...]) -> _Nodes:
    n = len(input_data.engineers)
    return _Nodes(
        starts=tuple(range(n)),
        ends=tuple(range(n, 2 * n)),
        request_pos={r.id: 2 * n + i for i, r in enumerate(sorted_requests)},
    )


def solve(
    input_data: SolverInput,
    time_limit_ms: int = 1500,
    solution_limit: int | None = None,
) -> SolveOutput:
    """Build and solve the routing model for one static plan.

    Args:
        input_data: parsed solver input (requests are re-sorted by id inside).
        time_limit_ms: wall-clock search budget; the primary stop for the
            interactive path (context/07 §5: ≤ 1.5 s).
        solution_limit: optional cap on accepted solutions; when set it is
            the deterministic stopping criterion (golden tests, demo replay)
            with the time limit kept as a safety net.

    Returns:
        :class:`SolveOutput` with assignments, routes, candidate lists and
        the node-indexed matrix for downstream layers.

    Raises:
        RuntimeError: if the CP search returns no solution at all.
    """
    wall_start = time_mod.perf_counter()
    sorted_requests = tuple(sorted(input_data.requests, key=lambda r: r.id))
    engineers = input_data.engineers
    candidates = prefilter(input_data)
    nodes = _build_nodes(input_data, sorted_requests)

    points = [e.start for e in engineers] + [e.end_point for e in engineers] + [
        LatLon(r.lat, r.lon) for r in sorted_requests
    ]
    # Reference hour for the traffic coefficient: earliest shift start; a
    # pre-solve matrix cannot depend on solver decisions (see module docstring).
    ref_hour = min(e.shift_start_min for e in engineers) // 60
    matrix_min = build_travel_minutes(points, hour=ref_hour, coeff_map=input_data.travel_matrix.hour_coeff)
    matrix_sec = [[m * 60 for m in row] for row in matrix_min]
    service_sec = {nodes.request_pos[r.id]: r.service_min * 60 for r in sorted_requests}

    n_vehicles = len(engineers)
    mgr = pywrapcp.RoutingIndexManager(len(points), n_vehicles, list(nodes.starts), list(nodes.ends))
    routing = pywrapcp.RoutingModel(mgr)

    def transit_seconds(from_index: int, to_index: int) -> int:
        """Arc transit: travel seconds + service seconds at the origin node."""
        a, b = mgr.IndexToNode(from_index), mgr.IndexToNode(to_index)
        return matrix_sec[a][b] + service_sec.get(a, 0)

    transit_idx = routing.RegisterTransitCallback(transit_seconds)
    routing.AddDimension(
        transit_idx,
        MAX_WAIT_MIN * 60,
        HORIZON_MIN * 60,
        False,  # cumul values are absolute minutes-of-day, not zero-based
        "Time",
    )
    time_dim = routing.GetDimensionOrDie("Time")
    routing.SetArcCostEvaluatorOfAllVehicles(transit_idx)

    eng_index = {e.id: v for v, e in enumerate(engineers)}
    sla_per_sec = max(1, input_data.weights.get("sla", 100000) // 60)

    for request in sorted_requests:
        node = nodes.request_pos[request.id]
        idx = mgr.NodeToIndex(node)
        open_sec, close_sec = request.window_open_min * 60, request.window_close_min * 60
        time_dim.CumulVar(idx).SetMin(open_sec)
        if request.hard_window:
            time_dim.CumulVar(idx).SetMax(close_sec)
        else:
            time_dim.SetCumulVarSoftUpperBound(idx, close_sec, sla_per_sec)
        feasible = candidates[request.id].feasible
        if not feasible:
            # Nobody can ever serve it: dropping must be free, otherwise the
            # solver pays a phantom penalty and distorts the rest of the plan.
            routing.AddDisjunction([idx], 0)
        else:
            routing.AddDisjunction([idx], UNASSIGNED_PENALTY)
            if len(feasible) < n_vehicles:
                # VehicleVar.SetValues instead of SetAllowedVehiclesForIndex:
                # the 9.15 SWIG wrapper rejects Python sequences for the
                # absl::Span argument. -1 keeps the disjunction drop option.
                routing.VehicleVar(idx).SetValues([eng_index[e] for e in feasible] + [-1])

    for v, engineer in enumerate(engineers):
        time_dim.CumulVar(routing.Start(v)).SetValue(engineer.shift_start_min * 60)
        time_dim.CumulVar(routing.End(v)).SetMax(engineer.shift_end_min * 60)

    search = pywrapcp.DefaultRoutingSearchParameters()
    search.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search.time_limit.FromMilliseconds(time_limit_ms)
    if solution_limit is not None:
        search.solution_limit = solution_limit

    solution = routing.SolveWithParameters(search)
    if solution is None:
        raise RuntimeError("OR-Tools returned no solution (infeasible or search failure)")
    solve_ms = round((time_mod.perf_counter() - wall_start) * 1000)

    output = _extract(
        solution=solution,
        mgr=mgr,
        routing=routing,
        time_dim=time_dim,
        input_data=input_data,
        sorted_requests=sorted_requests,
        nodes=nodes,
        matrix_min=matrix_min,
        service_sec=service_sec,
        candidates=candidates,
        solve_ms=solve_ms,
    )
    return output


def _extract(
    solution,
    mgr,
    routing,
    time_dim,
    input_data: SolverInput,
    sorted_requests: tuple[Request, ...],
    nodes: _Nodes,
    matrix_min: list[list[int]],
    service_sec: dict[int, int],
    candidates: dict[str, CandidateInfo],
    solve_ms: int,
) -> SolveOutput:
    """Walk the solved model and project it onto contract-shaped data."""
    engineers = input_data.engineers
    request_by_node = {nodes.request_pos[r.id]: r for r in sorted_requests}
    assignments: list[Assignment] = []
    routes: dict[str, list[str]] = {}
    route_nodes: dict[str, list[int]] = {}
    engineer_span_min: dict[str, tuple[int, int]] = {}
    return_travel_min: dict[str, int] = {}
    dropped: list[str] = []

    for v, engineer in enumerate(engineers):
        idx = routing.Start(v)
        chain: list[tuple[int, int]] = []  # (node, cumul seconds)
        while not routing.IsEnd(idx):
            node = mgr.IndexToNode(idx)
            chain.append((node, solution.Value(time_dim.CumulVar(idx))))
            idx = solution.Value(routing.NextVar(idx))
        end_node, end_cumul = mgr.IndexToNode(idx), solution.Value(time_dim.CumulVar(idx))

        visits: list[str] = []
        visit_nodes: list[int] = []
        prev_node, prev_cumul = chain[0][0], chain[0][1]
        for seq, (node, cumul) in enumerate(chain[1:], start=1):
            request = request_by_node[node]
            travel_min = matrix_min[prev_node][node]
            wait_min = (cumul - prev_cumul - service_sec.get(prev_node, 0) - travel_min * 60) // 60
            assignments.append(
                Assignment(
                    request=request.id,
                    engineer=engineer.id,
                    seq=seq,
                    eta_min=cumul // 60,
                    done_by_min=cumul // 60 + request.service_min,
                    travel_from_prev_min=travel_min,
                    wait_min=wait_min,
                )
            )
            visits.append(request.id)
            visit_nodes.append(node)
            prev_node, prev_cumul = node, cumul

        routes[engineer.id] = visits
        route_nodes[engineer.id] = visit_nodes
        engineer_span_min[engineer.id] = (chain[0][1] // 60, end_cumul // 60)
        return_travel_min[engineer.id] = matrix_min[prev_node][end_node] if visits else 0

    for request in sorted_requests:
        idx = mgr.NodeToIndex(nodes.request_pos[request.id])
        if solution.Value(routing.NextVar(idx)) == idx:  # self-loop = dropped
            dropped.append(request.id)

    return SolveOutput(
        assignments=assignments,
        unassigned_ids=dropped,
        routes=routes,
        route_nodes=route_nodes,
        matrix_min=matrix_min,
        request_pos=nodes.request_pos,
        engineer_pos={e.id: v for v, e in enumerate(engineers)},
        engineer_span_min=engineer_span_min,
        return_travel_min=return_travel_min,
        candidates=candidates,
        solve_ms=solve_ms,
    )
