"""Strict OSRM resource import and persistent directed-profile merge tests."""

import gzip
import json

import pytest
from core.api import create_app
from core.geo import content_hash
from core.roadimport import RoadGraphStore, RoadImportError, import_into_runtime
from core.runtime import RouterRuntime, SnapshotPublication
from fastapi.testclient import TestClient


class Reader:
    """Minimal immutable publication reader for runtime/API integration tests."""

    def __init__(self, raw: bytes):
        self.raw = raw

    def read(self) -> SnapshotPublication:
        return SnapshotPublication("road-import-test", 0, self.raw, content_hash(self.raw), 0)


def _graph(profile: str = "car", duration: int = 10) -> dict:
    return {
        "version": "fixture",
        "source": "test",
        "nodes": [
            {"id": "a", "lat": 55.70, "lon": 37.60},
            {"id": "b", "lat": 55.71, "lon": 37.61},
        ],
        "edges": [
            {
                "from": "a",
                "to": "b",
                "profile": profile,
                "distance_m": 100,
                "duration_sec": duration,
                "geometry": [[37.60, 55.70], [37.61, 55.71]],
            }
        ],
    }


def test_import_merges_directed_profiles_and_replays_atomically(tmp_path):
    store = RoadGraphStore(tmp_path / "roads.json")
    first = store.import_bytes("op-car", json.dumps(_graph()).encode())
    second = store.import_bytes("op-walk", json.dumps(_graph("walk", 20)).encode())
    replay = store.import_bytes("op-walk", json.dumps(_graph("walk", 20)).encode())

    assert first.status == "accepted"
    assert second.status == "accepted"
    assert replay.status == "replayed"
    graph = store.load()
    assert graph is not None
    assert graph.edges[0].duration_sec == {"car": 10, "walk": 20}
    document = json.loads((tmp_path / "roads.json").read_text())
    assert document["format"] == "road-import-store/v1"
    assert sorted(document["operations"]) == ["op-car", "op-walk"]


def test_native_osrm_table_is_directed_and_gzip_is_supported(tmp_path):
    payload = {
        "profile": "car",
        "sources": [{"location": [37.60, 55.70]}],
        "destinations": [{"location": [37.61, 55.71]}],
        "durations": [[11]],
        "distances": [[101]],
    }
    store = RoadGraphStore(tmp_path / "roads.json")
    result = store.import_bytes("op", gzip.compress(json.dumps(payload).encode()))
    assert result.profiles == ("car",)
    assert store.load() is not None


def test_duplicate_profile_and_coordinate_conflicts_are_rejected(tmp_path):
    store = RoadGraphStore(tmp_path / "roads.json")
    store.import_bytes("first", json.dumps(_graph()).encode())
    with pytest.raises(RoadImportError, match="duplicate"):
        store.import_bytes("second", json.dumps(_graph()).encode())
    invalid = _graph("walk", 20)
    invalid["nodes"][1]["lat"] = 55.72
    invalid["edges"][0]["geometry"][1][1] = 55.72
    with pytest.raises(RoadImportError, match="coordinates"):
        store.import_bytes("third", json.dumps(invalid).encode())
    with pytest.raises(RoadImportError, match="profile"):
        store.import_bytes("profile-conflict", json.dumps(_graph()).encode(), profile="walk")


def test_duplicate_json_keys_and_oversized_payload_are_rejected(tmp_path):
    with pytest.raises(RoadImportError, match="duplicate"):
        RoadGraphStore(tmp_path / "roads.json").import_bytes(
            "duplicate", b'{"nodes": [], "nodes": [], "edges": []}'
        )


def test_runtime_activation_reports_the_new_context(tmp_path):
    class Runtime:
        context_version = "before"

        def update_road_overlay(self, graph):
            self.graph = graph
            self.context_version = graph.version

    runtime = Runtime()
    result = import_into_runtime(runtime, RoadGraphStore(tmp_path / "roads.json"), "op", json.dumps(_graph()).encode())
    assert result.router_context_version == result.graph_version
    assert runtime.graph.version == result.graph_version


def test_navix_overlay_uses_exact_import_then_base_graph_fallback(tmp_path, graph, snapshot):
    """Imported coordinates override their leg but do not discard the configured graph."""
    store = RoadGraphStore(tmp_path / "road-import.json")
    runtime = RouterRuntime(Reader(snapshot.model_dump_json().encode()), graph)
    payload = {
        "format": "navix-road-overlay/v1",
        "version": "fixture-overlay",
        "profile": "car",
        "edges": [{
            "coordinates": [[37.61, 55.75], [37.62, 55.75]],
            "duration_sec": 7,
            "distance_m": 600,
            "geometry": [[37.61, 55.75], [37.62, 55.75]],
        }],
    }
    import_into_runtime(runtime, store, "overlay-1", json.dumps(payload).encode())
    assert runtime._graph.quote(graph.nodes[1].location, graph.nodes[2].location, "car").duration_sec == 7
    assert runtime._graph.quote(graph.nodes[0].location, graph.nodes[1].location, "car").duration_sec == 60
    runtime.close()


def test_api_import_activates_and_rehydrates_overlay_after_restart(tmp_path, graph, snapshot):
    """The default API store is durable and keeps the original provider as fallback."""
    store = RoadGraphStore(tmp_path / "road-import.json")
    payload = json.dumps(
        {
            "format": "navix-road-overlay/v1",
            "profile": "car",
            "edges": [{
                "coordinates": [[37.60, 55.75], [37.61, 55.75]],
                "duration_sec": 10,
                "distance_m": 600,
            }],
        }
    ).encode()
    runtime = RouterRuntime(Reader(snapshot.model_dump_json().encode()), graph)
    with TestClient(create_app(runtime, store)) as client:
        before = client.get("/v1/context").json()["router_context_version"]
        response = client.post(
            "/v1/road-import",
            headers={"x-operation-id": "api-1", "x-road-profile": "car"},
            content=payload,
        )
        assert response.status_code == 200, response.text
        after = response.json()["router_context_version"]
        assert after != before
        replay = client.post(
            "/v1/road-import",
            headers={"x-operation-id": "api-1", "x-road-profile": "car"},
            content=payload,
        )
        assert replay.json()["status"] == "replayed"
    restarted = RouterRuntime(Reader(snapshot.model_dump_json().encode()), graph)
    with TestClient(create_app(restarted, store)) as client:
        assert client.get("/v1/context").json()["router_context_version"] == after
        assert restarted._graph.quote(graph.nodes[0].location, graph.nodes[1].location, "car").duration_sec == 10
        assert restarted._graph.quote(graph.nodes[2].location, graph.nodes[3].location, "car").duration_sec == 60
