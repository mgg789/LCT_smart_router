"""Focused service tests for directed metro, timetable, hashes, and versions."""

import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2] / "services/route-engine3"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _artifact():
    return {
        "version": "metro-test-v1",
        "stations": [
            {"station_id": "a", "name": "A", "line_id": "1", "location": {"lat": 55.75, "lon": 37.60}},
            {"station_id": "b", "name": "B", "line_id": "1", "location": {"lat": 55.76, "lon": 37.61}},
            {"station_id": "c", "name": "C", "line_id": "2", "location": {"lat": 55.77, "lon": 37.62}},
            {"station_id": "d", "name": "D", "line_id": "2", "location": {"lat": 55.78, "lon": 37.63}},
        ],
        "edges": [
            {"source": "a", "target": "b", "duration_sec": 60, "distance_m": 1000, "kind": "ride", "geometry": [[55.75, 37.60], [55.755, 37.605], [55.76, 37.61]]},
            {"source": "b", "target": "c", "duration_sec": 30, "distance_m": 100, "kind": "transfer", "geometry": [[55.76, 37.61], [55.77, 37.62]]},
            {"source": "c", "target": "d", "duration_sec": 60, "distance_m": 1000, "kind": "ride", "geometry": [[55.77, 37.62], [55.775, 37.625], [55.78, 37.63]]},
        ],
    }


def test_directed_edges_keep_geometry_and_timed_boarding(tmp_path, monkeypatch):
    sandbox = tmp_path / "service"
    sandbox.mkdir()
    for name in ("metro.py", "metro_timetable.py"):
        (sandbox / name).write_bytes((ROOT / name).read_bytes())
    monkeypatch.syspath_prepend(str(sandbox))
    metro = _load("route_engine3_service_metro", sandbox / "metro.py")
    network = metro.MetroService(_artifact())

    static = network.ride_path("a", "d")
    assert static["duration_sec"] == 210  # 60 + transfer (30 + penalty 60) + 60
    assert static["geometry"] == [
        [55.75, 37.60], [55.755, 37.605], [55.76, 37.61],
        [55.77, 37.62], [55.775, 37.625], [55.78, 37.63],
    ]
    assert network.ride_path("d", "a") is None

    ready = int(datetime(2026, 9, 29, 7, 30, tzinfo=ZoneInfo("Europe/Moscow")).timestamp())
    timed = network.ride_path("a", "d", departure_at=ready)
    # Initial train waits at the source; the same-line ride does not wait again,
    # while transfer boarding waits for the next departure.
    assert timed["duration_sec"] > static["duration_sec"]
    assert timed["duration_sec"] == 60 + 30 + 60 + 30 + 60


def test_graph_content_hash_is_discovery_snapshot(tmp_path):
    graphs = _load("route_engine3_service_graphs", ROOT / "graphs.py")
    graph_dir = tmp_path / "car"
    graph_dir.mkdir()
    (graph_dir / "city.osrm").write_bytes(b"page-a")
    (graph_dir / "graph.json").write_text(
        json.dumps({"profile": "car", "map_version": "test"}), encoding="utf-8"
    )
    first = graphs.discover_graphs(tmp_path)[0].content_hash
    (graph_dir / "city.osrm").write_bytes(b"page-b")
    second = graphs.discover_graphs(tmp_path)[0].content_hash
    assert first != second
