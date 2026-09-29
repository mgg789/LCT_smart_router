"""Live route-engine3 benchmark and endpoint coverage audit.

This runner deliberately keeps the official dataset identity and the route3
version snapshot in its output.  It emits redacted plan evidence (request IDs,
times and metrics; no street addresses) together with route3 endpoint snap
diagnostics.  Quality numbers for a region are marked raw when route3 geometry
does not stay within the declared endpoint tolerance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import resource
import subprocess
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from core.baselines import greedy_nearest, greedy_urgency
from core.contracts import Plan
from core.engine import SearchSettings, apply_system_policy, solve
from core.geo import configure_travel
from core.hybrid import _unwrap_technical, hybrid_plan
from core.official import combine_official_scenarios, load_official_region
from core.planning_travel import planning_travel
from core.route3 import (
    VerifiedRoute3,
    route3_from_env,
    verify_plan_with_route3,
)
from core.schedule import baseline as fifo_baseline
from core.schedule import validate_plan

ROOT = Path(__file__).resolve().parents[3]
DATASET = ROOT / "data/dataset/anonymized"
REGIONS = ("east", "southeast", "south_central")
SNAP_TOLERANCE_M = 250.0


def sha256(path: Path) -> str:
    """Return the content hash used to identify an input artifact."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plan_hash(plan: Plan) -> str:
    """Return a stable hash for exact repeat comparisons."""
    return hashlib.sha256(plan.model_dump_json().encode()).hexdigest()


def redacted_plan(plan: Plan) -> dict[str, Any]:
    """Serialize assignments, schedules and leg geometry without street addresses."""
    return {
        "plan_sha256": plan_hash(plan),
        "summary": plan.summary.model_dump(),
        "assignments": [row.model_dump() for row in plan.assignments],
        "routes": [
            {
                "engineer_id": route.engineer_id,
                "legs": [leg.model_dump() for leg in route.legs],
                "stop_ids": [
                    stop.request_id for stop in route.stops if stop.kind == "job"
                ],
                "stops": [
                    {
                        "stop_id": stop.stop_id,
                        "request_id": stop.request_id,
                        "kind": stop.kind,
                        "arrival_at": stop.arrival_at,
                        "start_at": stop.start_at,
                        "end_at": stop.end_at,
                    }
                    for stop in route.stops
                ],
            }
            for route in plan.routes
        ],
    }


def metrics_row(name: str, plan: Plan, elapsed_ms: float) -> dict[str, Any]:
    """Flatten business metrics for publication tables."""
    summary = plan.summary
    return {
        "strategy": name,
        "usable": plan.is_usable,
        "elapsed_ms": round(elapsed_ms, 1),
        "requests_total": summary.requests_total,
        "assigned_count": summary.assigned_count,
        "coverage_pct": round(summary.assigned_count * 100 / summary.requests_total, 1)
        if summary.requests_total
        else None,
        "urgent_total": summary.urgent_total,
        "urgent_assigned_count": summary.urgent_assigned_count,
        "unassigned_count": summary.unassigned_count,
        "late_assigned_count": summary.late_assigned_count,
        "total_lateness_sec": summary.total_lateness_sec,
        "travel_time_sec": summary.travel_time_sec,
        "distance_km": summary.distance_km,
        "engineers_used": summary.engineers_used,
        "min_window_slack_sec": summary.min_window_slack_sec,
        "plan_sha256": plan_hash(plan),
    }


def verified_baseline(planner, snapshot, travel, settings, client):
    """Apply the same fail-closed verify/replan loop to an independent greedy planner."""
    corrections = {}
    provider = travel
    for _ in range(33):
        plan = planner(snapshot, provider)
        report = verify_plan_with_route3(
            client,
            snapshot,
            plan,
            metro=settings.metro_enabled,
            traffic=settings.traffic_enabled,
            known=corrections,
            technical=settings.technical(),
        )
        if not report["new_legs"]:
            validate_plan(snapshot, plan, provider)
            return plan, report
        corrections = report["corrections"]
        provider = configure_travel(
            VerifiedRoute3(_unwrap_technical(travel), corrections),
            settings.technical(),
            snapshot.planning_as_of,
        )
    raise RuntimeError("BASELINE_VERIFY_ROUNDS_EXHAUSTED")


