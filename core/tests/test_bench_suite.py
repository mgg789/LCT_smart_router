"""Benchmark suite helpers: business metrics, gaps and micro-instance building."""

from core.baselines import greedy_nearest
from core.bench_suite import (
    _add_fifo_deltas,
    _gap_vs_exact,
    _micro_instance,
    _run_exact_gap,
    _strategy_row,
)
from core.engine import SearchSettings
from core.exact_gap import ExactResult
from core.geo import GraphTravel

START = 1786946400


def _exact(unassigned=0, engineers=1, travel=180, status="optimal"):
    return ExactResult(
        status=status,
        unassigned_count=unassigned,
        engineers_used=engineers,
        travel_time_sec=travel,
        routes={},
        route_builds=10,
        elapsed_sec=0.01,
    )


def test_strategy_row_derives_business_quantities(graph, snapshot):
    plan = greedy_nearest(snapshot, GraphTravel(graph))
    row = _strategy_row("greedy_nearest", plan, 12.5)
    assert row["coverage_pct"] == 100.0
    assert row["assigned_count"] == 3
    assert row["travel_per_order_sec"] == round(plan.summary.travel_time_sec / 3)
    assert row["plan_sha256"]


def test_add_fifo_deltas_marks_relative_changes():
    rows = [
        {
            "strategy": "fifo",
            "assigned_count": 2,
            "travel_per_order_sec": 100,
        },
        {
            "strategy": "router",
            "assigned_count": 4,
            "travel_per_order_sec": 75,
        },
    ]
    result = _add_fifo_deltas(rows)
    router = next(row for row in result if row["strategy"] == "router")
    assert router["assigned_delta_vs_fifo"] == 2
    assert router["travel_per_order_delta_pct_vs_fifo"] == -25.0
    fifo_row = result[0]
    assert fifo_row["assigned_delta_vs_fifo"] == 0


def test_gap_vs_exact_zero_when_objective_matches():
    row = {
        "strategy": "router",
        "unassigned_count": 0,
        "engineers_used": 2,
        "travel_time_sec": 184,
        "elapsed_ms": 5.0,
    }
    gap = _gap_vs_exact(row, _exact(unassigned=0, engineers=2, travel=180))
    assert gap["objective_equal_to_exact"] is True
    assert gap["travel_gap_pct"] == 2.22


def test_gap_vs_exact_flags_coverage_shortfall():
    row = {
        "strategy": "greedy_nearest",
        "unassigned_count": 1,
        "engineers_used": 1,
        "travel_time_sec": 60,
        "elapsed_ms": 3.0,
    }
    gap = _gap_vs_exact(row, _exact(unassigned=0, engineers=2, travel=180))
    assert gap["objective_equal_to_exact"] is False
    assert gap["travel_gap_pct"] is None


def test_exact_gap_integration_on_official_east(official_east_scenario, official_east_run):
    """One small east-derived instance: exact optimum bounds every heuristic."""
    rows = _run_exact_gap(
        official_east_scenario,
        official_east_run,
        SearchSettings(time_limit_ms=3000, solution_limit=8),
        instances=({"name": "test-2x5", "engineers": 2, "requests": 5},),
        max_route_builds=500_000,
    )
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == "optimal"
    assert row["requests"] == 5
    exact_travel = row["exact"]["travel_time_sec"]
    assert exact_travel > 0
    for heuristic in row["heuristics"]:
        assert (heuristic["unassigned_count"], heuristic["travel_time_sec"]) >= (
            row["exact"]["unassigned_count"],
            exact_travel,
        )


def test_micro_instance_is_lunchless_and_small(official_east_scenario, official_east_run):
    snapshot = _micro_instance(
        official_east_scenario,
        official_east_run,
        engineer_count=2,
        request_cap=5,
    )
    assert snapshot is not None
    assert len(snapshot.requests) == 5
    assert len(snapshot.engineers) == 2
    assert all(
        not engineer.lunch.enabled or engineer.lunch_taken for engineer in snapshot.engineers
    )
