"""Weather codes and the car-traffic multiplier stay deterministic without the network."""

from core.engine import SearchSettings
from core.geo import GeoPoint, StraightTravel, TravelQuote
from core.planning_travel import planning_travel
from core.predict_calibration import WeatherMultiplierCalibration
from core.weather import WeatherTravel, classify_weather_code


def test_weather_codes_pick_the_documented_multiplier():
    assert classify_weather_code(0) == ("clear", "Ясно", 1.0)
    assert classify_weather_code(3)[0] == "cloud"
    assert classify_weather_code(61) == ("rain", "Дождь", 1.08)
    assert classify_weather_code(73) == ("snow", "Снег", 1.15)
    assert classify_weather_code(95) == ("storm", "Гроза", 1.18)
    assert classify_weather_code(66)[0] == "snow"


def test_rain_scales_car_duration_and_leaves_walking_alone():
    travel = WeatherTravel(StraightTravel(), multiplier=1.08)
    origin = GeoPoint(lat=55.75, lon=37.62)
    destination = GeoPoint(lat=55.76, lon=37.64)
    plain = StraightTravel().quote(origin, destination, "car")
    wet = travel.quote(origin, destination, "car")
    walk = travel.quote(origin, destination, "walk")
    assert isinstance(plain, TravelQuote)
    assert isinstance(wet, TravelQuote)
    assert isinstance(walk, TravelQuote)
    assert wet.duration_sec == max(1, int(__import__("math").ceil(plain.duration_sec * 1.08)))
    assert wet.traffic_factor == round(plain.traffic_factor * 1.08, 2)
    assert walk.duration_sec == StraightTravel().quote(origin, destination, "walk").duration_sec


def test_storm_penalizes_open_walking_and_still_scales_cars():
    travel = WeatherTravel(StraightTravel(), multiplier=1.18, kind="storm")
    origin = GeoPoint(lat=55.75, lon=37.62)
    destination = GeoPoint(lat=55.76, lon=37.64)
    plain_walk = StraightTravel().quote(origin, destination, "walk")
    plain_car = StraightTravel().quote(origin, destination, "car")
    storm_walk = travel.quote(origin, destination, "walk")
    storm_car = travel.quote(origin, destination, "car")
    assert isinstance(plain_walk, TravelQuote)
    assert isinstance(plain_car, TravelQuote)
    assert isinstance(storm_walk, TravelQuote)
    assert isinstance(storm_car, TravelQuote)
    assert storm_walk.duration_sec == max(1, int(__import__("math").ceil(plain_walk.duration_sec * 2.4)))
    assert storm_walk.provenance != "metro"
    assert storm_car.duration_sec == max(1, int(__import__("math").ceil(plain_car.duration_sec * 1.18)))


def test_learned_solver_weather_is_opt_in_and_region_bound(snapshot, graph, monkeypatch):
    import core.weather as weather

    monkeypatch.setattr(weather, "weather_kind", lambda: "rain")
    monkeypatch.setattr(weather, "weather_multiplier", lambda: 1.08)
    regional = snapshot.model_copy(update={
        "engineers": [snapshot.engineers[0].model_copy(update={"region": "east"})],
    })
    learned = WeatherMultiplierCalibration(
        region="east", transport_type="car", kind="rain", multiplier=1.7,
        source="learned", observations=30, days=4,
        baseline_travel_error=0.2, candidate_travel_error=0.1,
        baseline_brier=0.2, candidate_brier=0.1, validation_version="frozen-v1",
    )
    settings = SearchSettings(traffic_enabled=False, access_buffer_sec=0, metro_enabled=False)
    origin = regional.engineers[0].start_location
    destination = regional.requests[0].location

    default = planning_travel(graph, settings, regional)
    explicit_off = planning_travel(
        graph, settings, regional, learned_weather=(learned,), learned_weather_enabled=False
    )
    default_quote = default.quote(origin, destination, "car")
    off_quote = explicit_off.quote(origin, destination, "car")
    assert default_quote == off_quote

    opted_in = planning_travel(
        graph, settings, regional, learned_weather=(learned,), learned_weather_enabled=True
    )
    learned_quote = opted_in.quote(origin, destination, "car")
    assert learned_quote is not None and default_quote is not None
    assert learned_quote.weather_multiplier_used == 1.7
    assert learned_quote.duration_sec > default_quote.duration_sec

    ambiguous = regional.model_copy(update={
        "engineers": [
            regional.engineers[0],
            regional.engineers[0].model_copy(update={"engineer_id": "eng-2", "region": "west"}),
        ],
    })
    ambiguous_default = planning_travel(
        graph, settings, ambiguous, learned_weather=(learned,), learned_weather_enabled=True
    )
    assert ambiguous_default.quote(origin, destination, "car") == default_quote
