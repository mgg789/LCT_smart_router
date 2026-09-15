"""Golden determinism gate (context/27 §10, solver slice).

The mini scenario (``core.gen`` seed 42) is the golden dataset: fixed seed,
saved reference plan. The gate asserts:

1. three consecutive solves produce byte-identical plans (``solve_ms`` is
   excluded — it measures wall clock, not the plan);
2. the plan matches the committed snapshot ``golden/mini_solution.json`` —
   any change to the model or matrix that shifts the plan must be
   intentional and land together with a regenerated snapshot plus an
   explanation in the commit body;
3. the golden plan covers all 10 requests with sla_ok_pct == 100.
"""

from __future__ import annotations

import json
from pathlib import Path

from core.solve import solve_task
from core.types import solution_to_dict, solver_input_from_dict

GOLDEN_DIR = Path(__file__).parent / "golden"
SOLVE_KWARGS = {"time_limit_ms": 1500, "solution_limit": 100}


def _solve():
    """Solve the committed golden input with the pinned search parameters."""
    with open(GOLDEN_DIR / "mini_input.json", encoding="utf-8") as fh:
        input_data = solver_input_from_dict(json.load(fh))
    return solve_task(input_data, **SOLVE_KWARGS)


def _plan_without_wallclock(solution) -> dict:
    """Serialized plan with the wall-clock measurement stripped."""
    raw = solution_to_dict(solution)
    raw.pop("solve_ms")
    return raw


def test_three_consecutive_runs_identical():
    runs = [json.dumps(_plan_without_wallclock(_solve()), sort_keys=True) for _ in range(3)]
    assert len(set(runs)) == 1


def test_plan_matches_golden_snapshot():
    golden = json.loads((GOLDEN_DIR / "mini_solution.json").read_text(encoding="utf-8"))
    assert _plan_without_wallclock(_solve()) == golden


def test_golden_plan_quality():
    solution = _solve()
    assert solution.metrics.assigned == 10
    assert solution.metrics.unassigned == 0
    assert solution.metrics.sla_ok_pct == 100.0
    assert solution.solve_ms < 2000
