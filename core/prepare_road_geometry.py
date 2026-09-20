"""Enrich a cached official road matrix with per-pair road polylines.

The matrix resources were prepared from the public OSRM Table API, which returns
costs only. Map rendering needs the road shape of every ordered pair, so this
script asks the OSRM Route API once per pair, simplifies the returned polyline
(Ramer-Douglas-Peucker) and stores it next to the untouched costs. The result is
a committed offline resource: the demo contour never issues a routing request
(context/15 section 4), exactly like the matrix itself.

Costs are never modified -- only the ``geometries`` key is added -- so plan
quality and determinism are preserved; only the rendered shape and the stored
plan bytes change (the golden plan hash is updated consciously, card #66).

Run from the repository root:

    core/.venv/bin/python -m core.prepare_road_geometry \
        --scenario core/scenarios/east-v1

The run is resumable: fetched pairs are cached under ``core/.cache/`` and a
errupted run continues where it stopped.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

_ROUND_DECIMALS = 5


def _short_sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:8]


def _load(scenario_dir: Path) -> tuple[dict, dict, dict[str, dict[str, float]]]:
    matrix = json.loads((scenario_dir / "road-matrix.json").read_text(encoding="utf-8"))
    config = json.loads((scenario_dir / "config.json").read_text(encoding="utf-8"))
    geocodes = json.loads((scenario_dir / "geocodes.json").read_text(encoding="utf-8"))
    locations: dict[str, dict[str, float]] = {}
    for entry in geocodes["entries"]:
        locations[entry["node_id"]] = {
            "lat": entry["location"]["lat"],
            "lon": entry["location"]["lon"],
        }
    return matrix, config, locations


def _point_to_string(coords: list[list[float]]) -> str:
    return f"{coords[0][0]:.{_ROUND_DECIMALS}f},{coords[0][1]:.{_ROUND_DECIMALS}f}"


def _perpendicular_distance(
    point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]
) -> float:
    """Metres via a local equirectangular approximation; ample for a 15 m tolerance."""
    lat_ref = math.radians((start[1] + end[1]) / 2)
    x_a, y_a = math.radians(start[0]) * math.cos(lat_ref), math.radians(start[1])
    x_b, y_b = math.radians(end[0]) * math.cos(lat_ref), math.radians(end[1])
    x_p, y_p = math.radians(point[0]) * math.cos(lat_ref), math.radians(point[1])
    area = abs((y_b - y_a) * (x_p - x_a) - (x_b - x_a) * (y_p - y_a))
    length = math.hypot(x_b - x_a, y_b - y_a)
    if length == 0:
        return math.hypot(x_p - x_a, y_p - y_a) * 6_371_008.8
    return (area / length) * 6_371_008.8


def _simplify(
    coords: list[list[float]], tolerance_m: float
) -> list[list[float]]:
    """Ramer-Douglas-Peucker over (lon, lat) pairs with a metre tolerance."""
    points = [(float(lon), float(lat)) for lon, lat in coords]
    if len(points) <= 2:
        return [[round(p[0], _ROUND_DECIMALS), round(p[1], _ROUND_DECIMALS)] for p in points]
    stack = [(0, len(points) - 1)]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        best, index = -1.0, None
        for position in range(first + 1, last):
            distance = _perpendicular_distance(points[position], points[first], points[last])
            if distance > best:
                best, index = distance, position
        if index is not None and best > tolerance_m:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))
    simplified = [
        [round(points[i][0], _ROUND_DECIMALS), round(points[i][1], _ROUND_DECIMALS)]
        for i, kept in enumerate(keep)
        if kept
    ]
    return [point for i, point in enumerate(simplified) if i == 0 or point != simplified[i - 1]]


def _fetch_pair(
    client: httpx.Client, base_url: str, profile: str, origin: dict, target: dict
) -> list[list[float]]:
    """One OSRM Route request; retries survive transient public-server hiccups."""
    url = (
        f"{base_url}/route/v1/{profile}/"
        f"{origin['lon']},{origin['lat']};{target['lon']},{target['lat']}"
        "?overview=full&geometries=geojson&continue_straight=false"
    )
    last_error: Exception | None = None
    for attempt in range(4):
        if attempt:
            time.sleep(2**attempt)
        try:
            response = client.get(url, timeout=20.0)
            response.raise_for_status()
            payload = response.json()
            if payload.get("code") != "Ok" or not payload.get("routes"):
                raise ValueError(f"OSRM code={payload.get('code')}")
            return payload["routes"][0]["geometry"]["coordinates"]
        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc
    raise RuntimeError(f"OSRM route failed for {url}: {last_error}")


def enrich(scenario_dir: Path, base_url: str, profile: str, tolerance_m: float, jobs: int) -> None:
    """Fetch, simplify and store road polylines for every directed matrix pair."""
    matrix, config, locations = _load(scenario_dir)
    node_ids: list[str] = matrix["node_ids"]
    durations = matrix["durations_sec"]

    cache_dir = scenario_dir.parent.parent / ".cache" / "road-geometry"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{scenario_dir.name}-{_short_sha(scenario_dir.joinpath('road-matrix.json').read_bytes())}.json"
    cache: dict[str, list[list[float]]] = (
        json.loads(cache_path.read_text(encoding="utf-8"))
        if cache_path.exists()
        else {}
    )

    pairs: list[tuple[str, str]] = []
    for source_index, source_id in enumerate(node_ids):
        for target_index, target_id in enumerate(node_ids):
            if source_index == target_index:
                continue
            # Pairs the loader skips (unreachable in the cached matrix) get no edge and
            # need no geometry.
            if durations[source_index][target_index] is None:
                continue
            pairs.append((source_id, target_id))

    pending = [pair for pair in pairs if f"{pair[0]}>{pair[1]}" not in cache]
    print(f"{scenario_dir.name}: {len(pairs)} pairs, {len(cache)} cached, fetching {len(pending)}")

    def task(pair: tuple[str, str]) -> tuple[str, list[list[float]]]:
        source_id, target_id = pair
        coords = _fetch_pair(
            client, base_url, profile, locations[source_id], locations[target_id]
        )
        return f"{source_id}>{target_id}", _simplify(coords, tolerance_m)

    done = 0
    with httpx.Client() as client:
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            for key, coords in pool.map(task, pending):
                cache[key] = coords
                done += 1
                if done % 50 == 0:
                    cache_path.write_text(
                        json.dumps(cache, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8",
                    )
                    print(f"  {done}/{len(pending)}")

    matrix["geometries"] = {f"{s}>{t}": cache[f"{s}>{t}"] for s, t in pairs}
    matrix_bytes = json.dumps(
        matrix, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    (scenario_dir / "road-matrix.json").write_bytes(matrix_bytes)
    config["resource_sha256"]["road_matrix"] = hashlib.sha256(matrix_bytes).hexdigest()
    (scenario_dir / "config.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"{scenario_dir.name}: wrote {len(matrix['geometries'])} geometries, "
        f"matrix sha {config['resource_sha256']['road_matrix'][:12]}…"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", type=Path, default=Path("core/scenarios/east-v1"))
    parser.add_argument("--osrm-base-url", default="https://router.project-osrm.org")
    parser.add_argument("--profile", default="driving")
    parser.add_argument("--tolerance-m", type=float, default=15.0)
    parser.add_argument("--jobs", type=int, default=4)
    arguments = parser.parse_args()
    enrich(
        arguments.scenario,
        arguments.osrm_base_url,
        arguments.profile,
        arguments.tolerance_m,
        arguments.jobs,
    )


if __name__ == "__main__":
    main()
