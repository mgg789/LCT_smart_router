"""Comprehensive deterministic benchmark suite for the Router core.

One runner emits one JSON document per host. Sections: strategy baselines
(exact FIFO, two greedy heuristics, the OR-Tools Router) with derived business
metrics, the policy catalog comparison, a solution-budget quality curve,
replanning-event latency and stability, warm-versus-cold replanning, exact
micro-instance gaps, Monte-Carlo plan robustness and a repeat-determinism
check. Everything runs offline on versioned official scenarios with fixed
budgets, so two hosts perform identical work and only the hardware differs.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import time as monotonic_time
from dataclasses import replace
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import ortools

from core.baselines import engineer_routes, greedy_nearest, greedy_urgency
from core.benchmark import (
    _with_new_request,
    project_remaining_snapshot,
    run_official_benchmark,
    run_replanning_events,
)
from core.contracts import Plan, RouterTaskSnapshot
from core.engine import SearchSettings, solve
from core.exact_gap import ExactResult, exact_micro
from core.geo import GraphTravel, configure_travel, routing_context_version
from core.official import OfficialScenario, Region, combine_official_scenarios, load_official_region
from core.robustness import predict_situation
from core.schedule import baseline as fifo_baseline

_STRATEGY_FIFO = "fifo"
_STRATEGY_NEAREST = "greedy_nearest"
_STRATEGY_URGENT = "greedy_urgency"
_STRATEGY_ROUTER = "router"
_STRATEGY_ROUTER_STATIC = "router_static"


def _machine_meta(label: str) -> dict:
    """Identify the measuring host so cross-host tables can name their columns."""
    meta: dict[str, Any] = {
        "label": label,
        "python": platform.python_version(),
        "os": platform.platform(),
        "machine": platform.machine(),
        "cpu_cores": os.cpu_count(),
        "ortools": ortools.__version__,
    }
    try:
        if platform.system() == "Darwin":
            meta["cpu"] = subprocess.check_output(
                ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
            ).strip()
            meta["mem_gb"] = round(
                int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip())
                / 1024**3
            )
        else:
            for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
                if line.startswith("model name"):
                    meta["cpu"] = line.split(":", 1)[1].strip()
                    break
            for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
                if line.startswith("MemTotal"):
                    meta["mem_gb"] = round(int(line.split()[1]) / 1024**2)
                    break
    except OSError:
        pass
    except subprocess.SubprocessError:
        pass
    except ValueError:
        pass
    return meta


def _plan_hash(plan: Plan) -> str:
    """Stable content hash of a plan for repeat and cross-host determinism."""
    return hashlib.sha256(plan.model_dump_json().encode("utf-8")).hexdigest()


def _strategy_row(name: str, plan: Plan, elapsed_ms: float) -> dict:
    """Flat metrics plus derived per-order business quantities for one plan."""
    summary = plan.summary
    assigned = summary.assigned_count
    total = summary.requests_total
    urgent = summary.urgent_total
    row: dict[str, Any] = {
        "strategy": name,
        "is_usable": plan.is_usable,
        "elapsed_ms": round(elapsed_ms, 1),
        "requests_total": total,
        "assigned_count": assigned,
        "coverage_pct": round(100 * assigned / total, 1) if total else None,
        "urgent_total": urgent,
        "urgent_assigned_count": summary.urgent_assigned_count,
        "urgent_coverage_pct": (
            round(100 * summary.urgent_assigned_count / urgent, 1) if urgent else None
        ),
        "unassigned_count": summary.unassigned_count,
        "engineers_used": summary.engineers_used,
        "late_assigned_count": summary.late_assigned_count,
        "total_lateness_sec": summary.total_lateness_sec,
        "travel_time_sec": summary.travel_time_sec,
        "travel_per_order_sec": round(summary.travel_time_sec / assigned) if assigned else None,
        "distance_km": summary.distance_km,
        "distance_per_order_km": round(summary.distance_km / assigned, 2) if assigned else None,
        "work_time_sec": summary.work_time_sec,
        "waiting_time_sec": summary.waiting_time_sec,
        "workload_spread_sec": summary.workload_spread_sec,
        "max_workload_sec": summary.max_workload_sec,
        "min_window_slack_sec": summary.min_window_slack_sec,
    }
    row["plan_sha256"] = _plan_hash(plan)
    return row


def _add_fifo_deltas(rows: list[dict]) -> list[dict]:
    """Attach per-order travel and coverage deltas relative to the FIFO row."""
    fifo = next((row for row in rows if row["strategy"] == _STRATEGY_FIFO), None)
    if fifo is None or not fifo["assigned_count"]:
        return rows
    for row in rows:
        row["assigned_delta_vs_fifo"] = row["assigned_count"] - fifo["assigned_count"]
        if row["travel_per_order_sec"] and fifo["travel_per_order_sec"]:
            row["travel_per_order_delta_pct_vs_fifo"] = round(
                100
                * (row["travel_per_order_sec"] - fifo["travel_per_order_sec"])
                / fifo["travel_per_order_sec"],
                1,
            )
    return rows


def _run_strategies(scenario, settings: SearchSettings) -> tuple[list[dict], Any, Any, float]:
    """Time every strategy on one scenario; return rows plus the router output.

    The router row runs the product path with the departure-time traffic
    forecast enabled; ``router_static`` reruns the same solve on the static
    matrix (forecast disabled), which is also the policy-catalog context. The
    pair makes the cost of the traffic forecast measurable per region.
    """
    travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
    )
    rows = []
    for name, planner in (
        (_STRATEGY_FIFO, fifo_baseline),
        (_STRATEGY_NEAREST, greedy_nearest),
        (_STRATEGY_URGENT, greedy_urgency),
    ):
        started = monotonic_time.perf_counter()
        plan = planner(scenario.snapshot, travel)
        rows.append(_strategy_row(name, plan, (monotonic_time.perf_counter() - started) * 1000))
    started = monotonic_time.perf_counter()
    run = run_official_benchmark(scenario, settings, event_settings=None)
    router_elapsed_ms = (monotonic_time.perf_counter() - started) * 1000
    rows.append(_strategy_row(_STRATEGY_ROUTER, run.output.main, router_elapsed_ms))
    started = monotonic_time.perf_counter()
    static = solve(
        scenario.snapshot,
        travel,
        replace(settings, traffic_enabled=False),
    )
    static_elapsed_ms = (monotonic_time.perf_counter() - started) * 1000
    rows.append(_strategy_row(_STRATEGY_ROUTER_STATIC, static.main, static_elapsed_ms))
    return _add_fifo_deltas(rows), run, travel, router_elapsed_ms / 1000


def _run_policies(scenario, settings: SearchSettings, budget_ms: int) -> dict:
    """Reuse the policy-catalog comparison: seven bounded strategies, one task."""
    from core.runtime import calculate_policy_comparison

    raw = scenario.snapshot.model_dump_json().encode()
    comparison = calculate_policy_comparison(
        raw,
        getattr(scenario, "scenario_id", None) or scenario.config.scenario_id,
        scenario.graph,
        settings,
        "offline-bench-suite",
        budget_ms,
        offline=True,
    )
    return {
        "rows": [
            {
                "strategy_id": row.strategy_id,
                "calculation_ms": row.calculation_ms,
                "summary": row.summary.model_dump(),
            }
            for row in comparison.rows
        ]
    }


def _run_budget_curve(
    scenario,
    settings: SearchSettings,
    efforts: tuple[int, ...],
    solution_limit: int,
) -> list[dict]:
    """Solve one scenario with growing search effort; quality and time per point.

    Effort (``time_limit_ms``) drives the deterministic route-evaluation quotas,
    so the quality column is host-independent; only the elapsed column measures
    the machine. The OR-Tools solution cap stays fixed across the curve.
    """
    points = []
    for effort_ms in efforts:
        travel = configure_travel(
            GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
        )
        point_settings = SearchSettings(
            time_limit_ms=effort_ms,
            solution_limit=solution_limit,
            strict_time_windows=settings.strict_time_windows,
        )
        started = monotonic_time.perf_counter()
        output = solve(scenario.snapshot, travel, point_settings)
        elapsed_ms = (monotonic_time.perf_counter() - started) * 1000
        summary = output.main.summary
        points.append(
            {
                "effort_ms": effort_ms,
                "elapsed_ms": round(elapsed_ms, 1),
                "assigned_count": summary.assigned_count,
                "urgent_assigned_count": summary.urgent_assigned_count,
                "unassigned_count": summary.unassigned_count,
                "travel_time_sec": summary.travel_time_sec,
                "travel_per_order_sec": (
                    round(summary.travel_time_sec / summary.assigned_count)
                    if summary.assigned_count
                    else None
                ),
                "engineers_used": summary.engineers_used,
                "plan_sha256": _plan_hash(output.main),
            }
        )
    return points


def _run_events(scenario: OfficialScenario, run: Any, settings: SearchSettings) -> list[dict]:
    """Five deterministic mid-day events with latency, stability and coverage."""
    events = run_replanning_events(scenario, run.output, settings)
    rows = []
    for event in events:
        total_after = event.output.main.summary.assigned_count
        rows.append(
            {
                "event_id": event.event_id,
                "trigger": event.trigger,
                "elapsed_ms": round(event.elapsed_sec * 1000, 1),
                "search_path": event.output.path,
                "assigned_count": total_after,
                "changed_assignments": event.changed_assignments,
                "stability_pct": (
                    round(100 * (1 - event.changed_assignments / total_after), 1)
                    if total_after
                    else None
                ),
                "urgent_assigned_count": event.output.main.summary.urgent_assigned_count,
                "unassigned_count": event.output.main.summary.unassigned_count,
            }
        )
    return rows


def _run_warm_cold(scenario: OfficialScenario, run: Any, settings: SearchSettings) -> dict:
    """Replan one urgent insertion with and without the previous plan as memory.

    Warm replanning projects the applied plan and repairs it; a cold start
    searches from scratch. Latency, chosen path and plan disruption are the
    quantities the comparison is about.
    """
    zone = ZoneInfo(scenario.config.timezone)
    local_day = date.fromisoformat(scenario.config.local_date)
    event_at = (
        int(datetime.combine(local_day, datetime.min.time(), tzinfo=zone).timestamp()) + 15 * 3600
    )
    initial_snapshot = run.output.memory.snapshot
    remaining = project_remaining_snapshot(initial_snapshot, run.output.main, event_at)
    base_travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), remaining.planning_as_of
    )
    urgent = _with_new_request(
        remaining,
        initial_snapshot,
        request_id="event-urgent-1",
        priority="urgent",
        skill="emergency",
        location_request_id="4893",
        window_start_at=event_at,
        window_end_at=remaining.horizon_end_at,
        service_duration_sec=6000,
    )
    travel = configure_travel(base_travel, settings.technical(), urgent.planning_as_of)
    context_version = routing_context_version(travel, settings.technical())
    previous = {
        assignment.request_id: assignment.engineer_id for assignment in run.output.main.assignments
    }
    results = {}
    for name, memory in (
        ("warm", run.output.memory),
        ("cold", None),
    ):
        started = monotonic_time.perf_counter()
        output = solve(urgent, travel, settings, memory=memory, context_version=context_version)
        elapsed_ms = (monotonic_time.perf_counter() - started) * 1000
        current = {
            assignment.request_id: assignment.engineer_id
            for assignment in output.main.assignments
            if assignment.status == "assigned"
        }
        changed = sum(
            previous.get(request_id) != engineer_id for request_id, engineer_id in current.items()
        )
        results[name] = {
            "elapsed_ms": round(elapsed_ms, 1),
            "search_path": output.path,
            "assigned_count": output.main.summary.assigned_count,
            "changed_assignments": changed,
            "stability_pct": (round(100 * (1 - changed / len(current)), 1) if current else None),
            "urgent_assigned_count": output.main.summary.urgent_assigned_count,
        }
    return results


def _micro_instance(
    scenario: OfficialScenario,
    run: Any,
    *,
    engineer_count: int,
    request_cap: int,
) -> RouterTaskSnapshot | None:
    """Extract a lunchless micro instance from the golden plan's busiest crews.

    Requests come from the golden plan's own assignments, so the instance is
    known-feasible inside shifts; engineers whose manual lunch survived the
    policy switch are skipped because exact enumeration requires append
    monotonicity.
    """
    from core.engine import apply_system_policy

    snapshot = apply_system_policy(scenario.snapshot, SearchSettings())
    assigned: dict[str, list[str]] = {}
    for assignment in run.output.main.assignments:
        if assignment.status == "assigned" and assignment.engineer_id:
            assigned.setdefault(assignment.engineer_id, []).append(assignment.request_id)
    lunchless = [
        engineer
        for engineer in snapshot.engineers
        if not engineer.lunch.enabled or engineer.lunch_taken
    ]
    keep_ids = {engineer.engineer_id for engineer in lunchless}
    ranked = sorted(
        ((eid, rids) for eid, rids in assigned.items() if eid in keep_ids),
        key=lambda item: (-len(item[1]), item[0]),
    )[:engineer_count]
    if len(ranked) < engineer_count:
        return None
    engineer_ids = {eid for eid, _ in ranked}
    request_ids = {request_id for _, rids in ranked for request_id in rids}
    windows = {
        request.request_id: request.window_start_at
        for request in snapshot.requests
        if request.request_id in request_ids
    }
    ordered = sorted(request_ids, key=lambda rid: (windows[rid], rid))[:request_cap]
    if len(ordered) < 5:
        return None
    keep = set(ordered)
    requests = [request for request in snapshot.requests if request.request_id in keep]
    engineers = [
        engineer for engineer in snapshot.engineers if engineer.engineer_id in engineer_ids
    ]
    return RouterTaskSnapshot.model_validate(
        {
            **snapshot.model_dump(exclude={"requests", "engineers"}),
            "requests": [request.model_dump() for request in requests],
            "engineers": [engineer.model_dump() for engineer in engineers],
        }
    )


def _objective_row(name: str, plan: Plan, elapsed_ms: float) -> dict:
    """Score a heuristic plan with the exact enumeration's lexicographic objective."""
    summary = plan.summary
    return {
        "strategy": name,
        "unassigned_count": summary.unassigned_count,
        "engineers_used": summary.engineers_used,
        "travel_time_sec": summary.travel_time_sec,
        "elapsed_ms": round(elapsed_ms, 1),
    }


