"""Benchmark semantic comparisons must retain all quality-changing fields."""

from core.redis_benchmark import digest


def test_digest_ignores_timing_but_retains_routes_and_metrics():
    result = {
        "computed_at": 1,
        "calculation_ms": 20,
        "routes": ["a", "b"],
        "summary": {"distance_km": 5, "assigned_requests": 2},
    }
    assert digest(result) == digest({**result, "computed_at": 99, "calculation_ms": 50})
    assert digest(result) != digest({**result, "routes": ["b", "a"]})
    assert digest(result) != digest({**result, "summary": {"distance_km": 4}})
