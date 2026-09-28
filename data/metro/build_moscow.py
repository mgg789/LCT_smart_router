#!/usr/bin/env python3
"""Build the deterministic offline Moscow metro resource from OSM snapshots.

The converter intentionally uses only the Python standard library.  It keeps the
raw snapshots as gzip members with a zero mtime, writes a strict runtime JSON
resource, and records hashes for both compressed and uncompressed inputs.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
import tempfile
import unicodedata
from pathlib import Path
from typing import Any, Iterable


REPO = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = Path("/tmp/navix-metro-data")
DEFAULT_RAW = REPO / "data/metro/raw"
DEFAULT_ARTIFACT = REPO / "core/resources/metro/moscow.json"
DEFAULT_MANIFEST = REPO / "data/metro/manifest.json"

ROUTE_FILE = "moscow_subway_routes.json"
BOUNDARY_FILE = "moscow_boundary_nominatim.json"

EARTH_RADIUS_M = 6_371_000.0
# Moscow metro commercial speed incl. stops is ~48–50 km/h on the long
# straight sections; the 1.15 stretch compensates the haversine underestimating
# curved tunnels. 2026-09-28: 41 km/h made every ride ~1.6x slower than the
# real timetable (Кожуховская → Таганская: 20.5 predicted vs ~12 actual).
RIDE_SPEED_MPS = 50_000.0 / 3_600.0
RIDE_STRETCH = 1.15
WALK_SPEED_MPS = 1.75  # transfer walking: escalators, brisk pace; was 1.4 — inflated interchange times ~2x
MIN_RIDE_SEC = 60
MIN_TRANSFER_SEC = 60

# OSM uses Cyrillic A in the branch references.  Shared 4А stops are assigned to
# line 4 below; a branch-only stop keeps canonical ASCII line ID 4A.  8А remains
# a separate line (Solntsevskaya).
LINE_IDS = {"4А": "4A", "4A": "4A", "8А": "8A", "8A": "8A"}

# Names are normalized only for matching; the first stable OSM spelling remains
# the station display name in the generated resource.
TRANSFER_OVERRIDES: tuple[tuple[str, str, str, str], ...] = (
    ("1", "лубянка", "7", "кузнецкий мост"),
    ("1", "чистые пруды", "6", "тургеневская"),
    ("1", "чистые пруды", "10", "сретенский бульвар"),
    ("1", "библиотека имени ленина", "9", "боровицкая"),
    ("1", "библиотека имени ленина", "3", "арбатская"),
    ("1", "библиотека имени ленина", "4", "александровский сад"),
    ("3", "арбатская", "4", "александровский сад"),
    ("1", "охотный ряд", "2", "театральная"),
    ("2", "театральная", "3", "площадь революции"),
    ("2", "новокузнецкая", "6", "третьяковская"),
    ("2", "тверская", "7", "пушкинская"),
    ("2", "тверская", "9", "чеховская"),
    ("3", "площадь революции", "2", "театральная"),
    ("5", "краснопресненская", "7", "баррикадная"),
    ("5", "новослободская", "9", "менделеевская"),
    ("5", "таганская", "8", "марксистская"),
    ("5", "добрынинская", "9", "серпуховская"),
    ("5", "курская", "10", "чкаловская"),
    ("5", "курская", "10", "чкаловская"),
    ("6", "калужская", "11", "воронцовская"),
    ("8", "площадь ильича", "10", "римская"),
    ("9", "бульвар дмитрия донского", "12", "улица старокачаловская"),
    ("2", "динамо", "11", "петровский парк"),
    ("7", "полежаевская", "11", "хорошевская"),
)


def normalize_name(value: str) -> str:
    """Return a stable key for Russian station-name matching."""
    value = unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")
    return " ".join(value.split())


def station_slug(value: str) -> str:
    """Build a readable, deterministic station-ID suffix without dependencies."""
    value = normalize_name(value)
    value = re.sub(r"[^0-9a-zа-я]+", "-", value)
    value = value.strip("-")
    if not value:
        raise ValueError(f"cannot derive station ID from {value!r}")
    return value


def line_id(raw: str) -> str:
    """Canonicalize OSM branch refs while retaining all line families."""
    return LINE_IDS.get(raw, raw)


def sha256(data: bytes) -> str:
    """Return a hexadecimal SHA-256 digest."""
    return hashlib.sha256(data).hexdigest()


def deterministic_gzip(data: bytes) -> bytes:
    """Compress bytes with a zero timestamp and stable gzip OS marker."""
    output = bytearray()
    with tempfile.SpooledTemporaryFile() as handle:
        with gzip.GzipFile(fileobj=handle, mode="wb", filename="", mtime=0) as stream:
            stream.write(data)
        handle.seek(0)
        output.extend(handle.read())
    # CPython/zlib versions differ in this header byte (Unix=3, unknown=255),
    # while both represent the same DEFLATE stream.  Fix it for byte identity.
    output[9] = 255
    return bytes(output)


def load_snapshot(source: Path, raw_dir: Path, filename: str) -> tuple[bytes, dict[str, Any]]:
    """Read a source JSON snapshot, preferring a supplied source over raw cache."""
    source_file = source / filename
    raw_file = raw_dir / f"{filename}.gz"
    if source_file.is_file():
        data = source_file.read_bytes()
        compressed = deterministic_gzip(data)
        raw_file.parent.mkdir(parents=True, exist_ok=True)
        if not raw_file.exists() or raw_file.read_bytes() != compressed:
            raw_file.write_bytes(compressed)
        origin = f"source/{filename}"
    elif raw_file.is_file():
        compressed = raw_file.read_bytes()
        data = gzip.decompress(compressed)
        origin = f"raw/{filename}.gz"
    else:
        raise FileNotFoundError(f"missing {filename} in {source} and {raw_dir}")
    metadata = {
        "filename": filename,
        "origin": origin,
        "bytes": len(data),
        "sha256": sha256(data),
        "gzip_bytes": len(compressed),
        "gzip_sha256": sha256(compressed),
    }
    return data, metadata


def haversine_m(first: tuple[float, float], second: tuple[float, float]) -> float:
    """Compute WGS84 spherical distance for (latitude, longitude) pairs."""
    lat1, lon1 = map(math.radians, first)
    lat2, lon2 = map(math.radians, second)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.asin(math.sqrt(a))


def mean_point(points: Iterable[tuple[float, float]]) -> tuple[float, float]:
    """Average platform stop coordinates into one station point."""
    values = list(points)
    return (
        sum(point[0] for point in values) / len(values),
        sum(point[1] for point in values) / len(values),
    )


def estimate_ride(distance_m: float) -> int:
    """Estimate a ride duration using the documented 41 km/h * 1.15 rule."""
    return max(MIN_RIDE_SEC, math.ceil(distance_m * RIDE_STRETCH / RIDE_SPEED_MPS))


def estimate_transfer(distance_m: float) -> int:
    """Estimate interchange walking time; runtime adds its fixed transfer penalty."""
    return max(MIN_TRANSFER_SEC, math.ceil(distance_m / WALK_SPEED_MPS))


def _pair_key(first: str, second: str) -> tuple[str, str]:
    return (first, second) if first < second else (second, first)


def _chain_line_ways(ways: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Chain one line's member ways into maximal connected track segments.

    OSM subway relations reference their track ways in arbitrary order; two
    ways connect when an endpoint coincides. Branches, small snapshot gaps and
    sidings produce several segments — ride edges pick the segment that
    actually covers both stations, so nothing here blocks the build.
    """
    segments: list[list[tuple[float, float]]] = []
    remaining = list(ways)
    while remaining:
        chain = remaining.pop(0)
        extended = True
        while extended and remaining:
            extended = False
            for index, way in enumerate(remaining):
                if way[0] == chain[-1]:
                    chain.extend(way[1:])
                elif way[-1] == chain[-1]:
                    chain.extend(point for point in reversed(way[:-1]))
                elif way[-1] == chain[0]:
                    chain = way[:-1] + chain
                elif way[0] == chain[0]:
                    chain = list(reversed(way[1:])) + chain
                else:
                    continue
                remaining.pop(index)
                extended = True
                break
        segments.append(chain)
    return segments


