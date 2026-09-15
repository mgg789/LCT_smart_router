"""Concurrency generation and API contracts, including real process isolation."""

import time
from concurrent.futures import Future

import pytest
from core.api import create_app
from core.engine import SearchSettings
from core.geo import content_hash
from core.runtime import RouterRuntime, calculate
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


def test_context_change_rejects_inflight_result(snapshot, graph):
    executor = ControlledExecutor()
    runtime = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()),
        graph,
        SearchSettings(time_limit_ms=500, solution_limit=4),
        executor=executor,
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
