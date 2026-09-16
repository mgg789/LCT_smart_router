"""Network geocoder preparation, ambiguity and offline replay."""

import httpx
import pytest
from core.geocoding import NominatimGeocoder


def test_candidates_cached_without_silent_selection(tmp_path, monkeypatch):
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json=[
                {"display_name": "Test A", "lat": "55.75", "lon": "37.60"},
                {"display_name": "Test B", "lat": "55.76", "lon": "37.61"},
            ],
        )

    monkeypatch.setattr(httpx, "get", get)
    online = NominatimGeocoder(
        "http://geo.test", tmp_path, "RouterTest/1", dataset_version="one", offline=False
    )
    candidates = online.lookup(" test   address ")
    assert len(candidates) == 2
    assert calls[0][1]["params"]["format"] == "jsonv2"
    offline = NominatimGeocoder("http://geo.test", tmp_path, "RouterTest/1", dataset_version="one")
    assert offline.lookup("TEST ADDRESS") == candidates
    assert len(calls) == 1
    with pytest.raises(ValueError, match="CACHE_MISS"):
        offline.lookup("new address")
