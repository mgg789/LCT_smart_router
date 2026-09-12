"""CLI entrypoint and top-level composition for the computation core.

Pipeline: JSON file → :class:`core.types.SolverInput` → travel matrix →
OR-Tools model (:mod:`core.model`) → metrics (:mod:`core.metrics`) →
reasons (:mod:`core.reasons`) → :class:`core.types.PlanSolution` → JSON file.

Usage (from the repository root, venv activated)::

    python -m core.solve --input plan.json --output solution.json

Deterministic replay for demos and the golden test::

    python -m core.solve --input plan.json --output solution.json --solution-limit 100
"""

from __future__ import annotations

import argparse
import json

from core import metrics as metrics_mod
from core import model, reasons
from core.types import (
    PlanSolution,
    SolverInput,
    Unassigned,
    solution_to_dict,
    solver_input_from_dict,
)


def solve_task(
    input_data: SolverInput,
    time_limit_ms: int = 1500,
    solution_limit: int | None = None,
    previous_plan: PlanSolution | None = None,
) -> PlanSolution:
    """Run the full planning pipeline (static build or replan).

    Args:
        input_data: parsed solver input.
        time_limit_ms: wall-clock search budget passed to the model.
        solution_limit: deterministic stop (see :func:`core.model.solve`);
            ``None`` keeps the pure time budget.
        previous_plan: plan being re-planned (D-4). When given, the search
            warm-starts from its routes and the metrics carry
            ``moves_vs_prev``; requests absent from the previous plan are
            inserted around the preserved routes.

    Returns:
        Complete plan: assignments, unassigned with reasons, metrics and the
        structured reasons block.
    """
    previous_routes: dict[str, list[str]] | None = None
    if previous_plan is not None:
        previous_routes = {}
        for visit in sorted(previous_plan.assignments, key=lambda a: (a.engineer, a.seq)):
            previous_routes.setdefault(visit.engineer, []).append(visit.request)
    output = model.solve(
        input_data,
        time_limit_ms=time_limit_ms,
        solution_limit=solution_limit,
        previous_routes=previous_routes,
    )
    unassigned = tuple(
        Unassigned(request=req_id, why=reasons.unassigned_why(req_id, output.candidates))
        for req_id in output.unassigned_ids
    )
    return PlanSolution(
        assignments=tuple(output.assignments),
        unassigned=unassigned,
        metrics=metrics_mod.compute_metrics(input_data, output, previous_plan),
        solve_ms=output.solve_ms,
        reasons=reasons.build_reasons(input_data, output),
    )


def main(argv: list[str] | None = None) -> int:
    """CLI: read SolverInput JSON, write PlanSolution JSON, print a summary."""
    parser = argparse.ArgumentParser(description="LCT Smart Router computation core: static plan build.")
    parser.add_argument("--input", required=True, help="SolverInput JSON path (context/14 §3)")
    parser.add_argument("--output", required=True, help="PlanSolution JSON path")
    parser.add_argument("--time-limit-ms", type=int, default=1500)
    parser.add_argument("--solution-limit", type=int, default=None, help="deterministic stop for demos/tests")
    args = parser.parse_args(argv)

    with open(args.input, encoding="utf-8") as fh:
        input_data = solver_input_from_dict(json.load(fh))
    solution = solve_task(input_data, time_limit_ms=args.time_limit_ms, solution_limit=args.solution_limit)

    raw = solution_to_dict(solution)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(raw, fh, ensure_ascii=False, indent=2)

    m = solution.metrics
    print(
        f"plan for {input_data.date}: assigned {m.assigned}/{m.requests_total}, "
        f"sla_ok {m.sla_ok_pct}%, travel {m.travel_min_total} min, "
        f"wait {m.wait_min_total} min, solve {solution.solve_ms} ms"
    )
    for u in solution.unassigned:
        print(f"  unassigned {u.request}: {u.why}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
