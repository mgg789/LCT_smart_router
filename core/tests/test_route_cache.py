"""Route-response cache: hit, disable, clear, and the learned growth check."""

from pathlib import Path

from core.route_cache import RouteResponseCache, assess_growth, install_route_cache


class MemoryStore:
    def __init__(self):
        self.values: dict[str, bytes] = {}
        self.sets: dict[str, set[str]] = {}
        self.lists: dict[str, list[str]] = {}
        self.ints: dict[str, int] = {}
        self.used = 0

    def get(self, name):
        if name in self.ints:
            return str(self.ints[name]).encode()
        return self.values.get(name)

    def set(self, name, value, *, ex=None):
        self.values[name] = value
        self.used += len(value)

    def delete(self, *names):
        for name in names:
            self.values.pop(name, None)
            self.sets.pop(name, None)
            self.lists.pop(name, None)
            self.ints.pop(name, None)
        return len(names)

    def sadd(self, name, *values):
        self.sets.setdefault(name, set()).update(values)
        return len(values)

    def srem(self, name, *values):
        bucket = self.sets.setdefault(name, set())
        for value in values:
            bucket.discard(value)
        return len(values)

    def smembers(self, name):
        return set(self.sets.get(name, set()))

    def scard(self, name):
        return len(self.sets.get(name, set()))

    def incrby(self, name, amount):
        self.ints[name] = self.ints.get(name, 0) + amount
        return self.ints[name]

    def lpush(self, name, value):
        self.lists.setdefault(name, []).insert(0, value)
        return len(self.lists[name])

    def ltrim(self, name, start, end):
        self.lists[name] = self.lists.get(name, [])[start : end + 1]

    def lrange(self, name, start, end):
        return self.lists.get(name, [])[start : end + 1]

    def memory(self):
        return {"used_memory": self.used, "used_memory_rss": self.used, "maxmemory": 0}


def _cache(tmp_path: Path) -> tuple[RouteResponseCache, MemoryStore]:
    store = MemoryStore()
    cache = RouteResponseCache(store, "test-ns", b"s" * 16, 600, tmp_path / "route-cache-control.json")
    install_route_cache(cache)
    return cache, store


def test_cached_body_roundtrips_and_clear_forgets_it(tmp_path):
    cache, _store = _cache(tmp_path)
    cache.store_body("route", "abc", {"mode": "walk", "distance_m": 10})
    assert cache.lookup("route", "abc") == {"mode": "walk", "distance_m": 10}
    assert cache.lookup("route", "missing") is None
    assert cache.clear() == 1
    assert cache.lookup("route", "abc") is None
    assert cache.status()["keys"] == 0


def test_disabled_cache_neither_reads_nor_writes(tmp_path):
    cache, store = _cache(tmp_path)
    cache.store_body("route", "abc", {"mode": "walk"})
    cache.set_enabled(False)
    assert cache.lookup("route", "abc") is None
    cache.store_body("route", "def", {"mode": "car"})
    assert "def" not in "".join(store.sets.get(cache._prefix("index"), set()))
    cache.set_enabled(True)
    assert cache.lookup("route", "abc")["mode"] == "walk"


def test_growth_stays_quiet_while_new_keys_explain_the_bytes():
    samples = [
        {"t": 0, "used": 0, "keys": 0},
        {"t": 20, "used": 40_000, "keys": 4},
        {"t": 40, "used": 80_000, "keys": 8},
        {"t": 60, "used": 120_000, "keys": 12},
    ]
    report = assess_growth(samples, [10_000, 10_000, 10_000, 10_000])
    assert report["leak"] is None
    assert report["normal_bytes_per_sec"] > 0


def test_growth_flags_memory_that_climbs_without_new_keys():
    samples = [
        {"t": 0, "used": 1_000_000, "keys": 10},
        {"t": 20, "used": 3_000_000, "keys": 10},
        {"t": 40, "used": 5_000_000, "keys": 10},
        {"t": 60, "used": 8_000_000, "keys": 10},
    ]
    report = assess_growth(samples, [1_000, 1_000, 1_000, 1_000])
    assert report["leak"]["code"] == "CACHE_MEMORY_LEAK"
    assert report["observed_bytes_per_sec"] > report["normal_bytes_per_sec"]


def test_route_client_serves_the_second_call_from_the_cache(tmp_path, monkeypatch):
    from core.contracts import GeoPoint
    from core.route3 import Route3Client

    cache, _store = _cache(tmp_path)
    calls = []

    def fake_get(url, params, timeout, trust_env):
        calls.append(params)
        class Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {"mode": "walk", "distance_m": 12, "geometry": [[1, 2], [3, 4]]}

        return Response()

    monkeypatch.setattr("core.route3.httpx.get", fake_get)
    client = Route3Client("http://route3.test", cache_dir=tmp_path)
    origin, destination = GeoPoint(lat=1, lon=2), GeoPoint(lat=3, lon=4)
    first = client.route(origin, destination, "walk", departure=0)
    second = client.route(origin, destination, "walk", departure=0)
    assert first == second and len(calls) == 1
    assert cache.hits == 1
    install_route_cache(None)
