"""Provider contract with real HTTP request formatting and durable offline reuse."""

import httpx
import pytest
from core.osrm import OSRMTravel


def test_legacy_endpoint_is_car_only(tmp_path, monkeypatch):
    """Changing a URL path cannot change a server's extracted transport profile."""
    from core.osrm import live_osrm_from_env

    monkeypatch.setenv("ROUTER_OSRM_URL", "http://car.test")
    monkeypatch.setenv("ROUTER_OSRM_CACHE", str(tmp_path))
    for profile in ("CAR", "WALK", "BIKE"):
        monkeypatch.delenv(f"ROUTER_OSRM_{profile}_URL", raising=False)
    provider = live_osrm_from_env()
    assert provider is not None
    assert provider.endpoints == {"car": "http://car.test"}


def test_explicit_profiles_do_not_require_a_car_endpoint(tmp_path, monkeypatch):
    """Each prepared road profile is opt-in; OSRM is not a transit scheduler."""
    from core.osrm import live_osrm_from_env

    monkeypatch.delenv("ROUTER_OSRM_URL", raising=False)
    monkeypatch.delenv("ROUTER_OSRM_CAR_URL", raising=False)
    monkeypatch.setenv("ROUTER_OSRM_WALK_URL", "http://walk.test")
    monkeypatch.setenv("ROUTER_OSRM_BIKE_URL", "http://bike.test")
    monkeypatch.setenv("ROUTER_OSRM_CACHE", str(tmp_path))
    provider = live_osrm_from_env()
    assert provider is not None
    assert provider.endpoints == {"walk": "http://walk.test", "bike": "http://bike.test"}


def test_overlay_preserves_unconfigured_transport(tmp_path, graph, monkeypatch):
    """Car-only live routing must not overwrite local walking or transit costs."""
    from core.geo import GraphTravel, MixedTravel

    calls = []
    monkeypatch.setattr(httpx, "get", lambda *args, **kwargs: calls.append(args))
    base = GraphTravel(graph)
    provider = OSRMTravel({"car": "http://car.test"}, "map", tmp_path, offline=False)
    mixed = MixedTravel(base, provider)
    a, b = graph.nodes[0].location, graph.nodes[1].location
    for profile in ("walk", "bike", "transit"):
        assert mixed.quote(a, b, profile) == base.quote(a, b, profile)
    assert calls == []


def test_overlay_outage_falls_back_once_per_calculation(tmp_path, graph, monkeypatch, caplog):
    """An outage keeps planning usable without one network timeout per matrix cell."""
    from core.geo import GraphTravel, MixedTravel

    calls = []

    def get(url, **kwargs):
        calls.append(url)
        return httpx.Response(503, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", get)
    base = GraphTravel(graph)
    provider = OSRMTravel({"car": "http://car.test"}, "map", tmp_path, offline=False)
    mixed = MixedTravel(base, provider)
    a, b, c = (node.location for node in graph.nodes[:3])
    for target in (b, c, b):
        assert mixed.quote(a, target, "car") == base.quote(a, target, "car")
    assert len(calls) == 1
    assert (
        len([record for record in caplog.records if "TRAVEL_OVERLAY_UNAVAILABLE" in record.message])
        == 1
    )
    assert not list(tmp_path.rglob("*.json"))


def test_overlay_respects_confirmed_no_route(tmp_path, graph, monkeypatch):
    """A provider's NoRoute is not an outage and must not become a straight line."""
    from core.geo import GraphTravel, MixedTravel

    monkeypatch.setattr(
        httpx,
        "get",
        lambda url, **kwargs: httpx.Response(
            200, request=httpx.Request("GET", url), json={"code": "NoRoute"}
        ),
    )
    provider = OSRMTravel({"car": "http://car.test"}, "map", tmp_path, offline=False)
    mixed = MixedTravel(GraphTravel(graph), provider)
    assert mixed.quote(graph.nodes[0].location, graph.nodes[1].location, "car") is None


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"code": "Ok", "routes": []},
        {"code": "InvalidQuery"},
        {"code": "Ok", "routes": [{"duration": 0, "distance": 600}]},
    ],
)
def test_invalid_overlay_response_cannot_poison_cache(tmp_path, graph, monkeypatch, payload):
    """Malformed success payloads degrade to local costs and are never persisted."""
    from core.geo import GraphTravel, MixedTravel

    monkeypatch.setattr(
        httpx,
        "get",
        lambda url, **kwargs: httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json=payload,
        ),
    )
    base = GraphTravel(graph)
    mixed = MixedTravel(base, OSRMTravel({"car": "http://car.test"}, "map", tmp_path, False))
    a, b = graph.nodes[0].location, graph.nodes[1].location
    assert mixed.quote(a, b, "car") == base.quote(a, b, "car")
    assert not list(tmp_path.rglob("*.json"))


