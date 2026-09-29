"""Reproducibility and graph-contract checks for the offline metro artifact."""

from __future__ import annotations

import gzip
import json
import tempfile
from pathlib import Path

from data.metro.build_moscow import (
    _chain_line_ways,
    _edge_geometry,
    build_resource,
    deterministic_gzip,
    sha256,
)

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data/metro/raw"
ARTIFACT = ROOT / "core/resources/metro/moscow.json"
MANIFEST = ROOT / "data/metro/manifest.json"


def _resource() -> dict:
    """Load the generated resource using only checked-in compressed inputs."""
    with gzip.open(RAW / "moscow_subway_routes.json.gz", "rb") as stream:
        route = json.load(stream)
    with gzip.open(RAW / "moscow_boundary_nominatim.json.gz", "rb") as stream:
        boundary = json.load(stream)
    return build_resource(route, boundary)


def test_resource_shape_and_directed_connectivity() -> None:
    """Require the strict runtime shape and one connected directed component."""
    resource = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    assert set(resource) == {
        "schema_version", "version", "source", "boundary_geojson", "stations",
        "edges", "enter_sec", "exit_sec", "wait_sec", "transfer_sec", "max_access_m",
    }
    assert all(set(station) == {"station_id", "name", "location", "line_id"} for station in resource["stations"])
    base_edge_keys = {"source", "target", "duration_sec", "distance_m", "kind"}
    for edge in resource["edges"]:
        assert base_edge_keys <= set(edge) <= base_edge_keys | {"geometry"}
        geometry = edge.get("geometry")
        if geometry is not None:
            assert edge["kind"] == "ride" and len(geometry) >= 3
            assert all(
                len(point) == 2 and -90 <= point[0] <= 90 and -180 <= point[1] <= 180
                for point in geometry
            )
    station_ids = {station["station_id"] for station in resource["stations"]}
    adjacency = {station_id: [] for station_id in station_ids}
    for edge in resource["edges"]:
        assert edge["source"] in station_ids and edge["target"] in station_ids
        adjacency[edge["source"]].append(edge["target"])
    seen: set[str] = set()
    stack = [next(iter(station_ids))]
    while stack:
        station_id = stack.pop()
        if station_id in seen:
            continue
        seen.add(station_id)
        stack.extend(adjacency[station_id])
    assert seen == station_ids


def test_build_is_byte_reproducible_and_manifest_matches() -> None:
    """Require stable JSON serialization and a manifest hash for the artifact."""
    resource = _resource()
    expected = ARTIFACT.read_bytes()
    from data.metro.build_moscow import write_json

    with tempfile.TemporaryDirectory() as temporary:
        candidate = Path(temporary) / "moscow.json"
        assert write_json(candidate, resource) == expected
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["artifact"]["sha256"] == sha256(expected)


def test_raw_gzip_has_zero_mtime_and_stable_bytes() -> None:
    """Require checked-in raw snapshots to use deterministic gzip metadata."""
    for path in RAW.glob("*.json.gz"):
        compressed = path.read_bytes()
        assert compressed[4:8] == b"\x00\x00\x00\x00"
        assert compressed == deterministic_gzip(gzip.decompress(compressed))


def test_every_ride_reaches_both_stations_without_duplicate_vertices() -> None:
    """Catch the former truncated 3 km Volgogradsky-to-Tekstilshchiki line."""
    resource = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    stations = {s["station_id"]: s["location"] for s in resource["stations"]}
    for edge in resource["edges"]:
        if edge["kind"] != "ride":
            continue
        points = edge["geometry"]
        assert points and len(points) >= 3, (edge["source"], edge["target"])
        for endpoint, key in ((points[0], "source"), (points[-1], "target")):
            station = stations[edge[key]]
            assert endpoint == [station["lat"], station["lon"]]
        assert len({tuple(p) for p in points}) == len(points)


def test_tracks_stay_connected_and_keep_large_real_bends() -> None:
    """A parallel way and a sparse curve must not become a zigzag or get cut."""
    a, mid, b = (55.70, 37.60), (55.71, 37.615), (55.70, 37.63)
    way = [a, mid, b]
    parallel = [(lat + .0003, lon) for lat, lon in way]
    assert _edge_geometry([way, list(reversed(parallel))], a, b) == [list(a), list(mid), list(b)]


def test_chaining_does_not_mutate_original_osm_ways() -> None:
    """Station filtering must not silently join the builder's track inputs."""
    ways = [[(55.7, 37.6), (55.7, 37.61)], [(55.7, 37.61), (55.7, 37.62)]]
    original = [list(way) for way in ways]
    _chain_line_ways(ways)
    assert ways == original


def test_disconnected_tracks_do_not_get_an_invented_bridge() -> None:
    """A disconnected snapshot must explicitly fall back rather than teleport."""
    a, b = (55.7, 37.6), (55.7, 37.7)
    assert _edge_geometry([[a, (55.7, 37.61)], [(55.7, 37.69), b]], a, b) is None
