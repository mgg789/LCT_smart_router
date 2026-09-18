"""Departure-time traffic estimates and adapters; no routing decisions or network calls.

An authoritative provider quote_at takes precedence. Current traffic observations
are retained as observations, never relabelled as a future traffic forecast.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

from core.contracts import GeoPoint, Transport

if TYPE_CHECKING:
    from core.geo import TravelQuote, TravelSource

_FORECAST_TRAFFIC_VERSION = "moscow-radial-v1"
_MOSCOW_CENTER = GeoPoint(lat=55.7558, lon=37.6173)


def forecast_traffic_factor(departure_at: int, origin: GeoPoint, destination: GeoPoint) -> float:
    """Return a versioned Moscow radial factor for one planned departure."""
    from core.geo import haversine_m

    local = datetime.fromtimestamp(departure_at, ZoneInfo("Europe/Moscow"))
    minute = local.hour * 60 + local.minute
    origin_radius = haversine_m(origin, _MOSCOW_CENTER)
    destination_radius = haversine_m(destination, _MOSCOW_CENTER)
    radial_delta = destination_radius - origin_radius
    direction = "outbound" if radial_delta > 500 else "inbound" if radial_delta < -500 else "cross"

    if 7 * 60 <= minute < 10 * 60 + 30:
        factor = {"inbound": 1.45, "outbound": 1.15, "cross": 1.25}[direction]
    elif 16 * 60 <= minute < 20 * 60 + 30:
        factor = {"inbound": 1.20, "outbound": 1.50, "cross": 1.30}[direction]
    elif 10 * 60 + 30 <= minute < 16 * 60:
        factor = 1.18
    elif 6 * 60 <= minute < 7 * 60 or 20 * 60 + 30 <= minute < 22 * 60:
        factor = 1.10
    else:
        factor = 1.0

    average_radius = (origin_radius + destination_radius) / 2
    if average_radius < 5_000:
        factor += 0.10
    elif average_radius < 15_000:
        factor += 0.05
    return round(factor, 2)


def _forecast_period(planning_as_of: int) -> str:
    """Return the stable local-time band that selects all v1 temporal factors."""
    local = datetime.fromtimestamp(planning_as_of, ZoneInfo("Europe/Moscow"))
    minute = local.hour * 60 + local.minute
    if 7 * 60 <= minute < 10 * 60 + 30:
        return "morning_peak"
    if 16 * 60 <= minute < 20 * 60 + 30:
        return "evening_peak"
    if 10 * 60 + 30 <= minute < 16 * 60:
        return "daytime"
    if 6 * 60 <= minute < 7 * 60 or 20 * 60 + 30 <= minute < 22 * 60:
        return "shoulder"
    return "night"


class ForecastTrafficTravel:
    """Apply deterministic forecast traffic to car quotes from non-traffic sources."""

    def __init__(self, travel: TravelSource, planning_as_of: int):
        """Freeze the planning-time proxy and algorithm version into context identity."""
        from core.geo import content_hash

        self.travel = travel
        self.planning_as_of = planning_as_of
        self.period = _forecast_period(planning_as_of)
        self.version = content_hash(
            json.dumps(
                {
                    "base_version": travel.version,
                    "forecast_version": _FORECAST_TRAFFIC_VERSION,
                    "planning_time_proxy_period": self.period,
                    "timezone": "Europe/Moscow",
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Use the snapshot planning time as the pre-solve callback proxy."""
        return self._quote_at(origin, destination, profile, self.planning_as_of)

    def quote_at(
        self,
        origin: GeoPoint,
        destination: GeoPoint,
        profile: Transport,
        departure_at: int,
    ) -> TravelQuote | None:
        """Return one quote factored for the route leg's actual departure clock."""
        return self._quote_at(origin, destination, profile, departure_at)

    def _quote_at(
        self,
        origin: GeoPoint,
        destination: GeoPoint,
        profile: Transport,
        departure_at: int,
    ) -> TravelQuote | None:
        """Apply the deterministic forecast to one underlying provider quote."""
        from core.geo import TravelQuote, quote_at

        quote = quote_at(self.travel, origin, destination, profile, departure_at)
        if (
            quote is None
            or quote.distance_m == 0
            or profile != "car"
            or quote.provenance == "traffic_api"
        ):
            return quote
        factor = forecast_traffic_factor(departure_at, origin, destination)
        return TravelQuote(
            duration_sec=math.ceil(quote.duration_sec * factor),
            distance_m=quote.distance_m,
            points=quote.points,
            provenance=quote.provenance,
            traffic_factor=round(quote.traffic_factor * factor, 2),
            geometry_exact=quote.geometry_exact,
        )


def configure_forecast_traffic(travel: TravelSource, planning_as_of: int) -> ForecastTrafficTravel:
    """Wrap one provider once for the snapshot's deterministic planning-time proxy."""
    if isinstance(travel, ForecastTrafficTravel) and travel.planning_as_of == planning_as_of:
        return travel
    if isinstance(travel, ForecastTrafficTravel) and travel.period == _forecast_period(
        planning_as_of
    ):
        return travel
    if isinstance(travel, ForecastTrafficTravel):
        travel = travel.travel
    return ForecastTrafficTravel(travel, planning_as_of)
