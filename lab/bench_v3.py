"""route-engine3 end-to-end benchmark: straight vs hybrid vs full v3 matrices.

Datasets: official east-v1 (first 14 / 35 requests) and southeast-v1 (first
75 requests). Scenarios per dataset:

1. straight  — calibrated haversine fallback + metro (today's fast path).
2. hybrid    — the same fast solve, then verification of chosen legs via
               /route3 (car with traffic, walk with metro), re-solve on
               window breaches (core.hybrid.hybrid_plan).
3. full v3   — planning directly on PreparedRoute3Matrix (/matrix3 for car,
               walk and bike), cold then warm disk cache.

Requires a live route-engine3 (default http://127.0.0.1:18124) with both
graphs loaded. Usage:
    PYTHONPATH=. .venv/bin/python -m lab.bench_v3
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from core.contracts import RouterTaskSnapshot
from core.engine import SearchSettings, solve
from core.geo import StraightTravel, configure_travel
from core.hybrid import hybrid_plan
from core.official import load_official_east, load_official_region
from core.route3 import Route3Client, prepare_route3
from core.schedule import validate_plan

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((ROOT / "core/tests/golden/official-east-v1.json").read_text(encoding="utf-8"))
ENGINE3_URL = "http://127.0.0.1:18124"


def subset(snapshot: RouterTaskSnapshot, count: int) -> RouterTaskSnapshot:
    payload = snapshot.model_dump()
    payload["requests"] = payload["requests"][:count]
    return RouterTaskSnapshot.model_validate(payload)


def fast_travel(snapshot: RouterTaskSnapshot, settings: SearchSettings):
    """Calibrated straight-line costs; metro follows settings.metro_enabled."""
    return configure_travel(StraightTravel(), settings.technical(), snapshot.planning_as_of)


def bench(snapshot: RouterTaskSnapshot, client: Route3Client) -> dict:
    # Metro for transit engineers must come from SearchSettings: solve() rebuilds
    # the technical stack from settings.technical() and strips hand-made wraps.
    settings = SearchSettings(**GOLDEN["settings"], metro_enabled=True)
    transport = {}
    for engineer in snapshot.engineers:
        transport[engineer.transport_type] = transport.get(engineer.transport_type, 0) + 1

    # 1. Straight fast path.
    travel = configure_travel(StraightTravel(), settings.technical(), snapshot.planning_as_of)
    started = time.perf_counter()
    output = solve(snapshot, travel, settings, context_version="bench-straight")
    straight_s = time.perf_counter() - started
    validate_plan(output.memory.snapshot, output.main, travel)

    # 2. Hybrid: the same solve inside hybrid_plan plus verification.
    hybrid_client = Route3Client(ENGINE3_URL, cache_dir=ROOT / "lab" / "route3-cache")
    started = time.perf_counter()
    run = hybrid_plan(snapshot, travel, settings, None, "bench-hybrid", client=hybrid_client)
    hybrid_s = time.perf_counter() - started
    verification = run.verification or {}
    breaches = sum(1 for row in verification.get("routes", []) if row["window_breach"])
    metro_legs = sum(
        1
        for route in run.output.main.routes
        for leg in route.legs
        if leg.travel_source == "metro"
    )
    validate_plan(run.output.memory.snapshot, run.output.main, run.provider)

    # 3. Full v3: plan directly on /matrix3 (cold, then warm cache).
    cache_dir = ROOT / "lab" / "route3-cold"
    shutil.rmtree(cache_dir, ignore_errors=True)
    cold_client = Route3Client(ENGINE3_URL, cache_dir=cache_dir)
    from core.planning_travel import snapshot_points

    points = snapshot_points(snapshot)
    started = time.perf_counter()
    matrix = prepare_route3(
        cold_client, points, departure=snapshot.planning_as_of, fallback=StraightTravel()
    )
    prep_cold_s = time.perf_counter() - started
    started = time.perf_counter()
    prepare_route3(
        cold_client, points, departure=snapshot.planning_as_of, fallback=StraightTravel()
    )
    prep_warm_s = time.perf_counter() - started
    v3_travel = configure_travel(matrix, settings.technical(), snapshot.planning_as_of)
    started = time.perf_counter()
    v3_output = solve(snapshot, v3_travel, settings, context_version="bench-v3")
    v3_s = time.perf_counter() - started
    validate_plan(v3_output.memory.snapshot, v3_output.main, v3_travel)

    return {
        "requests": len(snapshot.requests),
        "engineers": len(snapshot.engineers),
        "transport_mix": transport,
        "straight": {
            "solve_s": round(straight_s, 3),
            "assigned": sum(1 for a in output.main.assignments if a.status == "assigned"),
            "travel_time_sec": output.main.summary.travel_time_sec,
        },
        "hybrid": {
            "total_s": round(hybrid_s, 3),
            "verified_legs": verification.get("verified_legs", 0),
            "window_breaches": breaches,
            "metro_legs": metro_legs,
            "re_solved": breaches > 0,
            "assigned": sum(1 for a in run.output.main.assignments if a.status == "assigned"),
            "travel_time_sec": run.output.main.summary.travel_time_sec,
        },
        "full_v3": {
            "prep_cold_s": round(prep_cold_s, 3),
            "prep_warm_s": round(prep_warm_s, 3),
            "solve_s": round(v3_s, 3),
            "total_cold_s": round(prep_cold_s + v3_s, 3),
            "assigned": sum(1 for a in v3_output.main.assignments if a.status == "assigned"),
            "travel_time_sec": v3_output.main.summary.travel_time_sec,
            "profiles": sorted(matrix.profiles),
        },
    }


def main() -> None:
    dataset = ROOT / "data/dataset/anonymized"
    scenarios = ROOT / "core/scenarios"
    east = load_official_east(dataset)
    southeast = load_official_region(dataset, "southeast", scenarios / "southeast-v1")
    client = Route3Client(ENGINE3_URL, cache_dir=ROOT / "lab" / "route3-cache")
    results = []
    for name, scenario, count in (
        ("east-14", east, 14),
        ("east-35", east, 35),
        ("southeast-75", southeast, 75),
    ):
        snapshot = subset(scenario.snapshot, count)
        row = {"dataset": name, **bench(snapshot, client)}
        results.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    out = ROOT / "lab" / "bench-v3-results.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"saved: {out}")


if __name__ == "__main__":
    main()
