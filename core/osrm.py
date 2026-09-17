"""Explicit OSRM road-profile adapter with persistent, offline-capable quote cache."""

import json
import math
import os
from pathlib import Path

import httpx

from core.contracts import GeoPoint, Transport
from core.geo import TravelQuote, content_hash

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

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Use one route response for geometry, duration and distance, cached atomically."""
        if profile not in self.endpoints:
            raise ValueError(f"OSRM profile is not configured: {profile}")
        identity = [profile, origin.model_dump(), destination.model_dump()]
        path = self.cache / (content_hash(json.dumps(identity, sort_keys=True).encode()) + ".json")
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        elif self.offline:
            raise ValueError("OSRM_CACHE_MISS: prepare this snapshot's road quotes online first")
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
            if data.get("code") not in ("Ok", "NoRoute"):
                raise ValueError("OSRM_PROVIDER_ERROR")
            self._decode(data)  # Never poison the offline cache with malformed responses.
            self.cache.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
        return self._decode(data)

    @staticmethod
    def _decode(data: dict) -> TravelQuote | None:
        if data.get("code") == "NoRoute":
            return None
        route = data["routes"][0]
        duration, distance = route["duration"], route["distance"]
        if (
            not math.isfinite(duration)
            or not math.isfinite(distance)
            or min(duration, distance) < 0
        ):
            raise ValueError("invalid OSRM costs")
        points = tuple(GeoPoint(lat=lat, lon=lon) for lon, lat in route["geometry"]["coordinates"])
        if not points:
            raise ValueError("missing OSRM geometry")
        return TravelQuote(
            math.ceil(duration),
            math.ceil(distance),
            points,
            "route_api",
            geometry_exact=True,
        )
