"""Measure how far the haversine fallback lies for walk/bike/transit.

Samples point pairs from all three official regional scenarios, asks the
MKAD foot graph (route-engine3's pedestrian OSRM) for true road distances in
one batched /table call, and compares with haversine x1.25 — the fallback the
solver uses today. The resulting per-profile road factors land in core/geo.py.

Usage (with the foot graph on 127.0.0.1:15112):
    .venv/bin/python -m lab.calibrate_walk --pairs 400 --foot http://127.0.0.1:15112
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from pathlib import Path

import httpx

from core.contracts import GeoPoint
from core.geo import haversine_m
from core.official import load_official_east, load_official_region

ROOT = Path(__file__).resolve().parents[1]


def _straight(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Haversine between (lat, lon) tuples via the strict core helper."""
    return haversine_m(GeoPoint(lat=a[0], lon=a[1]), GeoPoint(lat=b[0], lon=b[1]))


def scenario_points():
    """Collect all snapshot points of the three regions (inside MKAD by design)."""
    dataset = ROOT / "data/dataset/anonymized"
    scenarios_dir = ROOT / "core/scenarios"
    points = []
    for name, loader in (
        ("east-v1", load_official_east),
        ("southeast-v1", lambda d: load_official_region(d, "southeast", scenarios_dir / "southeast-v1")),
        (
            "south-central-v1",
            lambda d: load_official_region(d, "south_central", scenarios_dir / "south-central-v1"),
        ),
    ):
        try:
            scenario = loader(dataset)
        except FileNotFoundError:
            continue
        snapshot = scenario.snapshot
        seen = set()
        for row in snapshot.requests:
            seen.add((row.location.lat, row.location.lon))
        for engineer in snapshot.engineers:
            seen.add((engineer.start_location.lat, engineer.start_location.lon))
        points.append((name, sorted(seen)))
    return points


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--foot", default="http://127.0.0.1:15112")
    parser.add_argument("--pairs", type=int, default=400)
    parser.add_argument("--seed", type=int, default=20260928)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    ratios = []
    per_region = {}
    for name, points in scenario_points():
        if len(points) < 2:
            continue
        region_ratios = []
        batches = 0
        attempts = 0
        while len(region_ratios) < args.pairs // len(scenario_points()) and attempts < 2000:
            attempts += 1
            chunk = rng.sample(points, k=min(len(points), 60))
            coords = ";".join(f"{lon},{lat}" for lat, lon in chunk)
            response = httpx.get(
                f"{args.foot}/table/v1/walking/{coords}", params={"annotations": "distance"}, timeout=60
            )
            response.raise_for_status()
            payload = response.json()
            distances = payload["distances"]
            # OSRM reports how far each requested coordinate had to be snapped;
            # pairs with a far snap lie outside the graph's coverage (the MKAD
            # ring) and their "road distance" is meaningless — drop them.
            snaps = [
                waypoint.get("distance") or 0.0
                for waypoint in payload.get("destinations", [])
            ]
            batches += 1
            for i, row in enumerate(distances):
                for j, distance in enumerate(row):
                    if i == j or distance is None:
                        continue
                    if max(snaps[i], snaps[j]) > 150:
                        continue
                    straight = _straight(chunk[i], chunk[j])
                    if straight < 150:  # skip micro-distances: noise dominates
                        continue
                    region_ratios.append(distance / straight)
                    ratios.append(distance / straight)
                    if len(region_ratios) >= args.pairs // len(scenario_points()):
                        break
                else:
                    continue
                break
            if batches > 40:
                break
        if region_ratios:
            per_region[name] = {
                "pairs": len(region_ratios),
                "mean_ratio": round(statistics.mean(region_ratios), 3),
                "median_ratio": round(statistics.median(region_ratios), 3),
                "p90_ratio": round(sorted(region_ratios)[int(len(region_ratios) * 0.9)], 3),
            }

    mean = statistics.mean(ratios)
    median = statistics.median(ratios)
    p90 = sorted(ratios)[int(len(ratios) * 0.9)]
    report = {
        "sampled_pairs": len(ratios),
        "mean_graph_over_haversine": round(mean, 3),
        "median_graph_over_haversine": round(median, 3),
        "p90_graph_over_haversine": round(p90, 3),
        "current_factor": 1.25,
        "per_region": per_region,
        "recommended_factor_walk_bike_transit": round(min(1.35, max(1.05, math.ceil(median * 100) / 100)), 2),
    }
    out = ROOT / "lab" / "calibration.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"saved: {out}")


if __name__ == "__main__":
    main()
