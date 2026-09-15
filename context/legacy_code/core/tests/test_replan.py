"""Replanning tests: warm start from the previous plan + plan diff (D-4)."""

from __future__ import annotations

import copy
import json

from core.gen import generate
from core.model import solve
from core.solve import solve_task
from core.types import solution_to_dict, solver_input_from_dict

NEW_REQUEST = {
    "id": "req_new_001",
    "lat": 55.7600,
    "lon": 37.6250,
    "window": ["12:00", "15:00"],
    "window_strict": False,
    "service_min": 30,
    "required_skills": ["video"],
    "required_equipment": {"stb": 1},
    "allowed_vehicle_classes": ["any"],
    "priority": "std",
}


def _plan_signature(solution) -> str:
    raw = solution_to_dict(solution)
    raw.pop("solve_ms")
    return json.dumps(raw, sort_keys=True)


def _mini_input():
    return solver_input_from_dict(generate("mini", 42))


def test_warm_start_engages_and_adds_request():
    plan1 = solve_task(_mini_input(), time_limit_ms=1500, solution_limit=100)
    data2 = generate("mini", 42)
    data2["requests"].append(copy.deepcopy(NEW_REQUEST))
    inp2 = solver_input_from_dict(data2)

    output = solve(inp2, time_limit_ms=1500, solution_limit=100, previous_routes={"eng_01": ["req_001"]})
    assert output.warm_started is True

    plan2 = solve_task(inp2, time_limit_ms=1500, solution_limit=100, previous_plan=plan1)
    assert plan2.metrics.assigned == 11
    assert "req_new_001" in {a.request for a in plan2.assignments}
    assert plan2.metrics.moves_vs_prev["reassigned"] >= 0  # keys always present
    assert "shifted" in plan2.metrics.moves_vs_prev
    # every previously assigned request survives the replan
    assert {a.request for a in plan1.assignments} <= {a.request for a in plan2.assignments}


def test_warm_start_replan_is_deterministic():
    plan1 = solve_task(_mini_input(), time_limit_ms=1500, solution_limit=100)
    data2 = generate("mini", 42)
    data2["requests"].append(copy.deepcopy(NEW_REQUEST))
    inp2 = solver_input_from_dict(data2)

    runs = [
        _plan_signature(solve_task(inp2, time_limit_ms=1500, solution_limit=100, previous_plan=plan1))
        for _ in range(3)
    ]
    assert len(set(runs)) == 1


def test_warm_start_quality_matches_cold_start_on_mini():
    # The seed routes are feasible, so warm start must not lose anything:
    # same request set, same count of served requests.
    data2 = generate("mini", 42)
    data2["requests"].append(copy.deepcopy(NEW_REQUEST))
    inp2 = solver_input_from_dict(data2)
    cold = solve_task(inp2, time_limit_ms=1500, solution_limit=100)
    plan1 = solve_task(_mini_input(), time_limit_ms=1500, solution_limit=100)
    warm = solve_task(inp2, time_limit_ms=1500, solution_limit=100, previous_plan=plan1)
    assert cold.metrics.assigned == warm.metrics.assigned == 11


def test_cancel_request_returns_to_previous_size():
    plan1 = solve_task(_mini_input(), time_limit_ms=1500, solution_limit=100)
    data2 = generate("mini", 42)
    data2["requests"].append(copy.deepcopy(NEW_REQUEST))
    data2["requests"] = [r for r in data2["requests"] if r["id"] != "req_005"]
    inp2 = solver_input_from_dict(data2)
    plan2 = solve_task(inp2, time_limit_ms=1500, solution_limit=100, previous_plan=plan1)
    assert plan2.metrics.requests_total == 10
    assert plan2.metrics.assigned == 10
    assert "req_005" not in {a.request for a in plan2.assignments}


def test_shifted_counts_eta_drift_threshold():
    from core.metrics import SHIFTED_ETA_MIN

    assert SHIFTED_ETA_MIN == 5
