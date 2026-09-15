"""Rule-based explanation layer (context/11 §3; decision D-3).

Every reason is computed from solver data (prefilter candidate lists, the
travel matrix, route geometry) as structured JSON factors — never free text
written by a human or an LLM. Human-readable ``detail`` / ``why`` strings are
UI copy in Russian (team language); factor ``code`` s stay machine-readable
English, taken from the context/11 §6 dictionary.

Per assigned request the block shape is::

    {"assignment": {"chosen": eng, "factors": [...], "alternatives": [...]},
     "sequence": [{"swap_with", "cost_delta", "why"}, ...]}

Per unassigned request::

    {"unassigned": {"why": "<code>: <ui text>", "blocked_top": [...]}}

Simplifications for the core prototype: ``alternatives.cost_delta`` is a
travel-only insertion delta into the alternative engineer's current route,
and ``sequence`` entries compare adjacent swaps by travel time only; both
ignore knock-on window effects. Refining those deltas is future work.
"""

from __future__ import annotations

from collections import Counter

from core.model import CandidateInfo, SolveOutput
from core.types import Request, SolverInput

# UI copy for blocking codes (context/11 §6) — shown verbatim in reasons.
BLOCK_LABELS = {
    "skill_missing": "нет нужных навыков",
    "equipment_missing": "нет нужного оборудования",
    "vehicle_class": "не подходит транспорт",
    "shift_window": "окно вне смены",
}


def unassigned_why(request_id: str, candidates: dict[str, CandidateInfo]) -> str:
    """Explain why a request stayed out of the plan.

    Args:
        request_id: request in question.
        candidates: prefilter verdicts from :func:`core.model.prefilter`.

    Returns:
        "<code>: <ui text>" string, code being ``no_candidate`` when nobody
        passes compatibility, ``window_conflict`` when candidates exist but
        the solver could not insert the visit.
    """
    info = candidates[request_id]
    if not info.feasible:
        dominant = Counter(info.blocked.values()).most_common(1)[0][0]
        return f"no_candidate: {BLOCK_LABELS[dominant]}"
    return (
        f"window_conflict: есть подходящие инженеры ({len(info.feasible)}), "
        "но визит не встроился в окна без нарушения смен"
    )


def _framed_nodes(output: SolveOutput, engineer_id: str) -> tuple[list[int], int]:
    """Full visit sequence for an engineer: [start] + requests + [end].

    Returns the node list and the count of request nodes in it.
    """
    start_node = output.engineer_pos[engineer_id]
    end_node = start_node + len(output.engineer_pos)
    nodes = [start_node] + list(output.route_nodes[engineer_id]) + [end_node]
    return nodes, len(output.route_nodes[engineer_id])


def _insertion_delta(output: SolveOutput, engineer_id: str, request_node: int) -> int:
    """Minimal travel-only cost of inserting a request node into a route."""
    nodes, _ = _framed_nodes(output, engineer_id)
    matrix = output.matrix_min
    best = min(
        matrix[nodes[i]][request_node] + matrix[request_node][nodes[i + 1]] - matrix[nodes[i]][nodes[i + 1]]
        for i in range(len(nodes) - 1)
    )
    return best


def _swap_deltas(output: SolveOutput, engineer_id: str, request_node: int) -> list[dict]:
    """Travel-only deltas of swapping the visit with its adjacent neighbors."""
    nodes, n_visits = _framed_nodes(output, engineer_id)
    matrix = output.matrix_min
    request_by_node = {node: rid for rid, node in output.request_pos.items()}
    k = nodes.index(request_node)
    entries: list[dict] = []
    for other_pos in (k - 1, k + 1):
        if not (1 <= other_pos <= n_visits):  # neighbor must be a request node
            continue
        lo, hi = min(k, other_pos), max(k, other_pos)
        a, x, y, b = nodes[lo - 1], nodes[lo], nodes[hi], nodes[hi + 1]
        delta = (matrix[a][y] + matrix[y][x] + matrix[x][b]) - (matrix[a][x] + matrix[x][y] + matrix[y][b])
        entries.append(
            {
                "swap_with": request_by_node[nodes[other_pos]],
                "cost_delta": delta,
                "why": (
                    f"перестановка изменит время в пути на {delta} мин"
                    if delta
                    else "перестановка не меняет время в пути"
                ),
            }
        )
    return entries


