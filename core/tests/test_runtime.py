"""Concurrency generation and API contracts, including real process isolation."""

import time
from concurrent.futures import Future

import pytest
from core.api import create_app
from core.contracts import Diagnostic, RouterResult, RouterTechnicalSettings
from core.engine import SearchSettings
from core.geo import content_hash
from core.runtime import RouterRuntime, SnapshotPublication, calculate
from core.settings import FileTechnicalSettingsStore
from fastapi.testclient import TestClient


class Reader:
    def __init__(self, raw):
        self.raw = raw

    def read(self):
        if self.raw is None:
            raise OSError("unreadable")
        return self.raw


class ControlledExecutor:
    def __init__(self):
        self.tasks = []

    def submit(self, fn, *args):
        future = Future()
        self.tasks.append((future, fn, args))
        return future

    def complete(self, position):
        future, fn, args = self.tasks[position]
        future.set_result(fn(*args))

    def shutdown(self, **kwargs):
        pass


def test_latest_wins_and_same_result_id(snapshot, graph):
    raw = snapshot.model_dump_json().encode()
    reader, executor = Reader(raw), ControlledExecutor()
    runtime = RouterRuntime(
        reader, graph, SearchSettings(time_limit_ms=500, solution_limit=4), executor=executor
    )
    runtime.tick()
    reader.raw = raw + b"\n"
    runtime.tick()
    reader.raw = raw + b"\n\n"
    runtime.tick()
    assert len(executor.tasks) == 1
    executor.complete(0)
    runtime.tick()
    assert runtime.read_result().status == "pending"
    assert len(executor.tasks) == 2
    assert executor.tasks[1][2][0] == reader.raw
    executor.complete(1)
    runtime.tick()
    first = runtime.read_result()
    assert first.input_hash == content_hash(reader.raw)
    runtime.tick()
    assert runtime.read_result().result_id == first.result_id
    runtime.close()


def test_context_change_rejects_inflight_result(tmp_path, snapshot, graph):
    executor = ControlledExecutor()
    runtime = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()),
        graph,
        SearchSettings(time_limit_ms=500, solution_limit=4),
        executor=executor,
        settings_store=FileTechnicalSettingsStore(tmp_path / "settings.json"),
    )
    runtime.tick()
    old = runtime.context_version
    response = runtime.set_tolerance("op-1", 30, old)
    assert response["router_context_version"] != old
    assert runtime.set_tolerance("op-1", 30, old) == response
    with pytest.raises(ValueError, match="OPERATION_CONFLICT"):
        runtime.set_tolerance("op-1", 31, old)
    executor.complete(0)
    runtime.tick()
    assert runtime.read_result().status == "pending"
    assert runtime.read_result().router_context_version != old
    runtime.close()


def test_invalid_snapshot_has_field_diagnostics(snapshot, graph):
    data = snapshot.model_dump()
    del data["requests"][0]["service_duration_sec"]
    import json

    result, output = calculate(json.dumps(data).encode(), graph, SearchSettings(), "context")
    assert result.status == "error" and output is None
    assert result.errors[0].field_path == "requests.0.service_duration_sec"


def test_reader_failure_cannot_publish_old_result(snapshot, graph):
    reader, executor = Reader(snapshot.model_dump_json().encode()), ControlledExecutor()
    runtime = RouterRuntime(
        reader, graph, SearchSettings(time_limit_ms=500, solution_limit=4), executor=executor
    )
    runtime.tick()
    reader.raw = None
    runtime.tick()
    executor.complete(0)
    runtime.tick()
    assert runtime.read_result().status == "error"
    runtime.close()


def test_reader_integrity_code_is_preserved_without_exposing_details(graph):
    """Known special-sector integrity errors remain machine-readable at the API boundary."""
    reader = Reader(None)
    reader.read = lambda: (_ for _ in ()).throw(ValueError("SNAPSHOT_HASH_MISMATCH: secret"))
    runtime = RouterRuntime(reader, graph, executor=ControlledExecutor())

    runtime.tick()

    diagnostic = runtime.read_result().errors[0]
    assert diagnostic.code == "SNAPSHOT_HASH_MISMATCH"
    assert "secret" not in diagnostic.message
    runtime.close()


