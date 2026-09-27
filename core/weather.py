"""Moscow Open-Meteo reading used as a car-traffic multiplier.

The forecast is cached and never required. A failed or skipped fetch leaves the
multiplier at 1, so an offline demo still routes. Tests skip the network.
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Literal

from core.contracts import GeoPoint, Transport
from core.geo import TravelQuote, TravelSource

if TYPE_CHECKING:
    from core.predict_calibration import WeatherMultiplierCalibration

WeatherKind = Literal["clear", "cloud", "rain", "snow", "storm", "unknown"]

_MOSCOW_LAT = 55.7558
_MOSCOW_LON = 37.6173
# The single allowed forecast origin; never built from request data.
_OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
_TTL_SEC = 30 * 60
_FETCH_TIMEOUT_SEC = 2.0


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect: the forecast origin must not be walked off."""


# Rain lifts the car traffic factor a little. Snow and thunderstorms lift it more.
_RAIN_MULTIPLIER = 1.08
_SNOW_MULTIPLIER = 1.15
_STORM_MULTIPLIER = 1.18


@dataclass(frozen=True)
class WeatherSnapshot:
    """One cached Moscow reading. `traffic_multiplier` is 1 when weather is calm."""

    observed_at: int
    temperature_c: float | None
    weather_code: int | None
    kind: WeatherKind
    label: str
    traffic_multiplier: float


def classify_weather_code(code: int) -> tuple[WeatherKind, str, float]:
    """Map a WMO weather code to a badge, a Russian name, and a car multiplier."""
    if code == 0:
        return "clear", "Ясно", 1.0
    if code in (1, 2, 3):
        return "cloud", "Облачно", 1.0
    if code in (45, 48):
        return "cloud", "Туман", 1.0
    if code in (95, 96, 99):
        return "storm", "Гроза", _STORM_MULTIPLIER
    if code in (56, 57, 66, 67, 71, 73, 75, 77, 85, 86):
        label = "Ледяной дождь" if code in (56, 57, 66, 67) else "Снег"
        return "snow", label, _SNOW_MULTIPLIER
    if code in (51, 53, 55, 61, 63, 65, 80, 81, 82):
        return "rain", "Дождь", _RAIN_MULTIPLIER
    return "cloud", "Облачно", 1.0


def _unknown() -> WeatherSnapshot:
    return WeatherSnapshot(0, None, None, "unknown", "Нет прогноза", 1.0)


def _cache_path() -> str:
    return os.environ.get("ROUTER_WEATHER_CACHE", "/app/state/weather-cache.json")


def _read_disk() -> WeatherSnapshot | None:
    try:
        with open(_cache_path(), encoding="utf-8") as handle:
            payload = json.load(handle)
        return WeatherSnapshot(
            observed_at=int(payload["observed_at"]),
            temperature_c=payload.get("temperature_c"),
            weather_code=payload.get("weather_code"),
            kind=payload["kind"],
            label=str(payload["label"]),
            traffic_multiplier=float(payload["traffic_multiplier"]),
        )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _write_disk(snapshot: WeatherSnapshot) -> None:
    path = _cache_path()
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "observed_at": snapshot.observed_at,
                    "temperature_c": snapshot.temperature_c,
                    "weather_code": snapshot.weather_code,
                    "kind": snapshot.kind,
                    "label": snapshot.label,
                    "traffic_multiplier": snapshot.traffic_multiplier,
                },
                handle,
            )
    except OSError:
        return


