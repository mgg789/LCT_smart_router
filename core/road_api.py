"""Point-to-point car travel from the local MKAD road API.

The API owns OSRM geometry and its own traffic forecast. Metro, walking and
bicycles stay on their own providers. A missing endpoint leaves the prepared
graph unchanged.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import httpx

from core.contracts import GeoPoint, Transport
from core.geo import TravelQuote, TravelSource, TravelUnavailable, content_hash, quote_at

_BUCKET_SEC = 900


class RoadApiTravel:
    """Call ``/route2`` for one car leg. Traffic is already in the duration."""

    replaces_car_graph = True
    provenance = "traffic_api"

    def __init__(self, base_url: str, cache: Path, map_version: str = "moscow-mkad"):
        """Bind one road-api origin and a durable cache of its responses."""
        self.base_url = base_url.rstrip("/")
        self.version = content_hash(
            json.dumps(["road-api-v3", map_version, self.base_url], sort_keys=True).encode()
        )
        self.cache = cache / self.version
        self._unavailable: str | None = None

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Quote without a departure clock. The API then uses its own current time."""
        return self.quote_at(origin, destination, profile, None)

    def quote_at(
        self,
        origin: GeoPoint,
        destination: GeoPoint,
        profile: Transport,
        departure_at: int | None,
    ) -> TravelQuote | None:
        """Return one cached car quote. Non-car profiles are not this backend's job."""
        if profile != "car":
            raise TravelUnavailable("ROAD_API_PROFILE_NOT_CONFIGURED")
        if self._unavailable:
            raise TravelUnavailable(self._unavailable)
        identity = [
            round(origin.lat, 5),
            round(origin.lon, 5),
            round(destination.lat, 5),
            round(destination.lon, 5),
            None if departure_at is None else departure_at - (departure_at % _BUCKET_SEC),
        ]
        path = self.cache / (content_hash(json.dumps(identity).encode()) + ".json")
        try:
            if path.exists():
                return decode_road_api(json.loads(path.read_text(encoding="utf-8")))
            params = {
                "a": f"{origin.lat},{origin.lon}",
                "b": f"{destination.lat},{destination.lon}",
            }
            if departure_at is not None:
                params["departure"] = str(departure_at)
            # A missing local road API must not freeze the solve. On main this call
            # does not exist; one hung host used to cost 30s before the graph took over.
            response = httpx.get(f"{self.base_url}/route2", params=params, timeout=3.0)
            response.raise_for_status()
            data = response.json()
            quote = decode_road_api(data)
            self.cache.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
            return quote
        except TravelUnavailable:
            raise
        except (httpx.HTTPError, OSError, ValueError, KeyError, TypeError) as exc:
            self._unavailable = "ROAD_API_UNAVAILABLE"
            raise TravelUnavailable("ROAD_API_UNAVAILABLE") from exc


class SplitRoadOverlay:
    """Send cars to the MKAD API and every other profile to a second provider."""

    replaces_car_graph = True

    def __init__(self, car: RoadApiTravel, other: TravelSource):
        """Keep the two providers distinct so a car graph cannot answer a walk quote."""
        self.car = car
        self.other = other
        self.version = content_hash(
            json.dumps({"car": car.version, "other": other.version}, sort_keys=True).encode()
        )
        self.provenance = "traffic_api"

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Dispatch one profile without a departure clock."""
        return self.quote_at(origin, destination, profile, None)

    def quote_at(
        self,
        origin: GeoPoint,
        destination: GeoPoint,
        profile: Transport,
        departure_at: int | None,
    ) -> TravelQuote | None:
        """Cars use the road API; walk, bike and transit stay on the other provider."""
        provider = self.car if profile == "car" else self.other
        if departure_at is None:
            return provider.quote(origin, destination, profile)
        return quote_at(provider, origin, destination, profile, departure_at)


def decode_road_api(data: dict) -> TravelQuote:
    """Map one ``/route2`` payload into a travel quote. Traffic is not applied again."""
    mode = data.get("mode")
    if mode not in ("road", "straight"):
        raise ValueError("invalid road api mode")
    duration = data.get("duration_s")
    distance = data.get("distance_m")
    geometry = data.get("geometry")
    if (
        not isinstance(duration, (int, float))
        or isinstance(duration, bool)
        or not isinstance(distance, (int, float))
        or isinstance(distance, bool)
        or not math.isfinite(duration)
        or not math.isfinite(distance)
        or min(duration, distance) < 0
        or not isinstance(geometry, list)
    ):
        raise ValueError("invalid road api costs")
    points = tuple(
        GeoPoint(lat=float(pair[0]), lon=float(pair[1]))
        for pair in geometry
        if isinstance(pair, list) and len(pair) >= 2
    )
    if len(points) < 2:
        raise ValueError("missing road api geometry")
    factor = data.get("effective_factor", 1)
    traffic_factor = float(factor) if type(factor) in (int, float) and factor >= 1 else 1.0
    return TravelQuote(
        duration_sec=math.ceil(duration),
        distance_m=math.ceil(distance),
        points=points,
        provenance="traffic_api" if mode == "road" else "approximate",
        traffic_factor=round(traffic_factor, 2),
        geometry_exact=mode == "road",
        traffic_prepriced=True,
    )


def live_road_api_from_env() -> RoadApiTravel | None:
    """Read ``ROUTER_ROAD_API_URL``. Absent means the prepared graph stays in charge."""
    base_url = os.environ.get("ROUTER_ROAD_API_URL", "").strip()
    if not base_url:
        return None
    cache = Path(os.environ.get("ROUTER_ROAD_API_CACHE", ".road-api-cache"))
    version = os.environ.get("ROUTER_ROAD_API_MAP_VERSION", "moscow-mkad")
    return RoadApiTravel(base_url, cache, version)


def compose_live_overlay(osrm: TravelSource | None) -> TravelSource | None:
    """Prefer the MKAD road API for cars and keep OSRM only for the profiles it serves."""
    road = live_road_api_from_env()
    if road is not None and osrm is not None:
        return SplitRoadOverlay(road, osrm)
    return road or osrm