def test_offline_miss_and_timeout_keep_profile_specific_fallback(tmp_path, graph, monkeypatch):
    """A cache miss stays offline; a timeout is retried only by a fresh provider."""
    from core.geo import GraphTravel, MixedTravel

    calls = []

    def get(url, **kwargs):
        calls.append(url)
        raise httpx.ReadTimeout("test provider unavailable")

    monkeypatch.setattr(httpx, "get", get)
    base = GraphTravel(graph)
    a, b, c = (node.location for node in graph.nodes[:3])
    for offline in (True, False, False):
        provider = OSRMTravel({"walk": "http://walk.test"}, "map", tmp_path, offline)
        mixed = MixedTravel(base, provider)
        for target in (b, c):
            assert mixed.quote(a, target, "walk") == base.quote(a, target, "walk")
        if offline:
            assert calls == []
    assert len(calls) == 2


def test_osrm_cache_and_geometry(tmp_path, graph, monkeypatch):
    origin, target = graph.nodes[0].location, graph.nodes[1].location
    calls = []

    def get(url, **kwargs):
        calls.append(url)
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={
                "code": "Ok",
                "routes": [
                    {
                        "duration": 90.2,
                        "distance": 600.1,
                        "geometry": {
                            "coordinates": [[origin.lon, origin.lat], [target.lon, target.lat]]
                        },
                    }
                ],
            },
        )

    monkeypatch.setattr(httpx, "get", get)
    provider = OSRMTravel({"car": "http://osrm.test"}, "map-1", tmp_path, offline=False)
    quote = provider.quote(origin, target, "car")
    assert (quote.duration_sec, quote.distance_m) == (91, 601)
    assert quote.points == (origin, target)
    assert quote.geometry_exact is True
    assert f"{origin.lon},{origin.lat};{target.lon},{target.lat}" in calls[0]
    offline = OSRMTravel({"car": "http://osrm.test"}, "map-1", tmp_path)
    assert offline.quote(origin, target, "car") == quote
    assert len(calls) == 1
    with pytest.raises(ValueError, match="CACHE_MISS"):
        offline.quote(target, origin, "car")
    with pytest.raises(ValueError, match="PROFILE_NOT_CONFIGURED"):
        offline.quote(origin, target, "transit")

    # An outage opens the network circuit, but must not discard a good cached route.
    from core.geo import GraphTravel, MixedTravel, TravelUnavailable

    monkeypatch.setattr(
        httpx, "get", lambda url, **kwargs: httpx.Response(503, request=httpx.Request("GET", url))
    )
    with pytest.raises(TravelUnavailable, match="OSRM_HTTP_ERROR"):
        provider.quote(target, origin, "car")
    assert provider.quote(origin, target, "car") == quote
    assert len(list(tmp_path.rglob("*.json"))) == 1
    cached = next(tmp_path.rglob("*.json"))
    cached.write_text("{broken cache", encoding="utf-8")
    local = GraphTravel(graph)
    assert MixedTravel(local, offline).quote(origin, target, "car") == local.quote(
        origin, target, "car"
    )


def test_osrm_uses_transport_specific_api_profile(tmp_path, graph, monkeypatch):
    """Each configured transport must keep its own OSRM API profile path."""
    origin, target = graph.nodes[0].location, graph.nodes[1].location
    calls = []

    def get(url, **kwargs):
        calls.append(url)
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={"code": "NoRoute"},
        )

    monkeypatch.setattr(httpx, "get", get)
    endpoints = {
        "car": "http://car.test",
        "walk": "http://walk.test",
        "bike": "http://bike.test",
        "transit": "http://transit.test",
    }
    provider = OSRMTravel(endpoints, "map-profiles", tmp_path, offline=False)

    for profile in endpoints:
        assert provider.quote(origin, target, profile) is None

    assert [url.split("/route/v1/")[1].split("/")[0] for url in calls] == [
        "driving",
        "walking",
        "cycling",
        "transit",
    ]


def test_osrm_noroute_distinguished_from_provider_failure(tmp_path, graph, monkeypatch):
    a, b = graph.nodes[0].location, graph.nodes[1].location
    monkeypatch.setattr(
        httpx,
        "get",
        lambda url, **kwargs: httpx.Response(
            200, request=httpx.Request("GET", url), json={"code": "NoRoute"}
        ),
    )
    provider = OSRMTravel({"car": "http://osrm.test"}, "map", tmp_path, offline=False)
    assert provider.quote(a, b, "car") is None
    monkeypatch.setattr(
        httpx, "get", lambda url, **kwargs: httpx.Response(503, request=httpx.Request("GET", url))
    )
    from core.geo import TravelUnavailable

    with pytest.raises(TravelUnavailable, match="OSRM_HTTP_ERROR"):
        provider.quote(b, a, "car")
