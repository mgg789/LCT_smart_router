"""Redis-beta isolation, corruption, fallback and Runtime concurrency regressions."""

import json

import core.runtime as runtime_module
import pytest
from core.catalog_cache import RedisCatalogCache, configured_catalog_cache
from core.engine import SearchSettings
from core.geo import content_hash
from core.runtime import RouterRuntime, SnapshotPublication, calculate_policy_catalog
from core.tests.test_runtime import ControlledExecutor, Reader


class MemoryRedis:
    """Small expiring storage fake; real Redis and process restarts are measured separately."""

    def __init__(self):
        self.entries: dict[str, tuple[bytes, int]] = {}
        self.clock = 100
        self.fail = False

    def get(self, name: str) -> bytes | None:
        if self.fail:
            raise OSError("Do not log redis://:private-password@host")
        value = self.entries.get(name)
        return value[0] if value and value[1] > self.clock else None

    def set(self, name: str, value: bytes, *, ex: int) -> bool:
        if self.fail:
            raise OSError("Do not log private-password")
        self.entries[name] = (value, self.clock + ex)
        return True

    def close(self) -> None:
        pass


@pytest.fixture
def catalog(snapshot, graph):
    return calculate_policy_catalog(
        snapshot.model_dump_json().encode(),
        "publication-a",
        graph,
        SearchSettings(time_limit_ms=100),
        "context-a",
        100,
        offline=True,
    )


def cache_for(store, namespace="installation-a", ttl=600):
    return RedisCatalogCache(store, namespace, b"fixture-cache-secret-20260928", ttl)


def read(cache, comparison, **overrides):
    values = dict(
        publication_id=comparison.input_publication_id,
        input_hash=comparison.input_hash,
        context=comparison.router_context_version,
        budget_ms=comparison.search_budget_ms,
    )
    return cache.get(**(values | overrides))


def test_roundtrip_retains_exact_metrics_and_routes_then_expires(catalog):
    store = MemoryRedis()
    cache = cache_for(store, ttl=10)
    comparison, plans = catalog
    cache.put(comparison, plans)
    assert read(cache, comparison) == (comparison, plans)
    assert cache.stats["hits"] == cache.stats["writes"] == 1
    store.clock += 11
    assert read(cache, comparison) is None


def test_key_separates_publication_bytes_context_budget_namespace_and_graph_scope(catalog):
    store = MemoryRedis()
    cache = cache_for(store)
    comparison, plans = catalog
    cache.put(comparison, plans)
    for changed in (
        {"publication_id": "another"},
        {"input_hash": "0" * 64},
        {"context": "another"},
        {"budget_ms": 101},
        {"scope": "new-road-costs"},
    ):
        assert read(cache, comparison, **changed) is None
    assert read(cache_for(store, "another-installation"), comparison) is None


def test_corrupt_valid_json_cannot_silently_change_plan_metrics(catalog):
    store = MemoryRedis()
    cache = cache_for(store)
    comparison, plans = catalog
    cache.put(comparison, plans)
    key = next(iter(store.entries))
    value, expiry = store.entries[key]
    signature, payload = value.split(b"\n", 1)
    document = json.loads(payload)
    document["comparison"]["rows"][0]["summary"]["assigned_count"] = 999
    store.entries[key] = (signature + b"\n" + json.dumps(document).encode(), expiry)
    assert read(cache, comparison) is None
    assert cache.stats["invalid"] == 1


def test_authenticated_schema_or_row_mismatch_is_still_rejected(catalog):
    store = MemoryRedis()
    cache = cache_for(store)
    comparison, plans = catalog
    cache.put(comparison, plans)
    key = next(iter(store.entries))
    value, expiry = store.entries[key]
    original = json.loads(value.split(b"\n", 1)[1])
    for document in (
        {**original, "plans": {}},
        {**original, "schema_version": 99},
        {**original, "comparison": {**original["comparison"], "input_hash": "0" * 64}},
    ):
        payload = json.dumps(document).encode()
        store.entries[key] = (cache._signature(key, payload) + b"\n" + payload, expiry)
        assert read(cache, comparison) is None


def test_outage_is_a_cache_miss_and_does_not_leak_credentials(catalog, caplog):
    store = MemoryRedis()
    cache = cache_for(store)
    store.fail = True
    comparison, plans = catalog
    assert read(cache, comparison) is None
    cache.put(comparison, plans)
    assert cache.stats["errors"] == 2
    assert "private-password" not in caplog.text
    assert "UNAVAILABLE" in caplog.text


