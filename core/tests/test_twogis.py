"""2GIS matrix preparation, cache and CLI contract tests."""

import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from core.contracts import GeoPoint
from core.geo import GraphTravel, RoadGraph
from core.runtime import parse_snapshot
from core.twogis import TwoGISConfig, TwoGISMatrixProvider

ROOT = Path(__file__).resolve().parents[2]
PROFILE_SECONDS = {
    "driving": 100,
    "walking": 200,
    "bicycle": 300,
    "public_transport": 400,
}


class FakeResponse:
    """Minimal HTTP response used by the provider boundary tests."""

    def __init__(self, status_code: int, payload: object):
        """Store an HTTP status and JSON-compatible response payload."""
        self.status_code = status_code
        self.payload = payload

    def json(self) -> object:
        """Return the controlled response payload."""
        return self.payload


def _config(tmp_path: Path, *, offline: bool = False) -> TwoGISConfig:
    return TwoGISConfig(
        dataset_version="moscow-test-v1",
        cache_dir=str(tmp_path / "cache"),
        offline=offline,
        traffic_mode="statistics",
    )


def _matrix_response(body: dict[str, object]) -> dict[str, object]:
    sources = body["sources"]
    targets = body["targets"]
    assert isinstance(sources, list)
    assert isinstance(targets, list)
    transport = body["transport"]
    assert isinstance(transport, str)
    factor = PROFILE_SECONDS[transport]
    routes = []
    for source in sources:
        for target in targets:
            assert isinstance(source, int)
            assert isinstance(target, int)
            difference = abs(source - target)
            routes.append(
                {
                    "status": "OK",
                    "source_id": source,
                    "target_id": target,
                    "distance": difference * 100,
                    "duration": difference * factor,
                }
            )
    return {"routes": routes}


def _load_example_snapshot():
    return parse_snapshot((ROOT / "core/examples/snapshot.json").read_bytes())


def test_prepares_all_profiles_and_replays_from_secret_free_cache(tmp_path, monkeypatch):
    """Map every Router profile to 2GIS and replay the exact graph offline."""
    calls: list[dict[str, object]] = []
    monkeypatch.setenv("TWOGIS_API_KEY", "super-secret-test-key")

    def fake_post(url, *, params, json, timeout):
        assert url == "https://routing.api.2gis.com/get_dist_matrix"
        assert params == {"key": "super-secret-test-key", "version": "2.0"}
        assert timeout == 15.0
        calls.append(json)
        return FakeResponse(200, _matrix_response(json))

    monkeypatch.setattr(httpx, "post", fake_post)
    snapshot = _load_example_snapshot()
    config = _config(tmp_path)
    graph = TwoGISMatrixProvider(config).build_graph(snapshot)

    assert [call["transport"] for call in calls] == [
        "driving",
        "walking",
        "bicycle",
        "public_transport",
    ]
    assert calls[0]["type"] == "statistics"
    assert calls[0]["start_time"] == "2026-08-17T06:00:00Z"
    assert calls[3]["public_transport_params"] == {
        "transport": config.transit_types,
        "enable_schedule": True,
    }
    travel = GraphTravel(graph)
    origin = snapshot.engineers[0].start_location
    destination = snapshot.requests[0].location
    assert travel.quote(origin, destination, "car").duration_sec == 100
    assert travel.quote(origin, destination, "walk").duration_sec == 200
    assert travel.quote(origin, destination, "bike").duration_sec == 300
    assert travel.quote(origin, destination, "transit").duration_sec == 400

    cache_bytes = b"".join(path.read_bytes() for path in (tmp_path / "cache").rglob("*.json"))
    assert b"super-secret-test-key" not in cache_bytes
    monkeypatch.delenv("TWOGIS_API_KEY")
    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: pytest.fail("offline HTTP call"))
    offline_graph = TwoGISMatrixProvider(config.model_copy(update={"offline": True})).build_graph(
        snapshot
    )
    assert offline_graph == graph


def test_cache_miss_and_http_errors_are_explicit_and_sanitized(tmp_path, monkeypatch):
    """Keep offline misses distinct and prevent API keys from leaking in failures."""
    snapshot = _load_example_snapshot()
    with pytest.raises(ValueError, match="TWOGIS_CACHE_MISS"):
        TwoGISMatrixProvider(_config(tmp_path, offline=True)).build_graph(
            snapshot, profiles=("car",)
        )

    monkeypatch.setenv("TWOGIS_API_KEY", "must-not-appear")
    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: FakeResponse(401, {}))
    with pytest.raises(ValueError, match="TWOGIS_HTTP_401") as error:
        TwoGISMatrixProvider(_config(tmp_path)).build_graph(snapshot, profiles=("car",))
    assert "must-not-appear" not in str(error.value)
    assert not list((tmp_path / "cache").rglob("*.json"))


