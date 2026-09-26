"""Real road costs are prepared once and shared by every planning entry point."""

import copy
from dataclasses import replace
from datetime import datetime

import httpx
import pytest
from core.engine import SearchSettings
from core.geo import GraphTravel, quote_at
from core.osrm import OSRMTravel
from core.planning_travel import PreparedRoadMatrix, planning_travel, prepare_osrm, prepare_road_api
from core.runtime import calculate, calculate_policy_comparison
from core.simulator import SimulationPatch, simulate_patch


def matrix(points):
    """A directed two-band road fixture, intentionally unlike straight-line distance."""
    return {
        "points": [point.model_dump() for point in points],
        "model_version": "test-forecast-v1",
        "forecast_timezone": "Europe/Moscow",
        "forecast_band_starts": [0, 480],
        "matrix": [
            [
                {"mode": "self", "distance_m": 0, "forecast_duration_s": [0, 0]}
                if i == j
                else {
                    "mode": "road",
                    "base_duration_s": 60 + i * 10 + j,
                    "distance_m": 600 + i * 100 + j,
                    "forecast_duration_s": [60 + i * 10 + j, 120 + i * 20 + j * 2],
                }
                for j in range(len(points))
            ]
            for i in range(len(points))
        ],
    }


def test_prepared_matrix_uses_departure_time_without_a_second_forecast(
    graph, snapshot, tmp_path, monkeypatch
):
    from core.geo import configure_travel

    points = [node.location for node in graph.nodes[:2]]
    calls = []
    monkeypatch.setenv("ROUTER_ROAD_API_URL", "http://roads.test")
    monkeypatch.setenv("ROUTER_ROAD_API_CACHE", str(tmp_path))

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(200, request=httpx.Request("GET", url), json=matrix(points))

    monkeypatch.setattr(httpx, "get", get)
    settings = SearchSettings(traffic_enabled=True, access_buffer_sec=0, metro_enabled=False)
    road = prepare_road_api(points, snapshot.planning_as_of, True, False)
    assert road is not None
    timed = configure_travel(road, settings.technical(), snapshot.planning_as_of)
    morning = int(datetime.fromisoformat("2026-09-26T07:59:00+03:00").timestamp())
    peak = morning + 60
    assert quote_at(timed, *points, "car", morning).duration_sec == 61
    assert quote_at(timed, *points, "car", peak).duration_sec == 122
    assert quote_at(timed, *reversed(points), "car", peak).duration_sec == 140
    assert len(calls) == 1 and calls[0][1]["params"]["planning"] == "1"
    monkeypatch.setattr(
        httpx, "get", lambda *_a, **_k: pytest.fail("offline matrix contacted HTTP")
    )
    replay = prepare_road_api(points, morning, True, True)
    assert replay.quote_at(*points, "car", peak) == road.quote_at(*points, "car", peak)
    static = prepare_road_api(points, morning, False, True)
    assert static.quote_at(*points, "car", peak).duration_sec == 61


def test_batch_preserves_no_route_and_rejects_malformed_costs(graph):
    points = [node.location for node in graph.nodes[:2]]
    payload = matrix(points)
    payload["matrix"][0][1] = {"mode": "unreachable"}
    provider = PreparedRoadMatrix(points, payload, "ctx", 0, True)
    assert provider.quote(*points, "car") is None
    assert provider.quote(*reversed(points), "car") is not None
    invalid = copy.deepcopy(payload)
    invalid["matrix"][1][0]["distance_m"] = float("nan")
    with pytest.raises(ValueError, match="matrix cost"):
        PreparedRoadMatrix(points, invalid, "ctx", 0, True)
    invalid = copy.deepcopy(payload)
    invalid["points"].reverse()
    with pytest.raises(ValueError, match="point order"):
        PreparedRoadMatrix(points, invalid, "ctx", 0, True)


def test_runtime_and_simulation_use_supplied_directed_graph(snapshot, graph):
    settings = SearchSettings(
        time_limit_ms=100, access_buffer_sec=0, traffic_enabled=False, metro_enabled=False
    )
    raw = snapshot.model_dump_json().encode()
    result, output = calculate(raw, graph, settings, "ctx", publication_id="pub")
    assert result.status == "ready" and output is not None
    assert result.main.summary.distance_km == 1.8
    assert result.main.summary.travel_time_sec == 180
    assert all(
        leg.travel_source == "road_matrix" for route in result.main.routes for leg in route.legs
    )
    simulated = simulate_patch(
        raw,
        settings,
        "ctx",
        SimulationPatch(policy_id="fast"),
        result.main,
        publication_id="pub",
        graph=graph,
    )
    assert simulated["delta"]["after"]["distance_km"] == 1.8
    compared = calculate_policy_comparison(raw, "pub", graph, settings, "ctx", 100, offline=True)
    assert (
        next(row for row in compared.rows if row.strategy_id == "baseline").summary
        == result.baseline.summary
    )


def test_unavailable_road_service_keeps_regional_graph(snapshot, graph, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setenv("ROUTER_ROAD_API_URL", "http://roads.test")
    monkeypatch.setenv("ROUTER_ROAD_API_CACHE", str(tmp_path))

    def get(url, **kwargs):
        calls.append(url)
        raise httpx.ReadTimeout("unavailable")

    monkeypatch.setattr(httpx, "get", get)
    settings = SearchSettings(traffic_enabled=False, access_buffer_sec=0, metro_enabled=False)
    travel = planning_travel(graph, settings, snapshot)
    base = GraphTravel(graph)
    for source in graph.nodes:
        for target in graph.nodes:
            actual = travel.quote(source.location, target.location, "car")
            expected = base.quote(source.location, target.location, "car")
            assert actual is not None
            assert expected is not None
            # The wrapper records calm-weather provenance without changing any road cost.
            assert actual == (
                replace(expected, weather_multiplier_used=1.0) if expected.distance_m else expected
            )
    assert len(calls) == 1
    assert not list(tmp_path.rglob("*.json"))


def test_native_osrm_table_is_directed_cached_and_non_mutating(graph, tmp_path, monkeypatch):
    points = [node.location for node in graph.nodes[:2]]
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={
                "code": "Ok",
                "durations": [[0, 61], [None, 0]],
                "distances": [[0, 601], [None, 0]],
            },
        )

    monkeypatch.setattr(httpx, "get", get)
    provider = OSRMTravel({"car": "http://osrm.test"}, "map-v1", tmp_path, False)
    prepared = prepare_osrm(provider, points, False)
    assert prepared.quote(*points, "car").duration_sec == 61
    assert prepared.quote(*reversed(points), "car") is None
    assert "/table/v1/driving/" in calls[0][0]
    assert calls[0][1]["params"]["sources"] == "0;1"
    monkeypatch.setattr(httpx, "get", lambda *_a, **_k: pytest.fail("unexpected network request"))
    assert prepare_osrm(provider, points, True).quote(*points, "car") == prepared.quote(
        *points, "car"
    )


def test_imported_roads_apply_timing_once(snapshot, graph):
    from core.roadimport import ImportedRoadOverlay

    settings = SearchSettings(traffic_enabled=False, access_buffer_sec=100, metro_enabled=False)
    overlay = ImportedRoadOverlay(
        GraphTravel(graph), graph.model_copy(update={"version": "import-v1"})
    )
    travel = planning_travel(overlay, settings, snapshot, offline=True)
    assert travel.quote(graph.nodes[0].location, graph.nodes[1].location, "car").duration_sec == 160