def run_case(scenario, client, settings, *, covered=False, matrix_only=False):
    """Record failures and separate preparation, matrix estimates and verified plans."""
    snapshot = apply_system_policy(scenario.snapshot, settings)
    started = time.perf_counter()
    travel = planning_travel(scenario.graph, settings, snapshot)
    result = {
        "requests": len(snapshot.requests),
        "crews": len(snapshot.engineers),
        "settings": settings.__dict__,
        "covered_subset": covered,
        "prepare_ms": round((time.perf_counter() - started) * 1000, 1),
        "metrics": [],
        "evidence": {},
        "failures": [],
        "snapshot": snapshot.model_dump(),
        "snapshot_sha256": hashlib.sha256(
            snapshot.model_dump_json().encode()
        ).hexdigest(),
    }
    for name, planner in (
        ("fifo", fifo_baseline),
        ("greedy_nearest", greedy_nearest),
        ("greedy_urgency", greedy_urgency),
    ):
        tick = time.perf_counter()
        plan = planner(snapshot, travel)
        validate_plan(snapshot, plan, travel)
        result["metrics"].append(
            metrics_row(name + "_matrix", plan, (time.perf_counter() - tick) * 1000)
        )
    for index in range(3):
        tick = time.perf_counter()
        output = solve(snapshot, travel, settings)
        validate_plan(output.memory.snapshot, output.main, travel)
        result["metrics"].append(
            metrics_row(
                f"router_matrix_repeat_{index + 1}",
                output.main,
                (time.perf_counter() - tick) * 1000,
            )
        )
        if index == 0:
            result["evidence"]["router_matrix"] = redacted_plan(output.main)
    if matrix_only:
        result["publication_status"] = "MATRIX_ESTIMATE_NOT_ROUTE_VERIFIED"
        return result
    if not covered:
        result["publication_status"] = "INVALID_GRAPH_COVERAGE_RAW_DIAGNOSTIC_ONLY"
        return result
    for name, planner in (
        ("fifo_verified", fifo_baseline),
        ("router_hybrid_verified", None),
    ):
        tick = time.perf_counter()
        try:
            if planner is None:
                run = hybrid_plan(snapshot, travel, settings, None, None, client=client)
                plan, report = run.output.main, run.verification
                validate_plan(run.output.memory.snapshot, plan, run.provider)
            else:
                plan, report = verified_baseline(
                    planner, snapshot, travel, settings, client
                )
            row = metrics_row(name, plan, (time.perf_counter() - tick) * 1000)
            row["verified_pairs_all_rounds"] = report["verified_legs"]
            row["selected_legs"] = sum(len(route.legs) for route in plan.routes)
            row["new_legs_last_round"] = report["new_legs"]
            row["leg_sources"] = dict(
                __import__("collections").Counter(
                    leg.travel_source for route in plan.routes for leg in route.legs
                )
            )
            result["metrics"].append(row)
            result["evidence"][name] = redacted_plan(plan)
            result["evidence"][name]["verification_routes"] = report["routes"]
        except Exception as exc:  # noqa: BLE001 — retain every failed benchmark case
            result["failures"].append(
                {
                    "strategy": name,
                    "code": getattr(exc, "code", type(exc).__name__),
                    "elapsed_ms": round((time.perf_counter() - tick) * 1000, 1),
                }
            )
        print(
            name,
            result["metrics"][-1].get("assigned_count"),
            result["failures"],
            flush=True,
        )
    from lab.audit_remetrics_plans import audit_case

    result["selected_leg_audit"] = audit_case(result, client)
    for strategy, audit in result["selected_leg_audit"].items():
        if audit["violations"]:
            result["failures"].append({"strategy": strategy, "code": "SELECTED_LEG_AUDIT_FAILED"})
    result["publication_status"] = "VERIFIED" if not result["failures"] else "PARTIAL"
    return result


