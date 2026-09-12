"""Plan metrics (context/14 §4 subset) computed from raw solver output.

Definitions used across the product (documented in docs/solver.md):

- ``sla_ok_pct`` counts every request: a request left unassigned is not OK;
- ``late_total_min`` sums positive ``(eta − window_close)`` over assigned
  requests (service start after the window);
- ``sla_at_risk`` counts assigned requests arriving within 15 min of the
  window close;
- ``travel_min_total`` includes return legs to end depots, which assignment
  rows do not carry;
- ``workload_min`` is the occupied span (travel + wait + service) between a
  engineer's departure and return; idle engineers contribute 0;
- ``balance_std_min`` is the population std-dev over ALL engineers, idle
  included — the demo needs to show imbalance honestly.
"""

from __future__ import annotations

import statistics

from core.model import SolveOutput
from core.types import Metrics, SolverInput


def compute_metrics(input_data: SolverInput, output: SolveOutput) -> Metrics:
    """Aggregate the solved routes into the plan metrics object.

    Args:
        input_data: parsed solver input (windows, shifts).
        output: raw solver output from :func:`core.model.solve`.

    Returns:
        Populated :class:`core.types.Metrics`.
    """
    requests = {r.id: r for r in input_data.requests}
    assigned = len(output.assignments)
    total = len(requests)

    late_total = 0
    late_count = 0
    at_risk = 0
    for visit in output.assignments:
        window_close = requests[visit.request].window_close_min
        delay = visit.eta_min - window_close
        if delay > 0:
            late_total += delay
            late_count += 1
        elif window_close - visit.eta_min < 15:
            at_risk += 1
    sla_ok_pct = 100.0 * (total - late_count - len(output.unassigned_ids)) / total if total else 0.0

    travel_total = sum(v.travel_from_prev_min for v in output.assignments) + sum(
        t for t in output.return_travel_min.values()
    )

    workload: dict[str, int] = {}
    makespan = 0
    for engineer in input_data.engineers:
        span_start, span_end = output.engineer_span_min.get(engineer.id, (engineer.shift_start_min, engineer.shift_start_min))
        occupied = max(0, span_end - span_start) if output.routes.get(engineer.id) else 0
        workload[engineer.id] = occupied
        makespan = max(makespan, max(0, span_end - engineer.shift_start_min) if output.routes.get(engineer.id) else 0)

    return Metrics(
        requests_total=total,
        assigned=assigned,
        unassigned=total - assigned,
        sla_ok_pct=round(sla_ok_pct, 1),
        sla_at_risk=at_risk,
        late_total_min=late_total,
        travel_min_total=travel_total,
        travel_min_mean_per_eng=round(travel_total / len(input_data.engineers), 1) if input_data.engineers else 0.0,
        workload_min=workload,
        balance_std_min=round(statistics.pstdev(list(workload.values())), 1) if workload else 0.0,
        makespan_min=makespan,
        wait_min_total=sum(v.wait_min for v in output.assignments),
    )
