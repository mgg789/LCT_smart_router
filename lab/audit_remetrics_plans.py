"""Independently check saved benchmark schedules and raw Route3 leg endpoints."""

import argparse
import json
import math
from collections import Counter
from pathlib import Path

from core.contracts import RouterTaskSnapshot
from core.geo import haversine_m
from core.route3 import Route3Client
from lab.audit_graph_coverage import endpoint_error_m


def audit_case(case: dict, client: Route3Client) -> dict:
    """Check every published verified leg and strict job, retaining each violation."""
    snapshot = RouterTaskSnapshot.model_validate(case["snapshot"])
    requests = {row.request_id: row for row in snapshot.requests}
    engineers = {row.engineer_id: row for row in snapshot.engineers}
    results = {}
    for strategy, plan in case["evidence"].items():
        if not strategy.endswith("verified"):
            continue
        violations, legs, sources = [], [], Counter()
        for route in plan["routes"]:
            engineer = engineers[route["engineer_id"]]
            previous = engineer.start_location
            leg_by_stop = {leg["to_stop_id"]: leg for leg in route["legs"]}
            pending_leg = None
            for stop in route["stops"]:
                if stop["kind"] == "wait":
                    pending_leg = leg_by_stop.get(stop["stop_id"], pending_leg)
                    continue
                if stop["kind"] != "job":
                    raise ValueError("AUDIT_EXPECTS_LUNCHLESS_OFFICIAL_SCENARIO")
                request = requests[stop["request_id"]]
                identity = {
                    "engineer_id": engineer.engineer_id,
                    "request_id": request.request_id,
                }
                if case["settings"]["strict_time_windows"]:
                    if (
                        stop["start_at"] < request.window_start_at
                        or stop["end_at"] > request.window_end_at
                    ):
                        violations.append({**identity, "code": "WINDOW"})
                    if stop["end_at"] > engineer.shift_end_at:
                        violations.append({**identity, "code": "SHIFT"})
                if request.required_skill not in engineer.skills:
                    violations.append({**identity, "code": "SKILL"})
                leg = leg_by_stop.get(stop["stop_id"], pending_leg)
                if leg is None:
                    raise ValueError("AUDIT_LEG_MISSING")
                pending_leg = None
                profile = engineer.travel_profile()
                if profile == "car" and haversine_m(previous, request.location) <= 300:
                    profile = "walk"
                body = client.route(
                    previous,
                    request.location,
                    profile,
                    traffic=case["settings"]["traffic_enabled"] and profile == "car",
                    metro=case["settings"]["metro_enabled"] and profile == "transit",
                    departure=leg["departure_at"],
                )
                geometry = body.get("geometry") or []
                segments = body.get("segments") or []
                start_geometry = segments[0]["geometry"] if segments else geometry
                end_geometry = segments[-1]["geometry"] if segments else geometry
                start_error = endpoint_error_m(previous, start_geometry, 0)
                end_error = endpoint_error_m(request.location, end_geometry, -1)
                sources[body["mode"]] += 1
                expected_sec = math.ceil(
                    math.ceil(body["duration_s"])
                    * (leg.get("weather_multiplier_used") or 1)
                )
                if body["distance_m"] > 0:
                    expected_sec += case["settings"]["access_buffer_sec"]
                if leg["travel_time_sec"] != expected_sec:
                    violations.append(
                        {
                            **identity,
                            "code": "DURATION",
                            "plan_sec": leg["travel_time_sec"],
                            "route3_with_buffer_sec": expected_sec,
                        }
                    )
                row = {
                    **identity,
                    "mode": body["mode"],
                    "departure_at": leg["departure_at"],
                    "start_error_m": round(start_error, 2),
                    "end_error_m": round(end_error, 2),
                    "service_duration_s": body["duration_s"],
                    "plan_travel_sec": leg["travel_time_sec"],
                }
                if (
                    body["mode"] not in ("road", "metro_composite")
                    or max(start_error, end_error) > 250
                ):
                    violations.append({**identity, "code": "GRAPH_ENDPOINT", **row})
                legs.append(row)
                previous = request.location
        results[strategy] = {
            "legs": len(legs),
            "modes": dict(sources),
            "violations": violations,
            "endpoint_max_m": max(
                (max(r["start_error_m"], r["end_error_m"]) for r in legs), default=0
            ),
            "rows": legs,
        }
    return results


def main() -> None:
    """Audit an immutable saved run without modifying its metrics or live state."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    client = Route3Client(
        "http://127.0.0.1:8128", cache_dir=Path(".codex/remetrics-cache")
    )
    if client.ensure_versions() != data["versions"]:
        raise ValueError("AUDIT_GRAPH_VERSION_CHANGED")
    results = {
        name: audit_case(case, client)
        for name, case in data["cases"].items()
        if case["covered_subset"]
    }
    args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(
        {
            name: {
                strategy: {k: v for k, v in row.items() if k != "rows"}
                for strategy, row in case.items()
            }
            for name, case in results.items()
        },
        flush=True,
    )


if __name__ == "__main__":
    main()