def main() -> None:
    """Checkpoint every scenario so slow or failed verification never erases evidence."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--coverage", type=Path, required=True)
    parser.add_argument("--budget-ms", type=int, default=3000)
    parser.add_argument("--tolerant", action="store_true")
    parser.add_argument("--matrix-only", action="store_true")
    parser.add_argument("--solution-limit", type=int, default=10000)
    parser.add_argument("--regions", nargs="+", default=[*REGIONS, "all"])
    args = parser.parse_args()
    # Fix the weather scenario; current live weather is not historical August weather.
    from core import weather

    weather._memory = (
        time.time(),
        weather.WeatherSnapshot(0, None, 0, "clear", "Ясно", 1.0),
    )
    client = route3_from_env()
    if client is None:
        raise SystemExit("ROUTE3_URL is required")
    coverage = json.loads(args.coverage.read_text())
    versions = client.ensure_versions()
    if versions != coverage["versions"]:
        raise SystemExit("COVERAGE_GRAPH_VERSION_MISMATCH")
    settings = SearchSettings(
        time_limit_ms=args.budget_ms,
        solution_limit=args.solution_limit,
        strict_time_windows=not args.tolerant,
        metro_enabled=True,
    )
    scenarios = {name: load_official_region(DATASET, name) for name in REGIONS}
    covered = {
        name: replace(
            scenario,
            snapshot=scenario.snapshot.model_copy(
                update={
                    "requests": [
                        r
                        for r in scenario.snapshot.requests
                        if r.request_id
                        in coverage["summary"][name]["accepted_request_ids"]
                    ]
                }
            ),
        )
        for name, scenario in scenarios.items()
    }
    scenarios["all"] = combine_official_scenarios(list(scenarios.values()))
    covered["all"] = combine_official_scenarios(list(covered.values()))
    payload = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "host": {"python": platform.python_version(), "platform": platform.platform()},
        "weather_scenario": {"kind": "clear", "multiplier": 1.0},
        "versions": versions,
        "coverage_sha256": sha256(args.coverage),
        "runner_sha256": sha256(Path(__file__)),
        "coverage_summary": coverage["summary"],
        "coverage_threshold_m": coverage["threshold_m"],
        "git_parents": [
            subprocess.check_output(
                ["git", "rev-parse", ref], cwd=ROOT, text=True
            ).strip()
            for ref in ("HEAD", "dev")
        ],
        "source_hashes": {
            str(p.relative_to(ROOT)): sha256(p)
            for pattern in (
                "core/*.py",
                "core/scenarios/*/*.json",
                "services/route-engine3/*.py",
            )
            for p in sorted(ROOT.glob(pattern))
        },
        "cases": {},
    }
    for name in args.regions:
        case = scenarios[name]
        if len(case.snapshot.requests) != len(covered[name].snapshot.requests):
            print("raw full", name, flush=True)
            payload["cases"][name + "_raw_full"] = run_case(
                case, client, settings, covered=False
            )
        print("covered", name, flush=True)
        payload["cases"][name] = run_case(
            covered[name], client, settings, covered=True, matrix_only=args.matrix_only
        )
        payload["cases"][name]["original_request_count"] = len(case.snapshot.requests)
        payload["cases"][name]["excluded_count"] = len(case.snapshot.requests) - len(
            covered[name].snapshot.requests
        )
        payload["checkpoint_at"] = datetime.now(timezone.utc).isoformat()
        payload["python_peak_rss_bytes"] = resource.getrusage(
            resource.RUSAGE_SELF
        ).ru_maxrss * (1 if platform.system() == "Darwin" else 1024)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print("saved", args.output, name, flush=True)


if __name__ == "__main__":
    main()
