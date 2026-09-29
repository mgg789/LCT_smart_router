"""Benchmark semantic comparisons must retain all quality-changing fields."""

import pytest
from core.redis_benchmark import digest, route3_evidence


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


def test_route3_trial_rejects_silent_fallback():
    for result in ({}, {"verification": None}, {"verification": {"verified_legs": 0}}):
        with pytest.raises(RuntimeError, match="ROUTE3_VERIFICATION_MISSING"):
            route3_evidence(result, required=True)
    assert route3_evidence({}, required=False)["verified_legs"] == 0


def test_route3_evidence_keeps_route_drift():
    report = {"verified_legs": 2, "routes": [{"corrected_duration_sec": 123}]}
    evidence = route3_evidence({"verification": report}, required=True)
    assert evidence["verified_legs"] == 2
    assert evidence["routes"] == report["routes"]
    assert evidence["report_digest"] != digest({**report, "routes": []})