def test_unreachable_routes_and_malformed_chunks_are_not_confused(tmp_path, monkeypatch):
    """Represent known no-route pairs as absent edges and reject incomplete data."""
    snapshot = _load_example_snapshot().model_copy(
        update={"requests": [_load_example_snapshot().requests[0]]}
    )
    monkeypatch.setenv("TWOGIS_API_KEY", "test-key")

    def no_route(_url, *, params, json, timeout):
        response = _matrix_response(json)
        for route in response["routes"]:
            if route["source_id"] != route["target_id"]:
                route["status"] = "ROUTE_NOT_FOUND"
        return FakeResponse(200, response)

    monkeypatch.setattr(httpx, "post", no_route)
    graph = TwoGISMatrixProvider(_config(tmp_path)).build_graph(snapshot, profiles=("walk",))
    assert (
        GraphTravel(graph).quote(
            snapshot.engineers[0].start_location, snapshot.requests[0].location, "walk"
        )
        is None
    )

    malformed_config = TwoGISConfig(
        dataset_version="malformed-v1",
        cache_dir=str(tmp_path / "malformed"),
        offline=False,
    )
    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: FakeResponse(200, {"routes": []}))
    with pytest.raises(ValueError, match="incomplete matrix chunk"):
        TwoGISMatrixProvider(malformed_config).build_graph(snapshot, profiles=("car",))
    assert not list((tmp_path / "malformed").rglob("*.json"))


def test_sync_matrix_is_chunked_at_configured_source_and_target_limits(tmp_path, monkeypatch):
    """Split a 26-point matrix into four synchronous requests."""
    snapshot = _load_example_snapshot()
    template = snapshot.requests[0]
    requests = [
        template.model_copy(
            update={
                "request_id": f"job-{index:02d}",
                "arrival_order": index,
                "location": GeoPoint(lat=55.75 + index * 0.001, lon=37.61),
            }
        )
        for index in range(25)
    ]
    snapshot = snapshot.model_copy(update={"requests": requests})
    calls = []
    monkeypatch.setenv("TWOGIS_API_KEY", "test-key")

    def fake_post(_url, *, params, json, timeout):
        calls.append(json)
        return FakeResponse(200, _matrix_response(json))

    monkeypatch.setattr(httpx, "post", fake_post)
    graph = TwoGISMatrixProvider(_config(tmp_path)).build_graph(snapshot, profiles=("car",))
    assert len(graph.nodes) == 26
    assert len(calls) == 4
    assert all(len(call["sources"]) <= 25 and len(call["targets"]) <= 25 for call in calls)


def test_graph_version_tracks_matrix_content_and_accepts_zero_cost_pair(tmp_path, monkeypatch):
    """Hash actual costs into the resource version and accept provider-defined zero travel."""
    snapshot = _load_example_snapshot().model_copy(
        update={"requests": [_load_example_snapshot().requests[0]]}
    )
    monkeypatch.setenv("TWOGIS_API_KEY", "test-key")

    def response_with(duration: int):
        def fake_post(_url, *, params, json, timeout):
            payload = _matrix_response(json)
            for route in payload["routes"]:
                if route["source_id"] != route["target_id"]:
                    route["distance"] = duration
                    route["duration"] = duration
            return FakeResponse(200, payload)

        return fake_post

    monkeypatch.setattr(httpx, "post", response_with(0))
    zero_graph = TwoGISMatrixProvider(_config(tmp_path / "zero")).build_graph(
        snapshot, profiles=("walk",)
    )
    quote = GraphTravel(zero_graph).quote(
        snapshot.engineers[0].start_location, snapshot.requests[0].location, "walk"
    )
    assert quote is not None and quote.duration_sec == quote.distance_m == 0

    monkeypatch.setattr(httpx, "post", response_with(17))
    changed_graph = TwoGISMatrixProvider(_config(tmp_path / "changed")).build_graph(
        snapshot, profiles=("walk",)
    )
    assert changed_graph.version != zero_graph.version


def test_prepare_2gis_cli_uses_prepared_cache_without_a_key(tmp_path, monkeypatch):
    """Exercise the documented preparation command through a real subprocess."""
    snapshot_path = ROOT / "core/examples/snapshot.json"
    snapshot = parse_snapshot(snapshot_path.read_bytes())
    online_config = _config(tmp_path)
    monkeypatch.setenv("TWOGIS_API_KEY", "test-key")
    monkeypatch.setattr(
        httpx,
        "post",
        lambda _url, *, params, json, timeout: FakeResponse(200, _matrix_response(json)),
    )
    TwoGISMatrixProvider(online_config).build_graph(snapshot)

    config_path = tmp_path / "2gis.json"
    config_path.write_text(
        online_config.model_copy(update={"offline": True}).model_dump_json(indent=2),
        encoding="utf-8",
    )
    output = tmp_path / "graph.json"
    environment = os.environ.copy()
    environment.pop("TWOGIS_API_KEY", None)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "core",
            "prepare-2gis",
            "--snapshot",
            str(snapshot_path),
            "--config",
            str(config_path),
            "--output",
            str(output),
        ],
        cwd=ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    graph = RoadGraph.model_validate_json(output.read_bytes())
    assert len(graph.nodes) == 4
    assert {next(iter(edge.duration_sec)) for edge in graph.edges} == {
        "car",
        "walk",
        "bike",
        "transit",
    }