def _nearest_distance(chain: list[tuple[float, float]], point: tuple[float, float]) -> float:
    """Distance from one point to the nearest chain node."""
    return min(haversine_m(node, point) for node in chain) if chain else math.inf


def _nearest_distance_any(
    segments: list[list[tuple[float, float]]], point: tuple[float, float]
) -> float:
    """Distance from one point to the nearest node across all track segments."""
    return min((_nearest_distance(chain, point) for chain in segments), default=math.inf)


def _simplify(points: list[tuple[float, float]], min_step_m: float = 20.0) -> list[tuple[float, float]]:
    """Drop intermediate points closer than `min_step_m` to the previous kept one.

    Parallel track ways sit ~30–60 m apart; without this the sliced polyline
    zigzags between them at way joints. Real curves have gentler steps and
    survive.
    """
    kept = [points[0]]
    for point in points[1:]:
        if haversine_m(kept[-1], point) >= min_step_m:
            kept.append(point)
    kept.append(points[-1])
    return kept


MAX_TRACK_STEP_M = 400.0  # a real track never teleports between nodes


def _candidate_indices(
    chain: list[tuple[float, float]], point: tuple[float, float], tolerance_m: float
) -> list[int]:
    """All chain indices whose node lies within `tolerance_m` of the point."""
    return [index for index, node in enumerate(chain) if haversine_m(node, point) <= tolerance_m]


