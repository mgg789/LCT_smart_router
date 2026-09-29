"""Deterministic fixed-plan stress, without predicting real-world probabilities."""

import argparse
import json
import math
from pathlib import Path


def stress(case: dict, plan: dict, travel_factor: float, service_factor: float) -> dict:
    """Propagate extra road/service seconds, allowing existing waits to absorb delay."""
    requests = {row["request_id"]: row for row in case["snapshot"]["requests"]}
    engineers = {row["engineer_id"]: row for row in case["snapshot"]["engineers"]}
    late, shift_overruns, affected = [], set(), []
    for route in plan["routes"]:
        delay = 0
        legs = {leg["to_stop_id"]: leg for leg in route["legs"]}
        for stop in route["stops"]:
            leg = legs.get(stop["stop_id"])
            if leg is not None:
                buffer = case["settings"]["access_buffer_sec"] if leg["distance_km"] > 0 else 0
                road_sec = max(0, leg["travel_time_sec"] - buffer)
                delay += math.ceil(road_sec * travel_factor) - road_sec
            if stop["kind"] == "wait":
                delay = max(0, delay - (stop["end_at"] - stop["start_at"]))
            elif stop["kind"] == "job":
                request = requests[stop["request_id"]]
                service_sec = request["service_duration_sec"]
                delay += math.ceil(service_sec * service_factor) - service_sec
                lateness = max(0, stop["end_at"] + delay - request["window_end_at"])
                if lateness:
                    late.append(lateness)
                    affected.append(request["request_id"])
                if stop["end_at"] + delay > engineers[route["engineer_id"]]["shift_end_at"]:
                    shift_overruns.add(route["engineer_id"])
            else:
                raise ValueError("STRESS_UNSUPPORTED_STOP_KIND")
    return {"travel_factor": travel_factor, "service_factor": service_factor,
            "late_jobs": len(late), "max_lateness_sec": max(late, default=0),
            "total_lateness_sec": sum(late), "shift_overrun_crews": len(shift_overruns),
            "affected_request_ids": affected}


def main() -> None:
    """Measure deterministic sensitivity of each saved independently audited plan."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    result = {}
    for name, case in data["cases"].items():
        if case["publication_status"] != "VERIFIED":
            continue
        result[name] = {}
        for strategy, plan in case["evidence"].items():
            if not strategy.endswith("verified"):
                continue
            rows = [stress(case, plan, road, service) for road, service in
                    ((1.0, 1.0), (1.1, 1.0), (1.0, 1.1), (1.1, 1.1))]
            if rows[0]["late_jobs"] or rows[0]["shift_overrun_crews"]:
                raise ValueError("ZERO_STRESS_MUST_REPRODUCE_STRICT_FEASIBILITY")
            result[name][strategy] = rows
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print({name: {strategy: [{k: v for k, v in row.items() if k != "affected_request_ids"}
                             for row in rows] for strategy, rows in case.items()}
           for name, case in result.items()})


if __name__ == "__main__":
    main()
