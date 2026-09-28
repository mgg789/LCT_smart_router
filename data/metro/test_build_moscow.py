"""Reproducibility and graph-contract checks for the offline metro artifact."""

from __future__ import annotations

import gzip
import json
import tempfile
from pathlib import Path

from data.metro.build_moscow import build_resource, deterministic_gzip, sha256


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

