"""Read-only fixed-order evaluation using the same costs and policy as the solver."""

from core.contracts import Plan, RouterTaskSnapshot
from core.policy import compile_policy
from core.route_search import RouteEvaluator


def evaluate_manual(snapshot: RouterTaskSnapshot, travel, automatic: Plan, routes: dict) -> dict:
    """Compare explicit request orders on one snapshot; never optimize or change a plan.

    Costs come from the canonical fixed-order evaluator. Missing, duplicate, or foreign
    entities are refused rather than silently omitted. An infeasible order is a
    dispatcher conflict even when no comparable objective value exists.
    """
    evaluator = RouteEvaluator(snapshot, travel)
    engineers = {e.engineer_id for e in evaluator.engineers}
    if set(routes) - engineers:
        raise ValueError("UNKNOWN_MANUAL_ENGINEER")
    jobs = [job for order in routes.values() for job in order]
    if len(jobs) != len(set(jobs)) or set(jobs) - set(evaluator.requests):
        raise ValueError("INVALID_MANUAL_REQUESTS")
    automatic_orders = {
        r.engineer_id: tuple(s.request_id for s in r.stops if s.kind == "job")
        for r in automatic.routes
    }
    if set(automatic_orders) - engineers:
        raise ValueError("AUTOMATIC_ROSTER_CHANGED")
    auto_states = [
        evaluator.evaluate(i, automatic_orders.get(e.engineer_id, ()))
        for i, e in enumerate(evaluator.engineers)
    ]
    if any(state is None for state in auto_states):
        raise ValueError("AUTOMATIC_PLAN_STALE")
    manual_states = [
        evaluator.evaluate(i, tuple(routes.get(e.engineer_id, ())))
        for i, e in enumerate(evaluator.engineers)
    ]
    before = evaluator.score(auto_states, snapshot.policy.policy_id)
    feasible = all(state is not None for state in manual_states)
    after = evaluator.score(manual_states, snapshot.policy.policy_id) if feasible else None
    criteria = compile_policy(snapshot.policy).ordered_criteria
    criterion = (
        next((criteria[i] for i, value in enumerate(before) if after and value != after[i]), None)
        if feasible
        else "constraints"
    )
    return {
        "policy_id": snapshot.policy.policy_id,
        "feasible": feasible,
        "degraded": not feasible or after > before,
        "criterion": criterion,
        "before": list(before),
        "after": list(after) if after is not None else None,
    }
