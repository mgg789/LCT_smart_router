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


def test_latest_publication_is_the_only_result_exposed(snapshot, graph):
    """A publication that changes while solving cannot leave an older plan active."""
    first_raw = snapshot.model_dump_json().encode()
    second_raw = (
        snapshot.model_copy(update={"planning_as_of": snapshot.planning_as_of + 60})
        .model_dump_json()
        .encode()
    )

    class PublicationReader:
        def __init__(self):
            self.current = SnapshotPublication(
                "publication-1", 1, first_raw, content_hash(first_raw), snapshot.planning_as_of
            )

        def read(self):
            return self.current

    reader, executor = PublicationReader(), ControlledExecutor()
    runtime = RouterRuntime(
        reader, graph, SearchSettings(time_limit_ms=500, solution_limit=4), executor=executor
    )
    runtime.tick()
    reader.current = SnapshotPublication(
        "publication-2", 2, second_raw, content_hash(second_raw), snapshot.planning_as_of + 60
    )
    runtime.tick()
    executor.complete(0)
    runtime.tick()
    assert runtime.read_result().status == "pending"
    assert len(executor.tasks) == 2
    assert executor.tasks[1][2][-1] == "publication-2"
    executor.complete(1)
    runtime.tick()
    result = runtime.read_result()
    assert result.status == "ready"
    assert result.input_publication_id == "publication-2"
    assert result.input_hash == content_hash(second_raw)
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
        comparison = client.get("/v1/policy-comparison")
        assert comparison.status_code == 200, comparison.text
        assert comparison.json()["input_publication_id"] == result["input_publication_id"]
        assert [row["strategy_id"] for row in comparison.json()["rows"]] == [
            "fast",
            "compact",
            "sla",
            "balanced",
            "eco",
            "covering",
            "baseline",
        ]
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
        lunches_enabled=True,
        departure_lateness_tolerance_sec=90,
        task_start_lateness_tolerance_sec=45,
        travel_time_mode="fixed_normative",
        access_buffer_sec=720,
        fixed_travel_time_sec=1500,
        early_finish_replan_threshold_sec=840,
        task_overrun_tolerance_sec=540,
    )
    response = runtime.set_technical_settings("settings-1", requested, old)
    assert response["technical_settings"] == requested.model_dump()
    runtime.close()

    restarted = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()), graph, settings_store=store
    )
    assert restarted.settings.technical() == requested
    assert restarted.context_version == response["router_context_version"]
    assert restarted.set_technical_settings("settings-1", requested, old) == response
    with pytest.raises(ValueError, match="CONTEXT_CONFLICT"):
        restarted.set_technical_settings("another-operation", requested, old)
    restarted.close()


def test_lunches_are_disabled_by_default():
    """The system policy must require an explicit operator opt-in for lunches."""
    assert SearchSettings().lunches_enabled is False
    assert RouterTechnicalSettings().lunches_enabled is False
    assert RouterTechnicalSettings().window_lateness_tolerance_sec == 600


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
                "lunches_enabled": True,
                "departure_lateness_tolerance_sec": 120,
                "task_start_lateness_tolerance_sec": 60,
                "travel_time_mode": "fixed_normative",
                "access_buffer_sec": 600,
                "fixed_travel_time_sec": 1200,
                "early_finish_replan_threshold_sec": 900,
                "task_overrun_tolerance_sec": 600,
            },
        )
        assert response.status_code == 200
        assert response.json()["technical_settings"]["lunches_enabled"] is True
    restarted = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()), graph, settings_store=store
    )
    assert restarted.settings.lunches_enabled is True
    assert restarted.settings.departure_lateness_tolerance_sec == 120
    assert restarted.settings.task_start_lateness_tolerance_sec == 60
    assert restarted.settings.travel_time_mode == "fixed_normative"
    restarted.close()


def test_technical_settings_cannot_be_accepted_without_persistence(snapshot, graph):
    """A successful settings response always means the revision can survive restart."""
    runtime = RouterRuntime(Reader(snapshot.model_dump_json().encode()), graph)
    with pytest.raises(ValueError, match="SETTINGS_STORE_UNAVAILABLE"):
        runtime.set_technical_settings(
            "settings-no-store",
            RouterTechnicalSettings(lunches_enabled=True),
            runtime.context_version,
        )
    assert runtime.settings.lunches_enabled is False
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


def test_policy_comparison_uses_same_input_and_does_not_mutate_runtime(snapshot, graph):
    """Six cold comparisons are cached while active plan identity and memory stay intact."""
    start = snapshot.planning_as_of
    lunch = snapshot.engineers[0].lunch.model_copy(
        update={
            "enabled": True,
            "duration_sec": 600,
            "window_start_at": start + 1800,
            "window_end_at": start + 3600,
            "required": True,
        }
    )
    snapshot = snapshot.model_copy(
        update={"engineers": [snapshot.engineers[0].model_copy(update={"lunch": lunch})]}
    )
    raw = snapshot.model_dump_json().encode()
    reader = Reader(raw)
    executor = ControlledExecutor()
    runtime = RouterRuntime(
        reader,
        graph,
        SearchSettings(time_limit_ms=100, solution_limit=4),
        executor=executor,
    )
    runtime.tick()
    executor.complete(0)
    runtime.tick()
    before = runtime.read_result()
    memory = runtime._memory

    comparison = runtime.compare_policies(search_budget_ms=100)
    cached = runtime.compare_policies(search_budget_ms=100)
    after = runtime.read_result()

    assert [row.strategy_id for row in comparison.rows] == [
        "fast",
        "compact",
        "sla",
        "balanced",
        "eco",
        "covering",
        "baseline",
    ]
    assert comparison.input_publication_id == before.input_publication_id
    assert comparison.input_hash == before.input_hash
    assert comparison.router_context_version == before.router_context_version
    assert comparison.computed_at == cached.computed_at
    assert comparison.rows == cached.rows
    assert all(row.summary.lunch_time_sec == 0 for row in comparison.rows)
    assert after == before
    assert runtime._memory is memory
    runtime.close()


def test_policy_comparison_api_requires_ready_publication(snapshot, graph):
    runtime = RouterRuntime(
        Reader(snapshot.model_dump_json().encode()),
        graph,
        executor=ControlledExecutor(),
    )
    with TestClient(create_app(runtime)) as client:
        response = client.get("/v1/policy-comparison")
    assert response.status_code == 503
    assert response.json()["detail"] == "ACTIVE_PUBLICATION_UNAVAILABLE"


def test_covering_comparison_does_not_leak_extra_crews_into_other_policies(snapshot, graph):
    """Expanded capacity is reported explicitly and never improves the fixed-roster pool."""
    from core.runtime import calculate_policy_comparison

    job = snapshot.requests[0].model_copy(update={"required_skill": "emergency"})
    task = snapshot.model_copy(update={"requests": [job]})
    comparison = calculate_policy_comparison(
        task.model_dump_json().encode(),
        "covering-isolation",
        graph,
        SearchSettings(time_limit_ms=100),
        "fixture",
        100,
        offline=True,
    )
    rows = {row.strategy_id: row for row in comparison.rows}
    assert rows["covering"].summary.assigned_count == 1
    assert rows["covering"].additional_engineers == 1
    assert all(
        row.summary.assigned_count == 0 and row.additional_engineers == 0
        for name, row in rows.items()
        if name != "covering"
    )