def _gap_vs_exact(row: dict, exact: ExactResult) -> dict:
    """Compare one heuristic row to the exact optimum on the same objective."""
    same = (row["unassigned_count"], row["engineers_used"]) == (
        exact.unassigned_count,
        exact.engineers_used,
    )
    travel_gap_pct = None
    if same and exact.travel_time_sec:
        travel_gap_pct = round(
            100 * (row["travel_time_sec"] - exact.travel_time_sec) / exact.travel_time_sec, 2
        )
    return {
        "strategy": row["strategy"],
        "objective_equal_to_exact": same,
        "travel_gap_pct": travel_gap_pct,
        "unassigned_count": row["unassigned_count"],
        "engineers_used": row["engineers_used"],
        "travel_time_sec": row["travel_time_sec"],
        "elapsed_ms": row["elapsed_ms"],
    }


def _run_exact_gap(
    scenario: OfficialScenario,
    run: Any,
    settings: SearchSettings,
    *,
    instances: tuple[dict, ...],
    max_route_builds: int,
) -> list[dict]:
    """Exact micro-instance optimum versus every heuristic on the same instance."""
    travel_provider = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
    )
    rows = []
    for spec in instances:
        snapshot = _micro_instance(
            scenario,
            run,
            engineer_count=spec["engineers"],
            request_cap=spec["requests"],
        )
        if snapshot is None:
            rows.append({"instance": spec["name"], "status": "skipped"})
            continue
        exact = exact_micro(snapshot, travel_provider, max_route_builds=max_route_builds)
        started = monotonic_time.perf_counter()
        router = solve(snapshot, travel_provider, settings)
        router_ms = (monotonic_time.perf_counter() - started) * 1000
        heuristic_rows = [_objective_row(_STRATEGY_ROUTER, router.main, router_ms)]
        for name, planner in (
            (_STRATEGY_FIFO, fifo_baseline),
            (_STRATEGY_NEAREST, greedy_nearest),
            (_STRATEGY_URGENT, greedy_urgency),
        ):
            started = monotonic_time.perf_counter()
            plan = planner(snapshot, travel_provider)
            heuristic_rows.append(
                _objective_row(name, plan, (monotonic_time.perf_counter() - started) * 1000)
            )
        rows.append(
            {
                "instance": spec["name"],
                "status": exact.status,
                "requests": len(snapshot.requests),
                "engineers": len(snapshot.engineers),
                "exact": {
                    "unassigned_count": exact.unassigned_count,
                    "engineers_used": exact.engineers_used,
                    "travel_time_sec": exact.travel_time_sec,
                    "route_builds": exact.route_builds,
                    "elapsed_sec": round(exact.elapsed_sec, 3),
                },
                "heuristics": [_gap_vs_exact(row, exact) for row in heuristic_rows],
            }
        )
    return rows


