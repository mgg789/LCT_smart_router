"""route-engine3 core adapter: quotes, prepared matrices, verification."""


import pytest
from core.contracts import GeoPoint
from core.geo import TravelUnavailable
from core.route3 import (
    PreparedRoute3Matrix,
    Route3Client,
    prepare_route3,
    quote_from_route3,
)
from pydantic import ValidationError

A = GeoPoint(lat=55.75, lon=37.60)
B = GeoPoint(lat=55.78, lon=37.66)


def test_quote_from_route3_provenance_and_segments():
    road = quote_from_route3(
        {
            "mode": "road",
            "duration_s": 600.4,
            "distance_m": 5000.1,
            "effective_factor": 1.5,
            "traffic_applied": True,
            "geometry": [[55.75, 37.60], [55.78, 37.66]],
        },
        A,
        B,
    )
    assert road.provenance == "traffic_api"
    assert road.duration_sec == 601
    assert road.traffic_factor == 1.5
    assert road.geometry_exact is True
    composite = quote_from_route3(
        {
            "mode": "metro_composite",
            "duration_s": 1500.0,
            "distance_m": 6000.0,
            "geometry": [[55.75, 37.60]],
            "segments": [
                {"kind": "walk", "duration_s": 400, "distance_m": 500, "geometry": [[55.75, 37.60]]},
                {"kind": "metro", "duration_s": 1100, "distance_m": 5500},
            ],
        },
        A,
        B,
    )
    assert composite.provenance == "metro"
    assert [segment.provenance for segment in composite.segments] == ["route_api", "metro"]
    assert composite.segments[0].points[0] == GeoPoint(lat=55.75, lon=37.60)
    residual = quote_from_route3(
        {
            "mode": "metro_composite",
            "duration_s": 1500.2,
            "distance_m": 6000.4,
            "segments": [
                {"kind": "walk", "duration_s": 400.2, "distance_m": 500.2},
                {"kind": "metro", "duration_s": 1100.1, "distance_m": 5500.1},
            ],
        },
        A,
        B,
    )
    assert residual is not None
    assert sum(segment.duration_sec for segment in residual.segments) == residual.duration_sec
    assert sum(segment.distance_m for segment in residual.segments) == residual.distance_m
    straight = quote_from_route3({"mode": "straight", "duration_s": 10, "distance_m": 100}, A, B)
    assert straight.provenance == "approximate" and straight.geometry_exact is False
    assert quote_from_route3({"mode": "unreachable"}, A, B) is None


def _matrix_body(profile, durations):
    return {
        "profile": profile,
        "points": [[A.lat, A.lon], [B.lat, B.lon]],
        "matrix": durations,
    }


def test_prepared_route3_matrix_car_bands_and_walk_flat():
    car = _matrix_body(
        "car",
        [
            [{"mode": "self"}, {"mode": "road", "base_duration_s": 600, "distance_m": 5000,
                                "duration_s": 690,
                                "forecast_duration_s": [600, 800, 690, 610]}],
            [{"mode": "unreachable"}, {"mode": "self"}],
        ],
    )
    car["forecast_band_starts"] = [0, 420, 630, 960]
    walk = _matrix_body(
        "walk",
        [
            [{"mode": "self"}, {"mode": "road", "duration_s": 3600, "distance_m": 5000}],
            [{"mode": "unreachable"}, {"mode": "self"}],
        ],
    )
    matrix = PreparedRoute3Matrix("client-v1", {"car": car, "walk": walk}, [A, B])
    assert matrix.profiles == frozenset({"car", "walk"})
    night = matrix.quote_at(A, B, "car", 1786924800)  # 03:00 Moscow → band 0
    assert night.duration_sec == 600
    peak = matrix.quote_at(A, B, "car", 1786946400)  # 09:00 Moscow → morning band
    assert peak.duration_sec == 800 and peak.traffic_factor == round(800 / 600, 2)
    walk_quote = matrix.quote_at(A, B, "walk", 0)
    assert walk_quote.duration_sec == 3600
    assert matrix.quote_at(B, A, "car", 0) is None  # unreachable is honest NoRoute
    with pytest.raises(TravelUnavailable):
        matrix.quote_at(GeoPoint(lat=1.0, lon=2.0), B, "car", 0)
    with pytest.raises(TravelUnavailable):
        matrix.quote_at(A, B, "bike", 0)  # profile not prepared


class _Base:
    version = "base-v1"
    provenance = "road_matrix"

    def __init__(self):
        self.asked = []

    def quote(self, origin, destination, profile):
        from core.geo import TravelQuote

        self.asked.append(profile)
        return TravelQuote(99, 999, (origin, destination), "road_matrix")


def test_pedestrian_search_costs_come_from_the_route3_foot_graph():
    from core.route3 import Route3PedestrianTravel

    walk = _matrix_body(
        "walk",
        [
            [{"mode": "self"}, {"mode": "road", "duration_s": 1446, "distance_m": 2008.3}],
            [{"mode": "unreachable"}, {"mode": "self"}],
        ],
    )
    base = _Base()
    travel = Route3PedestrianTravel(base, PreparedRoute3Matrix("client-v1", {"walk": walk}, [A, B]))
    foot = travel.quote(A, B, "walk")
    assert (foot.duration_sec, foot.distance_m) == (1446, 2009)
    assert base.asked == []
    # A car and an out-of-graph foot cell keep the base estimate: no edge disappears.
    assert travel.quote(A, B, "car").duration_sec == 99
    assert travel.quote(B, A, "walk").duration_sec == 99
    assert base.asked == ["car", "walk"]


