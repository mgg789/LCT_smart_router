"""MKAD road-api quotes stay on cars and keep the provider's own traffic."""

import httpx
import pytest
from core.contracts import GeoPoint
from core.road_api import RoadApiTravel, decode_road_api


def test_decode_keeps_road_geometry_and_does_not_invent_a_second_traffic_pass():
    """A road payload is an exact polyline; its factor is already the forecast."""
    quote = decode_road_api(
        {
            "mode": "road",
            "duration_s": 640.2,
            "distance_m": 4100.4,
            "effective_factor": 1.45,
            "geometry": [[55.72, 37.75], [55.73, 37.76], [55.74, 37.77]],
        }
    )
    assert quote.provenance == "traffic_api"
    assert quote.geometry_exact is True
    assert quote.duration_sec == 641
    assert quote.distance_m == 4101
    assert quote.traffic_factor == 1.45
    assert quote.points[0] == GeoPoint(lat=55.72, lon=37.75)


def test_decode_marks_an_outside_mkad_connector_as_inexact():
    """Outside the ring the API returns a straight connector, not a road polyline."""
    quote = decode_road_api(
        {
            "mode": "straight",
            "duration_s": 100,
            "distance_m": 800,
            "effective_factor": 1.1,
            "geometry": [[55.1, 37.1], [55.2, 37.2]],
        }
    )
    assert quote.geometry_exact is False
    assert quote.provenance == "traffic_api"


def test_road_api_replaces_a_prepared_car_leg_and_leaves_walking(tmp_path, graph, monkeypatch):
    """Cars inside Moscow use the road API even when the prepared graph is road-quality."""
    from core.geo import GraphTravel, MixedTravel

    monkeypatch.setattr("core.geo._road_quality_node", lambda *_args: True)
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs.get("params"), kwargs.get("timeout")))
        return httpx.Response(
            200,
            json={
                "mode": "road",
                "duration_s": 500,
                "distance_m": 3000,
                "effective_factor": 1.2,
                "geometry": [[55.7, 37.6], [55.71, 37.61]],
            },
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", get)
    mixed = MixedTravel(GraphTravel(graph), RoadApiTravel("http://roads.test", tmp_path))
    origin, destination = graph.nodes[0].location, graph.nodes[1].location
    car = mixed.quote_at(origin, destination, "car", 1_700_000_000)
    walking = mixed.quote(origin, destination, "walk")
    assert car is not None and car.provenance == "traffic_api" and car.duration_sec == 500
    assert walking == GraphTravel(graph).quote(origin, destination, "walk")
    assert calls[0][1]["departure"] == "1700000000"
    assert calls[0][2] == 3.0
    assert len(list(tmp_path.rglob("*.json"))) == 1


def test_road_api_outage_falls_back_to_the_prepared_graph(tmp_path, graph, monkeypatch, caplog):
    """One failed car request does not turn the whole day into network retries."""

    def get(url, **kwargs):
        return httpx.Response(503, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", get)
    from core.geo import GraphTravel, MixedTravel

    monkeypatch.setattr("core.geo._road_quality_node", lambda *_args: True)
    mixed = MixedTravel(GraphTravel(graph), RoadApiTravel("http://roads.test", tmp_path))
    origin, destination = graph.nodes[0].location, graph.nodes[1].location
    base = GraphTravel(graph).quote(origin, destination, "car")
    assert mixed.quote(origin, destination, "car") == base
    assert mixed.quote(origin, destination, "car") == base
    assert (
        len([record for record in caplog.records if "TRAVEL_OVERLAY_UNAVAILABLE" in record.message])
        == 1
    )


def test_missing_road_api_url_leaves_osrm_in_charge(monkeypatch):
    """No road-api URL means compose_live_overlay returns the OSRM provider unchanged."""
    from core.road_api import compose_live_overlay

    monkeypatch.delenv("ROUTER_ROAD_API_URL", raising=False)
    sentinel = object()
    assert compose_live_overlay(sentinel) is sentinel
    assert compose_live_overlay(None) is None


def test_invalid_mode_is_rejected():
    """A payload without road or straight is not a quote."""
    with pytest.raises(ValueError):
        decode_road_api({"mode": "metro", "duration_s": 1, "distance_m": 1, "geometry": []})