def _fetch() -> WeatherSnapshot:
    # Constant origin and constant query: the only endpoint this contour talks to
    # is the public Open-Meteo forecast for Moscow. The allowlist below keeps the
    # request pinned to that origin even if the constants above are edited, and
    # redirects stay off so the origin cannot be walked off to another host.
    query = urllib.parse.urlencode(
        {
            "latitude": _MOSCOW_LAT,
            "longitude": _MOSCOW_LON,
            "current": "temperature_2m,weather_code",
            "timezone": "Europe/Moscow",
            "forecast_days": 1,
        }
    )
    url = f"{_OPEN_METEO_URL}?{query}"
    origin = urllib.parse.urlsplit(url)
    if origin.scheme != "https" or origin.hostname != "api.open-meteo.com":
        raise ValueError("WEATHER_ORIGIN_UNEXPECTED")
    request = urllib.request.Request(url, method="GET")
    opener = urllib.request.build_opener(_NoRedirects())
    with opener.open(request, timeout=_FETCH_TIMEOUT_SEC) as response:
        payload = json.loads(response.read().decode("utf-8"))
    current = payload["current"]
    code = int(current["weather_code"])
    kind, label, multiplier = classify_weather_code(code)
    temperature = current.get("temperature_2m")
    return WeatherSnapshot(
        observed_at=int(time.time()),
        temperature_c=float(temperature) if isinstance(temperature, (int, float)) else None,
        weather_code=code,
        kind=kind,
        label=label,
        traffic_multiplier=multiplier,
    )


_memory: tuple[float, WeatherSnapshot] | None = None


def current_weather() -> WeatherSnapshot:
    """Return the cached Moscow forecast, refreshing it at most twice an hour."""
    global _memory
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return _clear_for_tests()
    now = time.time()
    if _memory is not None and now - _memory[0] < _TTL_SEC:
        return _memory[1]
    disk = _read_disk()
    if disk is not None and disk.observed_at and now - disk.observed_at < _TTL_SEC:
        _memory = (now, disk)
        return disk
    try:
        fresh = _fetch()
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        fresh = disk if disk is not None else _unknown()
    else:
        _write_disk(fresh)
    _memory = (now, fresh)
    return fresh


def _clear_for_tests() -> WeatherSnapshot:
    """Tests stay on a calm multiplier so live Moscow weather cannot move goldens."""
    return WeatherSnapshot(0, None, 0, "clear", "Ясно", 1.0)


def _rescale_segments(segments, duration_sec: int):
    """Keep composite segment durations summing exactly to a scaled quote."""
    if not segments:
        return segments
    total = sum(segment.duration_sec for segment in segments)
    if total <= 0:
        return segments
    exact = [duration_sec * segment.duration_sec / total for segment in segments]
    durations = [math.floor(value) for value in exact]
    remainder = duration_sec - sum(durations)
    for index in sorted(range(len(exact)), key=lambda i: exact[i] - durations[i], reverse=True)[:remainder]:
        durations[index] += 1
    return tuple(replace(segment, duration_sec=durations[index]) for index, segment in enumerate(segments))


def weather_multiplier() -> float:
    """Car-traffic multiplier for the cached forecast. Calm weather and failures are 1."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return 1.0
    return current_weather().traffic_multiplier


def weather_kind() -> WeatherKind:
    """Cached Moscow kind. Tests stay clear so a live storm cannot move goldens."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return "clear"
    return current_weather().kind


# Open walking during a thunderstorm is a last resort: cars stay preferable,
# and a metro composite is left untouched so a walker who must go uses the subway.
_WALK_STORM_PENALTY = 2.4