def test_disabled_feature_does_not_construct_a_client(monkeypatch):
    import redis

    monkeypatch.setenv("ROUTER_REDIS_BETA", "false")
    monkeypatch.setenv("ROUTER_REDIS_URL", "invalid")
    monkeypatch.setattr(
        redis.Redis, "from_url", lambda *args, **kwargs: pytest.fail("Redis called while off")
    )
    assert configured_catalog_cache() is None


def ready_runtime(reader, graph):
    executor = ControlledExecutor()
    runtime = RouterRuntime(reader, graph, SearchSettings(time_limit_ms=100), executor=executor)
    runtime.tick()
    executor.complete(0)
    runtime.tick()
    assert runtime.read_result().status == "ready"
    return runtime


def test_fresh_runtime_reuses_catalog_but_never_changes_working_plan(snapshot, graph, monkeypatch):
    store = MemoryRedis()
    monkeypatch.setattr(runtime_module, "configured_catalog_cache", lambda: cache_for(store))
    reader = Reader(snapshot.model_dump_json().encode())
    first = ready_runtime(reader, graph)
    expected = first.compare_policies()
    first.close()
    second = ready_runtime(reader, graph)
    before = second.read_result()
    monkeypatch.setattr(
        runtime_module,
        "calculate_policy_catalog",
        lambda *args, **kwargs: pytest.fail("Recomputed a warm Redis catalog"),
    )
    actual = second.compare_policies()
    mapped = second.simulate({"catalog": True})
    assert actual == expected
    assert second.catalog_cache_stats()["hits"] == 1
    assert second.read_result() == before
    metrics = {s["strategy_id"]: s["metrics"] for s in mapped["strategies"]}
    assert all(
        row.summary.distance_km == metrics[row.strategy_id]["distance_km"] for row in actual.rows
    )
    second.close()


def test_graph_content_change_invalidates_even_if_resource_label_was_not_bumped(
    snapshot, graph, monkeypatch
):
    store = MemoryRedis()
    monkeypatch.setattr(runtime_module, "configured_catalog_cache", lambda: cache_for(store))
    reader = Reader(snapshot.model_dump_json().encode())
    first = ready_runtime(reader, graph)
    first.compare_policies()
    old_context = first.context_version
    first.close()
    changed = graph.model_copy(deep=True)
    changed.edges[0].duration_sec["car"] += 123
    second = ready_runtime(reader, changed)
    assert second.context_version == old_context
    second.compare_policies()
    assert second.catalog_cache_stats()["hits"] == 0
    assert second.catalog_cache_stats()["writes"] == 1
    second.close()


def test_publication_change_during_redis_read_still_rejects_stale_result(
    snapshot, graph, monkeypatch
):
    store = MemoryRedis()
    monkeypatch.setattr(runtime_module, "configured_catalog_cache", lambda: cache_for(store))
    reader = Reader(snapshot.model_dump_json().encode())
    first = ready_runtime(reader, graph)
    first.compare_policies()
    first.close()
    second = ready_runtime(reader, graph)
    original_get = store.get

    def changed_while_reading(key):
        value = original_get(key)
        reader.raw += b"\n"
        return value

    monkeypatch.setattr(store, "get", changed_while_reading)
    with pytest.raises(ValueError, match="PUBLICATION_CHANGED"):
        second.compare_policies()
    second.close()


def test_runtime_computes_normally_when_redis_is_down(snapshot, graph, monkeypatch):
    store = MemoryRedis()
    store.fail = True
    monkeypatch.setattr(runtime_module, "configured_catalog_cache", lambda: cache_for(store))
    runtime = ready_runtime(Reader(snapshot.model_dump_json().encode()), graph)
    before = runtime.read_result()
    comparison = runtime.compare_policies()
    assert len(comparison.rows) == 7
    assert runtime.catalog_cache_stats()["errors"] == 2
    assert runtime.read_result() == before
    runtime.close()


def test_new_publication_with_identical_bytes_rejects_old_catalog_until_ready(
    snapshot, graph, monkeypatch
):
    store = MemoryRedis()
    monkeypatch.setattr(runtime_module, "configured_catalog_cache", lambda: cache_for(store))
    raw = snapshot.model_dump_json().encode()

    class PublicationReader:
        current = SnapshotPublication("first", 1, raw, content_hash(raw), 1)

        def read(self):
            return self.current

    reader = PublicationReader()
    runtime = ready_runtime(reader, graph)
    assert runtime.compare_policies().input_publication_id == "first"
    reader.current = SnapshotPublication("second", 2, raw, content_hash(raw), 2)
    runtime.tick()
    with pytest.raises(ValueError, match="PUBLICATION_CHANGED"):
        runtime.compare_policies()
    assert runtime.catalog_cache_stats()["writes"] == 1
    runtime.close()