def _assignment_factors(request: Request, output: SolveOutput, engineer_id: str, eta_min: int) -> list[dict]:
    """Ordered explanation factors for one assignment (context/11 §3)."""
    required_skills = list(request.required_skills)
    required_equipment = list(request.required_equipment)
    window_width = request.window_close_min - request.window_open_min
    margin = request.window_close_min - eta_min

    workloads = {
        eng: (span[1] - span[0]) if output.routes.get(eng) else 0 for eng, span in output.engineer_span_min.items()
    }
    mean_load = sum(workloads.values()) / len(workloads) if workloads else 0.0
    workload = workloads.get(engineer_id, 0)

    factors: list[dict] = [
        {
            "code": "skill_match",
            "ok": True,
            "value": required_skills,
            "detail": f"совпадение навыков: {', '.join(required_skills)}" if required_skills else "навыки не требуются",
        },
        {
            "code": "equipment_ok",
            "ok": True,
            "value": required_equipment,
            "detail": (
                f"оборудование в комплекте: {', '.join(required_equipment)}"
                if required_equipment
                else "оборудование не требуется"
            ),
        },
        {
            "code": "sla_margin",
            "ok": margin >= 15,
            "value": margin,
            "detail": f"запас до конца окна {margin} мин",
        },
        {
            "code": "window_tight",
            "ok": window_width >= 90,
            "value": window_width,
            "detail": f"окно {window_width} мин",
        },
        {
            "code": "travel_delta",
            "ok": True,
            "value": None,  # filled by the caller with the real leg value
            "detail": "время в пути от предыдущей точки",
        },
        {
            "code": "load_balance",
            "ok": abs(workload - mean_load) <= 60,
            "value": workload,
            "detail": f"загрузка инженера {workload} мин при средней {round(mean_load)}",
        },
    ]
    return factors


def build_reasons(input_data: SolverInput, output: SolveOutput) -> dict[str, dict]:
    """Build the structured reasons block for the whole plan.

    Args:
        input_data: parsed solver input.
        output: raw solver output (routes, candidates, matrix).

    Returns:
        Map request id → reasons dict (shape in the module docstring).
    """
    requests = {r.id: r for r in input_data.requests}
    reasons: dict[str, dict] = {}

    for visit in output.assignments:
        request = requests[visit.request]
        info = output.candidates[visit.request]

        factors = _assignment_factors(request, output, visit.engineer, visit.eta_min)
        for factor in factors:
            if factor["code"] == "travel_delta":
                factor["value"] = visit.travel_from_prev_min
                factor["detail"] = f"{visit.travel_from_prev_min} мин в пути от предыдущей точки"

        alternatives: list[dict] = []
        request_node = output.request_pos[request.id]
        for engineer_id in sorted(info.feasible):
            if engineer_id == visit.engineer:
                continue
            alternatives.append(
                {
                    "engineer": engineer_id,
                    "blocked": False,
                    "cost_delta": _insertion_delta(output, engineer_id, request_node),
                    "why_not": None,
                }
            )
        alternatives.sort(key=lambda a: a["cost_delta"])
        for engineer_id, code in list(info.blocked.items()):
            if len(alternatives) >= 2:
                break
            alternatives.append({"engineer": engineer_id, "blocked": True, "cost_delta": None, "why_not": code})

        reasons[request.id] = {
            "assignment": {
                "chosen": visit.engineer,
                "factors": factors,
                "alternatives": alternatives[:2],
            },
            "sequence": _swap_deltas(output, visit.engineer, request_node),
        }

    for request_id in output.unassigned_ids:
        info = output.candidates[request_id]
        blocked_top = [{"engineer": eng, "why_not": code} for eng, code in list(info.blocked.items())[:3]]
        reasons[request_id] = {"unassigned": {"why": unassigned_why(request_id, output.candidates), "blocked_top": blocked_top}}

    # Requests the solver neither assigned nor dropped cannot exist; the
    # counts are asserted in tests.
    assert len(reasons) == len(requests), "every request must carry a reasons block"
    return reasons
