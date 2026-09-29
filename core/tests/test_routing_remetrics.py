"""Regression gates for endpoint auditing and fail-closed benchmark evidence."""

import runpy
from pathlib import Path

import pytest
from core.contracts import GeoPoint
from core.engine import SearchSettings
from core.geo import GraphTravel, configure_travel
from core.schedule import baseline
from lab.audit_graph_coverage import endpoint_error_m
from lab.audit_remetrics_plans import audit_case
from lab.remetrics_sensitivity import stress

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "docs/benchmarks/routing-remetrics-20260929/run_remetrics.py"


def test_coverage_detects_outside_graph_endpoint():
    requested = GeoPoint(lat=54.8041762, lon=38.2768274)
    assert endpoint_error_m(requested, [[55.575185, 37.695016]], -1) > 90_000
    assert endpoint_error_m(requested, [[requested.lat, requested.lon]], -1) == 0


def test_verified_baseline_rejects_nonconvergence(monkeypatch, snapshot, graph):
    module = runpy.run_path(str(RUNNER))
    function = module["verified_baseline"]
    monkeypatch.setitem(
        function.__globals__,
        "verify_plan_with_route3",
        lambda *a, **kw: {
            "new_legs": 1,
            "corrections": {},
            "verified_legs": 1,
        },
    )
    settings = SearchSettings(strict_time_windows=True)
    travel = configure_travel(GraphTravel(graph), settings.technical(), snapshot.planning_as_of)
    with pytest.raises(RuntimeError, match="BASELINE_VERIFY_ROUNDS_EXHAUSTED"):
        function(baseline, snapshot, travel, settings, object())


def test_plan_evidence_preserves_assignments_and_times(snapshot, graph):
    module = runpy.run_path(str(RUNNER))
    plan = baseline(snapshot, GraphTravel(graph))
    evidence = module["redacted_plan"](plan)
    assert len(evidence["assignments"]) == len(plan.assignments)
    assert evidence["plan_sha256"] == module["metrics_row"]("fifo", plan, 0)["plan_sha256"]
    assert evidence["routes"][0]["stops"][0]["end_at"] == plan.routes[0].stops[0].end_at


def test_selected_leg_audit_rejects_bad_endpoint(snapshot, graph):
    module = runpy.run_path(str(RUNNER))
    plan = baseline(snapshot, GraphTravel(graph))

    class Client:
        def route(self, origin, destination, profile, **kwargs):
            return {
                "mode": "road", "duration_s": 60, "distance_m": 100,
                "geometry": [[origin.lat, origin.lon], [54.0, 38.0]],
            }

    result = audit_case({
        "snapshot": snapshot.model_dump(), "settings": SearchSettings().__dict__,
        "evidence": {"fifo_verified": module["redacted_plan"](plan)},
    }, Client())
    assert any(row["code"] == "GRAPH_ENDPOINT" for row in result["fifo_verified"]["violations"])


def test_stress_absorbs_wait_before_propagating_service_delay():
    case = {"settings": {"access_buffer_sec": 0}, "snapshot": {
        "requests": [{"request_id": "r", "service_duration_sec": 100, "window_end_at": 230}],
        "engineers": [{"engineer_id": "e", "shift_end_at": 1000}],
    }}
    plan = {"routes": [{"engineer_id": "e", "legs": [{
        "to_stop_id": "w", "distance_km": 0.1, "travel_time_sec": 60,
    }], "stops": [
        {"stop_id": "w", "kind": "wait", "start_at": 60, "end_at": 100},
        {"stop_id": "j", "kind": "job", "request_id": "r", "start_at": 100, "end_at": 200},
    ]}]}
    assert stress(case, plan, 1, 1)["late_jobs"] == 0
    assert stress(case, plan, 2, 1)["late_jobs"] == 0
    assert stress(case, plan, 1, 2)["max_lateness_sec"] == 70
    assert stress(case, plan, 2, 2)["max_lateness_sec"] == 90