def test_real_process_and_http_api(snapshot, graph):
    runtime = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()),
        graph,
        SearchSettings(time_limit_ms=600, solution_limit=6),
        poll_sec=0.02,
    )
    with TestClient(create_app(runtime)) as client:
        assert client.get("/health").status_code == 200
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            result = client.get("/v1/result").json()
            if result["status"] != "pending":
                break
            time.sleep(0.03)
        assert result["status"] == "ready", result
        assert result["main"]["summary"]["assigned_count"] == 3
        assert client.get("/v1/result").json()["result_id"] == result["result_id"]
        conflict = client.put(
            "/v1/config/tolerance",
            json={"operation_id": "x", "tolerance_sec": 2, "expected_context_version": "stale"},
        )
        assert conflict.status_code == 409
        assert client.post("/plans/build", json={}).status_code == 404


def test_technical_settings_persist_and_reload(tmp_path, snapshot, graph):
    """All Router-owned controls survive restart as one atomic revision."""
    store = FileTechnicalSettingsStore(tmp_path / "router-settings.json")
    runtime = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()), graph, settings_store=store
    )
    old = runtime.context_version
    requested = RouterTechnicalSettings(
        lunches_enabled=False,
        departure_lateness_tolerance_sec=90,
        task_start_lateness_tolerance_sec=45,
    )
    response = runtime.set_technical_settings("settings-1", requested, old)
    assert response["technical_settings"] == requested.model_dump()
    runtime.close()

    restarted = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()), graph, settings_store=store
    )
    assert restarted.settings.technical() == requested
    assert restarted.context_version == response["router_context_version"]
    restarted.close()


def test_v2_settings_api_updates_complete_revision(tmp_path, snapshot, graph):
    store = FileTechnicalSettingsStore(tmp_path / "settings.json")
    runtime = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()), graph, settings_store=store
    )
    with TestClient(create_app(runtime)) as client:
        context = client.get("/v1/context").json()["router_context_version"]
        response = client.put(
            "/v2/config/technical-settings",
            json={
                "operation_id": "settings-api-1",
                "expected_context_version": context,
                "lunches_enabled": False,
                "departure_lateness_tolerance_sec": 120,
                "task_start_lateness_tolerance_sec": 60,
            },
        )
        assert response.status_code == 200
        assert response.json()["technical_settings"]["lunches_enabled"] is False
    restarted = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()), graph, settings_store=store
    )
    assert restarted.settings.lunches_enabled is False
    assert restarted.settings.departure_lateness_tolerance_sec == 120
    assert restarted.settings.task_start_lateness_tolerance_sec == 60
    restarted.close()


def test_technical_settings_cannot_be_accepted_without_persistence(snapshot, graph):
    """A successful settings response always means the revision can survive restart."""
    runtime = RouterRuntime(Reader(snapshot.model_dump_json().encode()), graph)
    with pytest.raises(ValueError, match="SETTINGS_STORE_UNAVAILABLE"):
        runtime.set_technical_settings(
            "settings-no-store",
            RouterTechnicalSettings(lunches_enabled=False),
            runtime.context_version,
        )
    assert runtime.settings.lunches_enabled is True
    runtime.close()


def test_publication_integrity_and_result_states(snapshot):
    raw = snapshot.model_dump_json().encode()
    with pytest.raises(ValueError, match="SNAPSHOT_HASH_MISMATCH"):
        SnapshotPublication("pub-1", 1, raw, "0" * 64, snapshot.planning_as_of)
    with pytest.raises(ValueError, match="ready result is incomplete"):
        RouterResult(status="ready")
    with pytest.raises(ValueError, match="error result"):
        RouterResult(status="error")
    error = RouterResult(status="error", errors=[Diagnostic(code="INPUT_INVALID", message="bad")])
    assert error.status == "error"