def _run_robustness(scenario, run: Any, settings: SearchSettings, simulations: int) -> dict:
    """Monte-Carlo reliability of the published plan under execution noise."""
    travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
    )
    report = predict_situation(
        scenario.snapshot,
        travel,
        engineer_routes(run.output.main),
        simulations=simulations,
    )
    riskiest = sorted(
        (
            {"request_id": request_id, **metrics}
            for request_id, metrics in report["requests"].items()
            if metrics["breach_prob"]
        ),
        key=lambda item: -item["breach_prob"],
    )[:5]
    return {"plan": report["plan"], "riskiest_requests": riskiest}


def _run_determinism(scenario, settings: SearchSettings, repeats: int) -> dict:
    """Repeat the initial calculation; identical plan hashes prove determinism."""
    travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
    )
    hashes = []
    elapsed = []
    for _ in range(repeats):
        started = monotonic_time.perf_counter()
        output = solve(scenario.snapshot, travel, settings)
        elapsed.append(round((monotonic_time.perf_counter() - started) * 1000, 1))
        hashes.append(_plan_hash(output.main))
    return {
        "repeats": repeats,
        "plan_hashes_identical": len(set(hashes)) == 1,
        "plan_sha256": hashes[0],
        "elapsed_ms": elapsed,
    }


