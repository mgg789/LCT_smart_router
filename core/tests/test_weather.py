"""Weather codes and the car-traffic multiplier stay deterministic without the network."""

from core.geo import GeoPoint, StraightTravel, TravelQuote
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
