"""Explicit OSRM road-profile adapter with persistent, offline-capable quote cache."""

import json
import math
import os
from pathlib import Path

import httpx

from core.contracts import GeoPoint, Transport
from core.geo import MixedTravel, TravelQuote, TravelSource, TravelUnavailable, content_hash

_OSRM_API_PROFILE: dict[Transport, str] = {
    "car": "driving",
    "walk": "walking",
    "bike": "cycling",
    "transit": "transit",
}


class OSRMTravel:
    """Query a configured per-profile OSRM deployment; no public server default.

    Cache namespace includes the operator's map version and the profile endpoint map.
    Offline misses are failures, not evidence that a physical route is unreachable.
    Only OSRM NoRoute is stored as an unreachable path.
    """

    def __init__(
        self, endpoints: dict[Transport, str], map_version: str, cache: Path, offline: bool = True
    ):
        """Configure cache and explicit endpoints; deployment remains outside this module."""
        self.endpoints = dict(endpoints)
        self.version = content_hash(json.dumps([map_version, endpoints], sort_keys=True).encode())
        self.cache = cache / self.version
        self.offline = offline
        self._unavailable_profiles: dict[Transport, str] = {}

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Use one route response for geometry, duration and distance, cached atomically."""
        if profile not in self.endpoints:
            raise TravelUnavailable("OSRM_PROFILE_NOT_CONFIGURED")
        identity = [profile, origin.model_dump(), destination.model_dump()]
        path = self.cache / (content_hash(json.dumps(identity, sort_keys=True).encode()) + ".json")
        try:
            return self._cached_quote(path, origin, destination, profile)
        except TravelUnavailable:
            raise
        except (httpx.HTTPError, OSError, ValueError, KeyError, IndexError, TypeError) as exc:
            # Do not retry every matrix cell after a timeout or invalid provider response.
            # A new calculation constructs a fresh provider and may try again. Cached
            # quotes remain readable even after the network circuit has been opened.
            code = (
                "OSRM_HTTP_ERROR"
                if isinstance(exc, httpx.HTTPError)
                else "OSRM_CACHE_IO_ERROR"
                if isinstance(exc, OSError)
                else "OSRM_INVALID_RESPONSE"
            )
            self._unavailable_profiles[profile] = code
            raise TravelUnavailable(code) from exc

    def _cached_quote(
        self, path: Path, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Read valid cached routes first; only cache misses may contact the provider."""
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        elif self.offline:
            raise TravelUnavailable("OSRM_CACHE_MISS")
        elif profile in self._unavailable_profiles:
            raise TravelUnavailable(self._unavailable_profiles[profile])
        else:
            coordinates = f"{origin.lon},{origin.lat};{destination.lon},{destination.lat}"
            response = httpx.get(
                f"{self.endpoints[profile].rstrip('/')}/route/v1/"
                f"{_OSRM_API_PROFILE[profile]}/{coordinates}",
                params={"overview": "full", "geometries": "geojson"},
                timeout=10.0,
            )
            response.raise_for_status()
            data = response.json()
            self._decode(data)  # Never poison the offline cache with malformed responses.
            self.cache.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
        return self._decode(data)

    @staticmethod
    def _decode(data: dict) -> TravelQuote | None:
        if not isinstance(data, dict) or data.get("code") not in ("Ok", "NoRoute"):
            raise ValueError("invalid OSRM response code")
        if data.get("code") == "NoRoute":
            return None
        route = data["routes"][0]
        duration, distance = route["duration"], route["distance"]
        if (
            type(duration) not in (int, float)
            or type(distance) not in (int, float)
            or not math.isfinite(duration)
            or not math.isfinite(distance)
            or min(duration, distance) < 0
            or (distance > 0 and duration == 0)
        ):
            raise ValueError("invalid OSRM costs")
        points = tuple(GeoPoint(lat=lat, lon=lon) for lon, lat in route["geometry"]["coordinates"])
        if len(points) < 2:
            raise ValueError("missing OSRM geometry")
        return TravelQuote(
            math.ceil(duration),
            math.ceil(distance),
            points,
            "route_api",
            geometry_exact=True,
        )


def live_osrm_from_env() -> OSRMTravel | None:
    """Use separately prepared car/walk/bike endpoints; the legacy URL is car-only.

    OSRM's extracted Lua profile determines travel mode, not the URL path. Transit
    therefore stays on the explicit local approximation or a dedicated transit source.
    """
    endpoints: dict[Transport, str] = {}
    for profile in ("car", "walk", "bike"):
        endpoint = os.environ.get(f"ROUTER_OSRM_{profile.upper()}_URL", "").strip()
        if profile == "car" and not endpoint:
            endpoint = os.environ.get("ROUTER_OSRM_URL", "").strip()
        if endpoint:
            endpoints[profile] = endpoint
    if not endpoints:
        return None
    cache = Path(os.environ.get("ROUTER_OSRM_CACHE", ".osrm-cache"))
    offline = os.environ.get("ROUTER_OSRM_OFFLINE", "").strip().lower() in {"1", "true", "yes"}
    return OSRMTravel(
        endpoints,
        map_version=os.environ.get("ROUTER_OSRM_MAP_VERSION", "live"),
        cache=cache,
        offline=offline,
    )


def attach_live_roads(travel: TravelSource) -> TravelSource:
    """Keep the prepared graph; overlay live OSRM on centroid or unknown legs."""
    overlay = live_osrm_from_env()
    return MixedTravel(travel, overlay) if overlay is not None else travel
