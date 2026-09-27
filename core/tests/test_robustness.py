"""Situation predictions must be deterministic and degenerate to the schedule."""

import pytest
from core.geo import GraphTravel
from core.robustness import _sample_weather_kind, predict_situation

ROUTES = {"eng-1": ["job-1", "job-2", "job-3"]}


def test_heavy_weather_sampling_is_seeded_and_does_not_depend_on_candidates():
    first = [_sample_weather_kind("heavy", "paired-seed", simulation) for simulation in range(40)]
    second = [_sample_weather_kind("heavy", "paired-seed", simulation) for simulation in range(40)]
    assert first == second
    assert set(first) == {"snow", "storm"}


def _predict(snapshot, graph, routes=None, **kwargs):
    return predict_situation(
        snapshot, GraphTravel(graph), routes or ROUTES, simulations=200, **kwargs
    )


def test_deterministic_for_identical_inputs(snapshot, graph):
    first = _predict(snapshot, graph)
    second = _predict(snapshot, graph)
    assert first == second


def test_zero_dispersion_degenerates_to_certainties(snapshot, graph):
    result = _predict(snapshot, graph, dispersion_scale=0, cancel_rate=0)
    assert result["plan"]["robustness"] in (0.0, 1.0)
    assert result["plan"]["expected_cancellations"] == 0
    for prediction in result["requests"].values():
        assert prediction["breach_prob"] in (0.0, 1.0, None)


def test_full_cancellation_never_breaches(snapshot, graph):
    result = _predict(snapshot, graph, cancel_rate=1.0)
    assert result["plan"]["robustness"] == 1.0
    assert result["plan"]["expected_late"] == 0


def test_dispersion_never_raises_robustness(snapshot, graph):
    calm = _predict(snapshot, graph, dispersion_scale=0.5)["plan"]["robustness"]
    wild = _predict(snapshot, graph, dispersion_scale=1.5)["plan"]["robustness"]
    assert wild <= calm


def test_breach_probability_bounded_and_situated(snapshot, graph):
    result = _predict(snapshot, graph)
    for prediction in result["requests"].values():
        if prediction["breach_prob"] is not None:
            assert 0.0 <= prediction["breach_prob"] <= 1.0
    assert 0.0 <= result["plan"]["robustness"] <= 1.0
    assert result["plan"]["p95_late_count"] >= result["plan"]["expected_late"] - 0.51


def test_completed_must_be_route_prefix(snapshot, graph):
    with pytest.raises(ValueError, match="COMPLETED_NOT_A_PREFIX"):
        _predict(snapshot, graph, completed={"eng-1": ["job-2"]})
    with pytest.raises(ValueError, match="UNKNOWN_MANUAL_ENGINEER"):
        _predict(snapshot, graph, routes={"unknown": ["job-1"]}, completed={})