def _git_meta() -> dict:
    """Commit identity when available; extracted archives carry no .git."""
    try:
        return {
            "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
            "working_tree_dirty": bool(
                subprocess.check_output(["git", "status", "--porcelain"], text=True).strip()
            ),
        }
    except subprocess.SubprocessError:
        return {"commit": None, "working_tree_dirty": None}
    except OSError:
        return {"commit": None, "working_tree_dirty": None}


def run_suite(
    *,
    label: str,
    regions: tuple[str, ...] = ("east", "southeast", "south_central", "all"),
    dataset_dir: Path = Path("data/dataset/anonymized"),
    budget_ms: int = 30000,
    solution_limit: int = 32,
    policy_budget_ms: int = 2000,
    event_budget_ms: int = 3000,
    budget_curve_efforts_ms: tuple[int, ...] = (500, 1000, 2000, 5000, 10000, 30000),
    exact_instances: tuple[dict, ...] | None = None,
    exact_max_route_builds: int = 1_500_000,
    robustness_simulations: int = 300,
    determinism_repeats: int = 3,
    strict_time_windows: bool = False,
) -> dict:
    """Run every benchmark section and return the JSON-ready suite payload.

    The default ``strict_time_windows=False`` matches the enforced golden gate
    and the product's default 600-second window-lateness tolerance, so the
    measured configuration is the one customers actually run.
    """
    if exact_instances is None:
        exact_instances = (
            {"name": "micro-2x7", "engineers": 2, "requests": 7},
            {"name": "micro-3x7", "engineers": 3, "requests": 7},
        )
    settings = SearchSettings(
        time_limit_ms=budget_ms,
        solution_limit=solution_limit,
        strict_time_windows=strict_time_windows,
    )
    event_settings = SearchSettings(
        time_limit_ms=event_budget_ms,
        solution_limit=solution_limit,
        strict_time_windows=strict_time_windows,
    )
    selected: list[Region] = []
    for name in regions:
        if name == "east" or name == "southeast" or name == "south_central":
            selected.append(name)
    names = selected
    scenarios = [load_official_region(dataset_dir, name) for name in names]
    strategies: dict[str, list[dict]] = {}
    policies: dict[str, dict] = {}
    east = None
    for name, scenario in zip(names, scenarios, strict=True):
        rows, run, _travel, _ms = _run_strategies(scenario, settings)
        strategies[name] = rows
        policies[name] = _run_policies(scenario, settings, policy_budget_ms)
        if name == "east":
            east = (scenario, run)
        print(f"[suite] strategies+policies {name} done", flush=True)
    if "all" in regions:
        union = combine_official_scenarios(list(scenarios))
        rows, _run, _travel, _ms = _run_strategies(union, settings)
        strategies["all"] = rows
        print("[suite] strategies all-union done", flush=True)
    payload: dict[str, Any] = {
        "schema_version": "1.0",
        "meta": {
            **_machine_meta(label),
            **_git_meta(),
            "timestamp_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "settings": {
                "budget_ms": budget_ms,
                "solution_limit": solution_limit,
                "policy_budget_ms": policy_budget_ms,
                "event_budget_ms": event_budget_ms,
                "strict_time_windows": settings.strict_time_windows,
                "lunches_enabled": settings.lunches_enabled,
            },
        },
        "strategies": strategies,
        "policies": policies,
    }
    if east is not None:
        east_scenario, east_initial = east
        payload["budget_curve"] = {
            "region": "east",
            "efforts_ms": list(budget_curve_efforts_ms),
            "solution_limit": solution_limit,
            "points": _run_budget_curve(
                east_scenario, settings, budget_curve_efforts_ms, solution_limit
            ),
        }
        payload["events"] = _run_events(east_scenario, east_initial, event_settings)
        payload["warm_cold"] = _run_warm_cold(east_scenario, east_initial, event_settings)
        payload["exact_gap"] = _run_exact_gap(
            east_scenario,
            east_initial,
            event_settings,
            instances=exact_instances,
            max_route_builds=exact_max_route_builds,
        )
        payload["robustness"] = _run_robustness(
            east_scenario, east_initial, settings, robustness_simulations
        )
        payload["determinism"] = _run_determinism(east_scenario, settings, determinism_repeats)
    return payload


def write_suite_report(payload: dict, output: Path) -> None:
    """Write the suite JSON atomically enough for a benchmark artifact directory."""
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