def _track_spans(
    chain: list[tuple[float, float]],
) -> list[tuple[list[tuple[float, float]], list[float]]]:
    """Cut a chained track into continuous spans with per-span length prefixes.

    Chained ways may interleave the parallel directional tracks with offsets; a
    span boundary at every oversized step guarantees each span is one
    continuous polyline, so any slice inside it never teleports. The prefix
    gives O(1) slice length when choosing the shortest span between stations.
    """
    spans: list[tuple[list[tuple[float, float]], list[float]]] = []
    current: list[tuple[float, float]] = [chain[0]]
    prefix: list[float] = [0.0]
    for node in chain[1:]:
        step = haversine_m(current[-1], node)
        if step > MAX_TRACK_STEP_M:
            spans.append((current, prefix))
            current = [node]
            prefix = [0.0]
        else:
            current.append(node)
            prefix.append(prefix[-1] + step)
    spans.append((current, prefix))
    return spans


def _edge_geometry(
    polylines: list[list[tuple[float, float]]],
    source_point: tuple[float, float],
    target_point: tuple[float, float],
) -> list[list[float]] | None:
    """Ride geometry: the line's own track nodes inside the station corridor.

    OSM line tracks interleave the two directional ways with gaps and
    out-of-order nodes, so slicing chains or routing way graphs kept producing
    teleports and figure-eights. The corridor construction is monotone by
    construction: every node of the line's own track within the station
    corridor is projected onto the A→B axis and sorted by projection — the
    polyline is continuous, follows the real bends, and can neither loop nor
    jump. Nodes outside the corridor (parallel lines, depots) are excluded.
    """
    track_nodes = [node for way in polylines for node in way]
    return _corridor_geometry(track_nodes, source_point, target_point)


def _corridor_geometry(
    track_nodes: list[tuple[float, float]],
    source_point: tuple[float, float],
    target_point: tuple[float, float],
) -> list[list[float]] | None:
    """Ride geometry fallback: track nodes inside the station corridor.

    The line's own track nodes projected onto the A→B axis and sorted by
    projection give a monotone, continuous polyline that follows the real
    bends; nodes outside the corridor (parallel lines, depots, far deviations
    of the opposite track) are excluded, so loops, figure-eights and
    teleports are impossible by construction.
    """
    chord = haversine_m(source_point, target_point)
    axis_lat, axis_lon = target_point[0] - source_point[0], target_point[1] - source_point[1]
    denominator = axis_lat * axis_lat + axis_lon * axis_lon
    if denominator == 0:
        return None
    corridor_tolerance = 350.0
    projected = []
    for node in track_nodes:
        t = ((node[0] - source_point[0]) * axis_lat + (node[1] - source_point[1]) * axis_lon) / denominator
        if not 0.0 <= t <= 1.0:
            continue
        foot = (source_point[0] + t * axis_lat, source_point[1] + t * axis_lon)
        if haversine_m(node, foot) <= corridor_tolerance:
            projected.append((t, node))
    if len(projected) < 4:
        return None
    projected.sort(key=lambda item: item[0])
    # Incremental 400 m cap on kept steps: sorting by projection alone cannot
    # create a teleport, but a node from a nearby foreign line could.
    kept = [projected[0][1]]
    for _, node in projected[1:]:
        if haversine_m(kept[-1], node) < 400.0:
            kept.append(node)
    simplified = _simplify(kept)
    if len(simplified) < 3:
        return None
    return [[round(point[0], 7), round(point[1], 7)] for point in simplified]


