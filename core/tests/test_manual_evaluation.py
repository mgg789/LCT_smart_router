"""Manual alert evidence must recompute routes, never compare copied UI metrics."""

import pytest
from core.geo import GraphTravel
from core.manual_evaluation import evaluate_manual
from core.route_search import RouteEvaluator


@pytest.mark.parametrize("policy_id", ["fast", "compact", "sla", "balanced", "eco", "covering"])
def test_manual_order_costs_and_coverage(snapshot, graph, policy_id):
    task = snapshot.model_copy(
        update={"policy": snapshot.policy.model_copy(update={"policy_id": policy_id})}
    )
    travel = GraphTravel(graph)
    evaluator = RouteEvaluator(task, travel)
    jobs = ("job-1", "job-2", "job-3")
    automatic = evaluator.materialize([evaluator.evaluate(0, jobs)])
    assert automatic is not None
    unchanged = evaluate_manual(task, travel, automatic, {"eng-1": list(jobs)})
    assert unchanged["degraded"] is False
    reversed_order = evaluate_manual(task, travel, automatic, {"eng-1": list(reversed(jobs))})
    assert reversed_order["degraded"] is True
    assert reversed_order["before"] != reversed_order["after"]
    assert evaluate_manual(task, travel, automatic, {})["degraded"] is True


def test_rejects_duplicate_or_foreign_manual_requests(snapshot, graph):
    travel = GraphTravel(graph)
    evaluator = RouteEvaluator(snapshot, travel)
    automatic = evaluator.materialize([evaluator.evaluate(0, ("job-1",))])
    with pytest.raises(ValueError, match="INVALID_MANUAL_REQUESTS"):
        evaluate_manual(snapshot, travel, automatic, {"eng-1": ["job-1", "job-1"]})
    with pytest.raises(ValueError, match="UNKNOWN_MANUAL_ENGINEER"):
        evaluate_manual(snapshot, travel, automatic, {"unknown": ["job-1"]})