class WeatherTravel:
    """Scale car duration and the traffic factor by the cached weather multiplier."""

    def __init__(
        self, travel: TravelSource, multiplier: float | None = None, kind: WeatherKind | None = None
    ):
        """Remember the forecast multiplier and kind. Tests may pass both instead of fetching."""
        self.travel = travel
        self.multiplier = weather_multiplier() if multiplier is None else multiplier
        self.kind = weather_kind() if kind is None else kind
        from core.geo import content_hash

        self.version = content_hash(
            json.dumps(
                {
                    "base_version": getattr(travel, "version", ""),
                    "weather_multiplier": self.multiplier,
                    "weather_kind": self.kind,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )

    def quote(self, origin: GeoPoint, destination: GeoPoint, profile: Transport) -> TravelQuote | None:
        """Scale one static car quote. Other profiles pass through."""
        return self._scale(self.travel.quote(origin, destination, profile), profile)

    def quote_at(self, origin: GeoPoint, destination: GeoPoint, profile: Transport, departure_at: int) -> TravelQuote | None:
        """Scale one departure-aware car quote. Other profiles pass through."""
        from core.geo import quote_at

        return self._scale(quote_at(self.travel, origin, destination, profile, departure_at), profile)

    def _scale(self, quote: TravelQuote | None, profile: Transport) -> TravelQuote | None:
        if quote is None or quote.distance_m == 0:
            return quote
        factor = 1.0
        if profile == "car" and self.multiplier != 1.0:
            factor = self.multiplier
        elif (
            self.kind == "storm"
            and profile in ("walk", "transit")
            and getattr(quote, "provenance", None) != "metro"
        ):
            factor = _WALK_STORM_PENALTY
        if factor == 1.0:
            return replace(quote, weather_multiplier_used=1.0)
        from core.geo import TravelQuote

        duration_sec = max(1, math.ceil(quote.duration_sec * factor))
        return TravelQuote(
            duration_sec=duration_sec,
            distance_m=quote.distance_m,
            points=quote.points,
            provenance=quote.provenance,
            traffic_factor=round(quote.traffic_factor * (self.multiplier if profile == "car" else 1.0), 2),
            geometry_exact=quote.geometry_exact,
            segments=_rescale_segments(quote.segments, duration_sec),
            weather_multiplier_used=factor,
        )


class LearnedWeatherTravel:
    """Opt-in, region-bound learned weather factor for planning quotes.

    This wrapper is created only when Router's explicit solver-learning switch is
    enabled and the snapshot has one unambiguous region. Prediction calibration
    remains the default path; the wrapper never infers a region from coordinates.
    """

    def __init__(
        self,
        travel: TravelSource,
        region: str,
        calibrations: tuple[WeatherMultiplierCalibration, ...],
    ) -> None:
        self.travel = travel
        self.region = region
        self.calibrations = tuple(calibrations)
        from core.geo import content_hash

        self.version = content_hash(json.dumps({
            "base_version": getattr(travel, "version", ""),
            "region": region,
            "calibrations": [item.model_dump(mode="json") for item in calibrations],
        }, sort_keys=True, separators=(",", ":")).encode("utf-8"))

    def quote(self, origin: GeoPoint, destination: GeoPoint, profile: Transport) -> TravelQuote | None:
        return self._apply(self.travel.quote(origin, destination, profile), profile)

    def quote_at(
        self,
        origin: GeoPoint,
        destination: GeoPoint,
        profile: Transport,
        departure_at: int,
    ) -> TravelQuote | None:
        from core.geo import quote_at

        return self._apply(quote_at(self.travel, origin, destination, profile, departure_at), profile)

    def _apply(self, quote: TravelQuote | None, profile: Transport) -> TravelQuote | None:
        if quote is None or quote.distance_m <= 0:
            return quote
        kind = weather_kind()
        candidate = next((row for row in self.calibrations
            if row.region == self.region and row.transport_type == profile and row.kind == kind
            and row.source == "learned"), None)
        if candidate is None or quote.weather_multiplier_used is None:
            return quote
        from core.geo import TravelQuote

        previous_factor = quote.weather_multiplier_used
        if previous_factor <= 0:
            return quote
        duration_sec = max(1, math.ceil((quote.duration_sec / previous_factor) * candidate.multiplier))
        return TravelQuote(
            duration_sec=duration_sec,
            distance_m=quote.distance_m,
            points=quote.points,
            provenance=quote.provenance,
            traffic_factor=max(1.0, round(quote.traffic_factor * candidate.multiplier / previous_factor, 2)),
            geometry_exact=quote.geometry_exact,
            segments=_rescale_segments(quote.segments, duration_sec),
            weather_multiplier_used=candidate.multiplier,
        )