def build_resource(route: dict[str, Any], boundary: dict[str, Any]) -> dict[str, Any]:
    """Convert raw relations into strict stations, ride edges and reviewed transfers."""
    elements = route.get("elements")
    if not isinstance(elements, list):
        raise ValueError("route snapshot has no elements list")
    nodes = {element["id"]: element for element in elements if element.get("type") == "node"}
    relations = [
        element
        for element in elements
        if element.get("type") == "relation"
        and element.get("tags", {}).get("route") == "subway"
    ]
    if len(relations) != 34:
        raise ValueError(f"expected 34 subway route relations, found {len(relations)}")
    line4_names = {
        normalize_name(nodes[member["ref"]].get("tags", {}).get("name", ""))
        for relation in relations
        if relation.get("tags", {}).get("ref") == "4"
        for member in relation.get("members", [])
        if member.get("type") == "node"
        and str(member.get("role", "")).startswith("stop")
    }

    # A relation's stop members are ordered along one direction.  Build the
    # station platform groups first so opposite directions converge on one node.
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    sequences: list[list[tuple[str, str, tuple[float, float]]]] = []
    # Track geometry: one way-id-keyed collection per line so opposite
    # directions (which reference the same OSM ways) deduplicate naturally.
    ways_index = {
        element["id"]: element for element in elements if element.get("type") == "way"
    }
    line_ways: dict[str, dict[int, list[tuple[float, float]]]] = {}
    for relation in relations:
        raw_line = line_id(relation.get("tags", {}).get("ref") or "")
        if not raw_line:
            continue
        line_polylines = line_ways.setdefault(raw_line, {})
        for member in relation.get("members", []):
            way = ways_index.get(member.get("ref")) if member.get("type") == "way" else None
            if way is None:
                continue
            polyline = [
                (float(nodes[ref]["lat"]), float(nodes[ref]["lon"]))
                for ref in way.get("nodes", [])
                if ref in nodes and "lat" in nodes[ref]
            ]
            if len(polyline) >= 2:
                line_polylines[way["id"]] = polyline
    # A platform must sit on its line's own track: OSM occasionally carries
    # stop nodes named for a station but placed kilometres away (renamed or
    # planned stations). Such a phantom drags the group's mean point to a
    # wrong location and inflates every ride estimate through it.
    line_segments = {
        line: _chain_line_ways(list(polylines.values())) for line, polylines in line_ways.items()
    }
    PLATFORM_TRACK_TOLERANCE_M = 300.0
    dropped_stops: list[str] = []
    for relation in relations:
        raw_ref = relation.get("tags", {}).get("ref")
        if not raw_ref:
            raise ValueError(f"subway relation {relation.get('id')} has no ref")
        raw_line = line_id(raw_ref)
        segments = line_segments.get(raw_line, [])
        sequence: list[tuple[str, tuple[float, float]]] = []
        for member in relation.get("members", []):
            if member.get("type") != "node" or not str(member.get("role", "")).startswith("stop"):
                continue
            node = nodes.get(member.get("ref"))
            if node is None:
                raise ValueError(f"missing stop node {member.get('ref')}")
            tags = node.get("tags", {})
            name = tags.get("name")
            if not name or "lat" not in node or "lon" not in node:
                raise ValueError(f"incomplete stop node {member.get('ref')}")
            point = (float(node["lat"]), float(node["lon"]))
            if segments and _nearest_distance_any(segments, point) > PLATFORM_TRACK_TOLERANCE_M:
                dropped_stops.append(f"{raw_line}:{name}@{point[0]:.4f},{point[1]:.4f}")
                continue
            normalized = normalize_name(name)
            # The 4A branch shares its ordinary stops with line 4 but also has
            # branch-only stops. Keep those unique stops on raw line 4A so all
            # 17 raw line families remain represented.
            canonical = (
                "4"
                if raw_ref in {"4А", "4A"} and normalized in line4_names
                else line_id(raw_ref)
            )
            key = (canonical, normalized)
            group = grouped.setdefault(key, {"name": name, "points": []})
            group["points"].append(point)
            sequence.append((canonical, normalized, point))
        if len(sequence) < 2:
            raise ValueError(f"subway relation {relation.get('id')} has too few stops")
        sequences.append(sequence)
    if dropped_stops:
        print(f"dropped {len(dropped_stops)} off-track stop nodes: {', '.join(dropped_stops)}")

    station_ids = {
        key: f"m{key[0]}:{station_slug(group['name'])}"
        for key, group in grouped.items()
    }
    stations = []
    for key in sorted(grouped):
        group = grouped[key]
        lat, lon = mean_point(group["points"])
        stations.append(
            {
                "station_id": station_ids[key],
                "name": group["name"],
                "location": {"lat": round(lat, 7), "lon": round(lon, 7)},
                "line_id": key[0],
            }
        )

    rides: dict[tuple[str, str, str], dict[str, Any]] = {}
    for sequence in sequences:
        # Adjacent relation members can repeat only for an explicit loop closure;
        # keep the closing edge while removing accidental consecutive duplicates.
        collapsed: list[str] = []
        for station_line, normalized, _point in sequence:
            key = (station_line, normalized)
            if not collapsed or collapsed[-1] != station_ids[key]:
                collapsed.append(station_ids[key])
        for source, target in zip(collapsed, collapsed[1:]):
            if source == target:
                continue
            source_station = next(station for station in stations if station["station_id"] == source)
            target_station = next(station for station in stations if station["station_id"] == target)
            source_point = (source_station["location"]["lat"], source_station["location"]["lon"])
            target_point = (target_station["location"]["lat"], target_station["location"]["lon"])
            distance = round(haversine_m(source_point, target_point))
            key = (source, target, "ride")
            rides[key] = {
                "source": source,
                "target": target,
                "duration_sec": estimate_ride(distance),
                "distance_m": distance,
                "kind": "ride",
                # Track-following geometry; the chord between stations stays
                # the runtime fallback when the line chain cannot resolve it.
                "geometry": _edge_geometry(
                    line_ways.get(source_station["line_id"], {}).values(),
                    source_point,
                    target_point,
                ),
            }

    transfer_pairs: set[tuple[str, str]] = set()
    line_name_to_id = station_ids
    # Same-name interchanges are reviewed as the default rule, except for the
    # misleading Arbatskaya pair, which is intentionally not connected directly.
    names: dict[str, list[str]] = {}
    for line, normalized in grouped:
        names.setdefault(normalized, []).append(line)
    for normalized, lines in names.items():
        unique_lines = sorted(set(lines))
        for index, first_line in enumerate(unique_lines):
            for second_line in unique_lines[index + 1 :]:
                if normalized == "арбатская" and {first_line, second_line} == {"3", "4"}:
                    continue
                transfer_pairs.add(
                    _pair_key(line_name_to_id[(first_line, normalized)], line_name_to_id[(second_line, normalized)])
                )
    for first_line, first_name, second_line, second_name in TRANSFER_OVERRIDES:
        first_line, second_line = line_id(first_line), line_id(second_line)
        first = line_name_to_id.get((first_line, normalize_name(first_name)))
        second = line_name_to_id.get((second_line, normalize_name(second_name)))
        if first is None or second is None:
            raise ValueError(f"reviewed transfer missing station: {first_line}/{first_name} {second_line}/{second_name}")
        transfer_pairs.add(_pair_key(first, second))

    transfers: dict[tuple[str, str, str], dict[str, Any]] = {}
    station_by_id = {station["station_id"]: station for station in stations}
    for first, second in sorted(transfer_pairs):
        first_point = station_by_id[first]["location"]
        second_point = station_by_id[second]["location"]
        distance = round(haversine_m((first_point["lat"], first_point["lon"]), (second_point["lat"], second_point["lon"])))
        duration = estimate_transfer(distance)
        for source, target in ((first, second), (second, first)):
            transfers[(source, target, "transfer")] = {
                "source": source,
                "target": target,
                "duration_sec": duration,
                "distance_m": distance,
                "kind": "transfer",
            }

    edges = [rides[key] for key in sorted(rides)] + [transfers[key] for key in sorted(transfers)]
    geometry = boundary.get("geometry")
    if not isinstance(geometry, dict) or geometry.get("type") != "MultiPolygon":
        raise ValueError("Nominatim boundary must contain a MultiPolygon geometry")
    return {
        "schema_version": "1.0",
        "version": "moscow-osm-2026-09-22",
        "source": "OpenStreetMap Overpass 2026-09-22T08:15:26Z; Nominatim boundary admin 102269",
        "boundary_geojson": {"type": "MultiPolygon", "coordinates": geometry["coordinates"]},
        "stations": stations,
        "edges": edges,
        "enter_sec": 180,
        "exit_sec": 120,
        "wait_sec": 120,
        "transfer_sec": 240,
        "max_access_m": 1500,
    }


