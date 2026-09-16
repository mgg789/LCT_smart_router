"""Provider contract with real HTTP request formatting and durable offline reuse."""

import httpx
import pytest
from core.osrm import OSRMTravel


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
    assert f"{origin.lon},{origin.lat};{target.lon},{target.lat}" in calls[0]
    offline = OSRMTravel({"car": "http://osrm.test"}, "map-1", tmp_path)
    assert offline.quote(origin, target, "car") == quote
    assert len(calls) == 1
    with pytest.raises(ValueError, match="CACHE_MISS"):
        offline.quote(target, origin, "car")
    with pytest.raises(ValueError, match="not configured"):
        offline.quote(origin, target, "transit")


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
    with pytest.raises(httpx.HTTPStatusError):
        provider.quote(b, a, "car")
