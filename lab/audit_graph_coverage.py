"""Audit local Route3 endpoint snapping without changing the service or scenario."""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

from core.contracts import GeoPoint
from core.geo import haversine_m
from core.official import load_official_region


def endpoint_error_m(requested: GeoPoint, geometry: list, index: int) -> float:
    """Measure geographic endpoint displacement, in metres, from lat/lon geometry."""
    actual = geometry[index]
    return haversine_m(requested, GeoPoint(lat=actual[0], lon=actual[1]))


def audit(base: str, threshold_m: float, dataset: Path) -> dict:
    """Screen every official point on both graphs; retain failures and raw evidence."""
    with urlopen(base + "/versions3", timeout=30) as response:
        versions = json.load(response)["versions"]
    rows = []
    for region in ("east", "southeast", "south_central"):
        scenario = load_official_region(dataset, region)
        office = scenario.snapshot.engineers[0].start_location
        points = [("office", office)] + [
            (request.request_id, request.location)
            for request in scenario.snapshot.requests
        ]
        rows.extend(
            (region, identity, office, point, profile)
            for identity, point in points
            for profile in ("car", "walk")
        )

    def measure(row: tuple) -> dict:
        region, identity, office, point, profile = row
        query = urlencode(
            {
                "a": f"{office.lat},{office.lon}",
                "b": f"{point.lat},{point.lon}",
                "profile": profile,
                "traffic": "false",
                "metro": "false",
            }
        )
        result = {"region": region, "request_id": identity, "profile": profile}
        try:
            with urlopen(base + "/route3?" + query, timeout=60) as response:
                body = json.load(response)
            if body.get("versions") != versions:
                raise ValueError("GRAPH_VERSION_CHANGED")
            geometry = body["geometry"]
            start_error = endpoint_error_m(office, geometry, 0)
            end_error = endpoint_error_m(point, geometry, -1)
            result.update(
                {
                    "mode": body["mode"],
                    "graph_id": body.get("graph_id"),
                    "requested_end": [point.lat, point.lon],
                    "geometry_end": geometry[-1],
                    "start_error_m": round(start_error, 2),
                    "end_error_m": round(end_error, 2),
                    "distance_m": body["distance_m"],
                    "duration_s": body["duration_s"],
                    "accepted": body["mode"] == "road"
                    and max(start_error, end_error) <= threshold_m,
                }
            )
        except Exception as exc:  # noqa: BLE001 — retain failed points
            result.update({"accepted": False, "error": type(exc).__name__})
        return result

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(measure, rows))
    summary = {}
    for region in ("east", "southeast", "south_central"):
        subset = [row for row in results if row["region"] == region]
        identities = sorted(
            {row["request_id"] for row in subset if row["request_id"] != "office"}
        )
        accepted = [
            identity
            for identity in identities
            if all(row["accepted"] for row in subset if row["request_id"] == identity)
        ]
        summary[region] = {
            "requests_total": len(identities),
            "accepted_count": len(accepted),
            "accepted_request_ids": accepted,
            "excluded_request_ids": sorted(set(identities) - set(accepted)),
            "office_accepted": all(
                row["accepted"] for row in subset if row["request_id"] == "office"
            ),
            "max_endpoint_error_m": max(row.get("end_error_m", 0) for row in subset),
        }
    return {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "versions": versions,
        "endpoint": base,
        "threshold_m": threshold_m,
        "summary": summary,
        "rows": results,
    }


def main() -> None:
    """Write reproducible endpoint screening evidence to the explicitly chosen output."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8128")
    parser.add_argument("--threshold-m", type=float, default=250)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.base, args.threshold_m, Path("data/dataset/anonymized"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["summary"], ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