def write_json(path: Path, value: Any) -> bytes:
    """Write stable UTF-8 JSON and return the exact bytes written."""
    data = (json.dumps(value, ensure_ascii=False, indent=2, separators=(",", ": ")) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def main() -> None:
    """Build the artifact and manifest from local snapshots only."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    args = parser.parse_args()
    route_bytes, route_meta = load_snapshot(args.source_dir, args.raw_dir, ROUTE_FILE)
    boundary_bytes, boundary_meta = load_snapshot(args.source_dir, args.raw_dir, BOUNDARY_FILE)
    resource = build_resource(json.loads(route_bytes), json.loads(boundary_bytes))
    artifact_bytes = write_json(args.artifact, resource)
    manifest = {
        "manifest_version": "1.0",
        "converter": "data/metro/build_moscow.py",
        "provenance": {
            "routes": {
                "endpoint": "https://overpass-api.de/api/interpreter",
                "query": "[out:json][timeout:180]; relation[route=subway][network=Московский метрополитен](55.4,36.8,56.1,38.3); out body; >; out skel qt;",
                "retrieved_at": "2026-09-22T08:15:26Z",
            },
            "boundary": {
                "url": "https://nominatim.openstreetmap.org/lookup?osm_ids=R102269&format=jsonv2&polygon_geojson=1",
                "query": "osm_ids=R102269, format=jsonv2, polygon_geojson=1",
                "retrieved_at": "2026-09-22",
            },
        },
        "raw_inputs": [route_meta, boundary_meta],
        "artifact": {
            "path": "core/resources/metro/moscow.json",
            "bytes": len(artifact_bytes),
            "sha256": sha256(artifact_bytes),
        },
        "counts": {
            "stations": len(resource["stations"]),
            "edges": len(resource["edges"]),
            "ride_edges": sum(edge["kind"] == "ride" for edge in resource["edges"]),
            "transfer_edges": sum(edge["kind"] == "transfer" for edge in resource["edges"]),
            "line_ids": sorted({station["line_id"] for station in resource["stations"]}),
        },
        "method": {
            "ride_duration": "ceil(distance_m * 1.15 / 41 km/h), minimum 60 sec",
            "transfer_duration": "ceil(distance_m / 1.4 m/s), minimum 60 sec walking estimate; runtime adds 240 sec",
            "station_grouping": "normalized line/name across platform directions; shared line 4А stops canonicalized to line 4",
            "boundary": "Nominatim geometry for OSM relation 102269, includes New Moscow",
        },
    }
    write_json(args.manifest, manifest)
    print(json.dumps(manifest["counts"], ensure_ascii=False, sort_keys=True))
    print(manifest["artifact"]["sha256"])


if __name__ == "__main__":
    main()
