"""Regression tests for weather-aware travel and paired risk predictions."""

from __future__ import annotations

from math import ceil

import pytest
from core.geo import GeoPoint, GraphTravel, StraightTravel
from core.predict_calibration import (
    CalibrationRegime,
    PredictCalibration,
    WeatherMultiplierCalibration,
    factory_calibration,
)
from core.robustness import predict_situation
from core.weather import WeatherTravel


def _single_request(snapshot, *, window_end_offset: int, engineer_region: str = "north"):
    """Narrow the standard fixture to a single request with an explicit region/window."""
    start = snapshot.engineers[0].shift_start_at
    request = snapshot.requests[0].model_copy(
        update={
            "service_duration_sec": 1,
            "window_start_at": start,
            "window_end_at": start + window_end_offset,
        }
    )
    engineer = snapshot.engineers[0].model_copy(update={"region": engineer_region})
    return snapshot.model_copy(update={"engineers": [engineer], "requests": [request]})


def _fixed_weather_calibration(*, regime_multiplier: float = 1.5, learned=()):
    """Use one deterministic rain regime so weather adjustments are directly observable."""
    return PredictCalibration(
        service_cv=0.0,
        leg_cv_short=0.0,
        leg_cv_long=0.0,
        cancel_rate=0.0,
        regimes=[
            CalibrationRegime(name="rain", probability=1.0, travel_multiplier=regime_multiplier)
        ],
        weather_multipliers=list(learned),
    )


def _append_nonterminal_request(snapshot):
    """Add a roomy second stop so the first stop uses the ordinary window tolerance."""
    start = snapshot.engineers[0].shift_start_at
    trailing = snapshot.requests[0].model_copy(
        update={
            "request_id": "trailing-job",
            "arrival_order": snapshot.requests[0].arrival_order + 10,
            "service_duration_sec": 1,
            "window_start_at": start,
            "window_end_at": start + 7 * 3600,
        }
    )
    return snapshot.model_copy(update={"requests": [snapshot.requests[0], trailing]})


@pytest.mark.parametrize("kind,multiplier", [("rain", 1.08), ("storm", 1.18)])
def test_zero_noise_weather_replay_uses_the_scaled_quote_once(snapshot, graph, kind, multiplier):
    """Exact zero-noise replay must retain rain/storm duration already present in the quote."""
    start = snapshot.engineers[0].shift_start_at
    base = GraphTravel(graph).quote(
        snapshot.engineers[0].start_location, snapshot.requests[0].location, "car"
    )
    assert base is not None
    expected_travel = ceil(base.duration_sec * multiplier)
    replay = WeatherTravel(GraphTravel(graph), multiplier=multiplier, kind=kind)
    single = _single_request(snapshot, window_end_offset=expected_travel + 1)

    result = predict_situation(
        single,
        replay,
        {"eng-1": [single.requests[0].request_id]},
        simulations=20,
        dispersion_scale=0,
        cancel_rate=0,
    )

    assert single.requests[0].window_end_at == start + expected_travel + 1
    assert result["requests"][single.requests[0].request_id]["breach_prob"] == 0.0


def test_weather_travel_preserves_noncar_and_zero_distance_quotes():
    """Car-weather scaling leaves walking and same-point quotes structurally intact."""
    base = StraightTravel()
    weather = WeatherTravel(base, multiplier=1.18, kind="rain")
    origin = GeoPoint(lat=55.75, lon=37.62)
    destination = GeoPoint(lat=55.76, lon=37.64)

    plain_walk = base.quote(origin, destination, "walk")
    weather_walk = weather.quote(origin, destination, "walk")
    assert plain_walk is not None and weather_walk is not None
    assert weather_walk.duration_sec == plain_walk.duration_sec
    assert weather_walk.distance_m == plain_walk.distance_m
    assert weather_walk.points == plain_walk.points
    assert weather_walk.provenance == plain_walk.provenance
    assert weather_walk.traffic_factor == plain_walk.traffic_factor

    zero_quote = base.quote(origin, origin, "car")
    zero_weather_quote = weather.quote(origin, origin, "car")
    assert zero_quote is not None and zero_weather_quote is not None
    assert zero_weather_quote == zero_quote


def test_weather_metadata_is_removed_before_applying_simulated_weather(snapshot, graph):
    """The quote's observed factor is normalized before a sampled regime is applied."""
    travel = WeatherTravel(GraphTravel(graph), multiplier=1.08, kind="rain")
    # Canonical road duration is 60 seconds; the sampled 1.5 regime yields 90.
    # If the quote's 1.08 factor is multiplied twice, completion passes this boundary.
    single = _single_request(snapshot, window_end_offset=92)
    result = predict_situation(
        single,
        travel,
        {"eng-1": [single.requests[0].request_id]},
        simulations=10,
        cancel_rate=0,
        calibration=_fixed_weather_calibration(),
    )
    assert result["requests"][single.requests[0].request_id]["breach_prob"] == 0.0


def test_paired_scenario_seed_keeps_draws_stable_across_calibration_versions(snapshot, graph):
    """The shared seed pairs baseline/candidate simulations despite version changes."""
    routes = {"eng-1": [request.request_id for request in snapshot.requests]}
    base = factory_calibration()
    candidate = base.model_copy(update={"source": "learned"})
    kwargs = {"simulations": 100, "scenario_seed": "paired-weather-case"}

    baseline_result = predict_situation(
        snapshot, GraphTravel(graph), routes, calibration=base, **kwargs
    )
    candidate_result = predict_situation(
        snapshot, GraphTravel(graph), routes, calibration=candidate, **kwargs
    )

    assert baseline_result["calibration_version"] != candidate_result["calibration_version"]
    baseline_result.pop("calibration_version")
    candidate_result.pop("calibration_version")
    baseline_result["assumptions"].pop("source")
    candidate_result["assumptions"].pop("source")
    assert baseline_result == candidate_result


@pytest.mark.parametrize(
    "region,calibrated_transport,transport_type,expected_breach",
    [
        ("north", "car", "car", 0.0),
        ("south", "car", "car", 1.0),
        ("north", "car", "bike", 1.0),
    ],
)
def test_learned_weather_factor_requires_region_and_transport_match(
    snapshot, graph, region, calibrated_transport, transport_type, expected_breach
):
    """A learned weather coefficient applies only to its exact region/transport pair."""
    window_end_offset = 80 if transport_type == "car" else 225
    single = _append_nonterminal_request(
        _single_request(snapshot, window_end_offset=window_end_offset, engineer_region="north")
    )
    engineer = single.engineers[0].model_copy(update={"transport_type": transport_type})
    single = single.model_copy(update={"engineers": [engineer]})
    factor = WeatherMultiplierCalibration(
        region=region,
        transport_type=calibrated_transport,
        kind="rain",
        multiplier=1.2,
        source="learned",
        observations=50,
        days=10,
        baseline_travel_error=0.4,
        candidate_travel_error=0.3,
        baseline_brier=0.2,
        candidate_brier=0.1,
        validation_version="weather-validation-v1",
    )
    travel = WeatherTravel(GraphTravel(graph), multiplier=1.08, kind="rain")

    result = predict_situation(
        single,
        travel,
        {"eng-1": [request.request_id for request in single.requests]},
        simulations=10,
        cancel_rate=0,
        calibration=_fixed_weather_calibration(learned=[factor]),
    )

    assert result["requests"][single.requests[0].request_id]["breach_prob"] == expected_breach