def test_verified_metro_composite_is_not_a_walk_only_answer():
    from core.geo import TravelQuote
    from core.route3 import VerifiedRoute3

    composite = TravelQuote(1500, 6000, (A, B), "metro")
    corrections = {(A.lat, A.lon, B.lat, B.lon, "transit"): composite}
    verified = VerifiedRoute3(_Base(), corrections)
    assert verified.quote(A, B, "walk").provenance == "road_matrix"
    assert verified.quote(A, B, "transit") is composite


def test_verification_asks_metro_only_for_transit_when_enabled():
    from types import SimpleNamespace

    from core.route3 import verify_plan_with_route3

    calls = []

    class Client:
        def route(self, origin, destination, profile, *, traffic, metro, departure):
            calls.append((profile, metro))
            return {"mode": "road", "duration_s": 60, "distance_m": 100, "geometry": []}

    def snapshot(profile):
        engineer = SimpleNamespace(engineer_id="e", travel_profile=lambda: profile)
        return SimpleNamespace(engineers=[engineer], requests=[], planning_as_of=0)

    stop = SimpleNamespace(stop_id="s", kind="job", request_id="r", location=B, arrival_at=0)
    plan = SimpleNamespace(
        routes=[SimpleNamespace(engineer_id="e", start_location=A, stops=[stop], legs=[])]
    )
    verify_plan_with_route3(Client(), snapshot("transit"), plan, metro=True)
    verify_plan_with_route3(Client(), snapshot("transit"), plan, metro=False)
    verify_plan_with_route3(Client(), snapshot("walk"), plan, metro=True)
    assert calls == [("transit", True), ("transit", False), ("walk", False)]


def test_prepared_route3_matrix_rejects_mismatch():
    bad = _matrix_body("car", [[{"mode": "nonsense"}], [{"mode": "self"}]])
    with pytest.raises((ValueError, ValidationError)):
        PreparedRoute3Matrix("client-v1", {"car": bad}, [A, B])


def test_prepare_route3_caches_per_profile_and_degrades(tmp_path, monkeypatch):
    monkeypatch.delenv("ROUTE3_ALLOW_PUBLIC", raising=False)
    client = Route3Client("http://127.0.0.1:8124", cache_dir=tmp_path / "cache")
    calls = []

    def matrix(points, profile, *, traffic, planning, departure):
        calls.append(profile)
        body = _matrix_body(
            profile,
            [[{"mode": "self"}, {"mode": "road", "duration_s": 600, "distance_m": 5000}],
             [{"mode": "unreachable"}, {"mode": "self"}]],
        )
        if profile == "car" and traffic:
            body["forecast_band_starts"] = [0, 420, 630, 960, 1230]
        return body

    monkeypatch.setattr(client, "matrix", matrix)
    prepared = prepare_route3(client, [A, B], departure=1786946400)
    assert prepared is not None and prepared.profiles == frozenset({"car", "walk", "bike"})
    assert calls == ["car", "walk", "bike"]
    warm = prepare_route3(client, [A, B], departure=1786946400)
    assert warm is not None and calls == ["car", "walk", "bike"]  # no new HTTP

    def failing(points, profile, *, traffic, planning, departure):
        raise ConnectionError("engine down")

    monkeypatch.setattr(client, "matrix", failing)
    cold = Route3Client("http://127.0.0.1:8124", cache_dir=tmp_path / "cold")
    monkeypatch.setattr(cold, "matrix", failing)
    degraded = prepare_route3(cold, [A, B], departure=1786946400)
    assert degraded is None  # cold cache + dead engine = no route3 source

    offline = Route3Client("http://127.0.0.1:8124", cache_dir=tmp_path / "offline", offline=True)
    assert prepare_route3(offline, [A, B], departure=1786946400) is None


def test_validate_route3_base_blocks_public_hosts(monkeypatch):
    import socket

    from core.route3 import _validate_route3_base

    monkeypatch.delenv("ROUTE3_ALLOW_PUBLIC", raising=False)
    assert _validate_route3_base("http://127.0.0.1:8124") == "http://127.0.0.1:8124"
    assert _validate_route3_base("http://localhost:8124") == "http://localhost:8124"
    # Compose aliases resolve into private container addresses on deploy.
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, **_: [(socket.AF_INET, None, None, "", ("172.18.0.5", 0))],
    )
    assert _validate_route3_base("http://route-engine3:8124") == "http://route-engine3:8124"
    # Public DNS answers make the endpoint a rejected SSRF pivot.
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, **_: [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))],
    )
    with pytest.raises(ValueError):
        _validate_route3_base("https://example.com/route3")
    monkeypatch.setenv("ROUTE3_ALLOW_PUBLIC", "1")
    assert _validate_route3_base("https://example.com/route3") == "https://example.com/route3"


def test_route3_from_env_degrades_on_rejected_url(monkeypatch, tmp_path):
    from core.route3 import route3_from_env

    monkeypatch.delenv("ROUTE3_ALLOW_PUBLIC", raising=False)
    monkeypatch.delenv("ROUTE3_URL", raising=False)
    assert route3_from_env() is None
    monkeypatch.setenv("ROUTE3_URL", "http://127.0.0.1:8124")
    monkeypatch.setenv("ROUTE3_CACHE", str(tmp_path))
    client = route3_from_env()
    assert client is not None and client.base_url == "http://127.0.0.1:8124"
    # A public endpoint disables the adapters instead of failing the router.
    monkeypatch.setenv("ROUTE3_URL", "https://example.com/route3")
    assert route3_from_env() is None
