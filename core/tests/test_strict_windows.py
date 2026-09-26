"""Strict TZ windows disable ordinary and terminal allowances across both evaluators."""

from dataclasses import replace

import pytest
from core.contracts import RouterTechnicalSettings
from core.engine import SearchSettings, solve
from core.geo import GraphTravel, configure_travel
from core.route_search import RouteEvaluator
from core.schedule import schedule_steps
from core.settings import FileTechnicalSettingsStore


@pytest.mark.parametrize("traffic", [False, True])
@pytest.mark.parametrize("boundary", ["window", "shift", "horizon"])
def test_strict_switch_rejects_even_one_second_of_terminal_lateness(
    snapshot, graph, traffic, boundary
):
    start = snapshot.planning_as_of
    engineer = snapshot.engineers[0].model_copy(update={
        "shift_end_at": start + (599 if boundary == "shift" else 3600),
        "lunch": snapshot.engineers[0].lunch.model_copy(update={"enabled": False}),
    })
    request = snapshot.requests[0].model_copy(update={
        "location": engineer.start_location,
        "window_start_at": start,
        "window_end_at": start + (599 if boundary == "window" else 3600),
        "service_duration_sec": 600,
    })
    task = snapshot.model_copy(update={
        "engineers": [engineer], "requests": [request],
        "horizon_end_at": start + (599 if boundary == "horizon" else 3600),
    })
    relaxed = SearchSettings(traffic_enabled=traffic, solution_limit=4, access_buffer_sec=0)
    strict = replace(relaxed, strict_time_windows=True)
    relaxed_result = solve(task, GraphTravel(graph), relaxed)
    assert relaxed_result.main.summary.assigned_count == 1
    result = solve(task, GraphTravel(graph), strict)
    assert result.memory.context_version != relaxed_result.memory.context_version
    with_old_memory = solve(task, GraphTravel(graph), strict, memory=relaxed_result.memory)
    assert with_old_memory.main == result.main
    assert result.main.summary.assigned_count == 0
    assert result.baseline.summary.assigned_count == 0
    travel = configure_travel(GraphTravel(graph), strict.technical(), start)
    assert schedule_steps(task, engineer, [request.request_id], travel) is None
    assert RouteEvaluator(task, travel).evaluate(0, (request.request_id,)) is None
    # The switch does not erase the operator's configured allowances.
    assert strict.window_lateness_tolerance_sec == relaxed.window_lateness_tolerance_sec
    assert solve(task, GraphTravel(graph), replace(strict, strict_time_windows=False)).main.summary.assigned_count == 1


def test_strict_setting_is_durable_and_old_documents_keep_relaxed_mode(tmp_path):
    store = FileTechnicalSettingsStore(tmp_path / "settings.json")
    original = RouterTechnicalSettings(strict_time_windows=True, window_lateness_tolerance_sec=300)
    store.save(original)
    assert FileTechnicalSettingsStore(store.path).load() == original
    assert RouterTechnicalSettings.model_validate({}).strict_time_windows is False
