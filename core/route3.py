"""route-engine3 adapters: prepared multi-profile costs and plan verification.

The service (services/route-engine3, docs/route3.md) serves /matrix3 with
car forecast bands and flat-speed pedestrian cells plus /route3 point routes
with real geometry and metro composites. This module turns those payloads
into solver TravelSources:

- ``PreparedRoute3Matrix`` — immutable per-profile cells from /matrix3, the
  same contract shape the prepared road matrix uses (car forecast bands,
  flat walk/bike durations), with a durable disk cache;
- ``VerifiedRoute3`` — a TravelSource wrapper that overrides exact pairs with
  /route3 verification quotes, leaving the fast baseline everywhere else;
- ``verify_plan_with_route3`` — walk a calculated plan's chosen legs, ask the
  engine for traffic-factored car times and pedestrian/metro composites, and
  report where the fast plan under- or over-estimates.

Missing matrix coverage raises :class:`TravelUnavailable` so a MixedTravel
overlay falls back to the base graph; an in-matrix unreachable cell quotes
None (honest NoRoute). Env: ``ROUTE3_URL`` (empty disables the adapters),
``ROUTE3_CACHE``, ``ROUTE3_OFFLINE``.
"""

from __future__ import annotations

import bisect
import ipaddress
import json
import logging
import math
import os
import socket
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx

from core.contracts import GeoPoint, RouterTaskSnapshot, RouterTechnicalSettings
from core.geo import (
    TravelQuote,
    TravelSegment,
    TravelSource,
    TravelUnavailable,
    content_hash,
    haversine_m,
    joined_segments,
)

_LOGGER = logging.getLogger(__name__)

ROUTE3_VERSION = "route3-prepared-v1"
ROUTE_DISK_CACHE_MAX_FILES = 4096
ROUTE_DISK_CACHE_MAX_BYTES = 256 * 1024 * 1024
ROUTE_DISK_PRUNE_INTERVAL_SEC = 60.0


def _cached_route(kind: str, identity: str) -> dict | None:
    from core.route_cache import current_route_cache

    cache = current_route_cache()
    return None if cache is None else cache.lookup(kind, identity)


def _remember_route(kind: str, identity: str, body: dict) -> None:
    from core.route_cache import current_route_cache

    cache = current_route_cache()
    if cache is not None and isinstance(body, dict):
        cache.store_body(kind, identity, body)
_PROVIDER_FAILURES = (httpx.HTTPError, OSError, ValueError, TypeError, KeyError, AttributeError)
_TRUSTED_HOST_SUFFIXES = (".local",)
_VERSION_KEYS = ("car", "foot", "metro", "model")


def _host_is_private(host: str) -> bool:
    """True when the host literal or its DNS resolution is private/loopback only."""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            resolved = socket.getaddrinfo(host, None)
        except (socket.gaierror, OSError):
            return False
        if not resolved:
            return False
        return all(
            ipaddress.ip_address(entry[4][0]).is_private
            or ipaddress.ip_address(entry[4][0]).is_loopback
            for entry in resolved
        )
    return address.is_private or address.is_loopback


def _validate_route3_base(base_url: str) -> str:
    """Reject route3 endpoints that are not explicit private-network services.

    The engine is a self-hosted unit: deployments point ROUTE3_URL at a compose
    alias or a loopback port, both resolving into private addresses. Public
    hosts require the explicit ROUTE3_ALLOW_PUBLIC escape hatch, keeping a
    leaked env from turning the router into an SSRF pivot.
    """
    parsed = urlparse(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("ROUTE3_URL must be an absolute http(s) URL with a host")
    host = parsed.hostname
    if os.environ.get("ROUTE3_ALLOW_PUBLIC", "").lower() in {"1", "true", "yes"}:
        return base_url
    if host == "localhost" or host.endswith(_TRUSTED_HOST_SUFFIXES) or host == "host.docker.internal":
        return base_url
    if not _host_is_private(host):
        raise ValueError(
            "ROUTE3_URL host is public or unresolvable; set ROUTE3_ALLOW_PUBLIC=1 "
            "to accept a public endpoint"
        )
    return base_url


def route3_from_env() -> "Route3Client | None":
    """Build the client from env; None when ROUTE3_URL is unset or rejected.

    A rejected endpoint disables the adapters instead of failing the router:
    the planning pipeline has its own fallbacks and must not die on config.
    """
    base = os.environ.get("ROUTE3_URL", "").strip()
    if not base:
        return None
    try:
        validated = _validate_route3_base(base.rstrip("/"))
    except ValueError as error:
        _LOGGER.warning("ROUTE3_URL_REJECTED code=%s; route3 adapters disabled", error)
        return None
    return Route3Client(
        validated,
        cache_dir=Path(os.environ.get("ROUTE3_CACHE", ".route3-cache")),
        offline=os.environ.get("ROUTE3_OFFLINE", "").lower() in {"1", "true", "yes"},
    )


class Route3Client:
    """Thin HTTP client for the route-engine3 service."""

    def __init__(self, base_url: str, *, cache_dir: Path, offline: bool = False):
        self.base_url = base_url
        self.cache = cache_dir
        self.offline = offline
        self._versions: dict | None = None
        self._disk_pruned_at = 0.0

    @staticmethod
    def _validate_versions(body: dict) -> dict:
        """Validate the route-engine3 version snapshot used for cache identity."""
        versions = body.get("versions") if isinstance(body, dict) else None
        if not isinstance(versions, dict):
            raise ValueError("ROUTE3_VERSIONS_MISSING")
        if set(versions) != set(_VERSION_KEYS):
            raise ValueError("ROUTE3_VERSIONS_INVALID")
        if any(value is not None and not isinstance(value, str) for key, value in versions.items() if key != "model"):
            raise ValueError("ROUTE3_VERSIONS_INVALID")
        if not isinstance(versions["model"], str) or not versions["model"]:
            raise ValueError("ROUTE3_VERSIONS_INVALID")
        return {key: versions[key] for key in _VERSION_KEYS}

    @property
    def versions(self) -> dict | None:
        """Current service version snapshot, fetched once per client lifecycle."""
        return None if self._versions is None else dict(self._versions)

    def _versions_path(self) -> Path:
        endpoint = content_hash(self.base_url.encode())
        return self.cache / f"versions3-{endpoint}.json"

    def ensure_versions(self) -> dict:
        """Load or fetch one version snapshot; never perform a per-pair request."""
        if self._versions is not None:
            return dict(self._versions)
        path = self._versions_path()
        if self.offline:
            try:
                body = json.loads(path.read_text(encoding="utf-8"))
                self._versions = self._validate_versions(body)
            except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
                raise TravelUnavailable("ROUTE3_VERSIONS_CACHE_MISS") from exc
            return dict(self._versions)
        response = httpx.get(f"{self.base_url}/versions3", timeout=10.0, trust_env=False)
        response.raise_for_status()
        body = response.json()
        self._versions = self._validate_versions(body)
        self.cache.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{uuid4().hex}.tmp")
        temporary.write_text(json.dumps({"versions": self._versions}, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
        return dict(self._versions)

    @property
    def version(self) -> str:
        """Cache namespace: endpoint and the service's immutable version snapshot."""
        return content_hash(json.dumps(["route3-v2", self.base_url, self._versions], sort_keys=True).encode())

    def _identity(self, kind: str, payload: list) -> str:
        """Hash endpoint, versions and request parameters into a cache identity."""
        return content_hash(json.dumps([kind, self.base_url, self._versions, *payload], separators=(",", ":"), sort_keys=True).encode())

    def _disk_body(self, kind: str, identity: str) -> dict | None:
        path = self.cache / self.version / f"{kind}-{identity}.json"
        if not path.exists():
            return None
        body = json.loads(path.read_text(encoding="utf-8"))
        self._validate_response(body)
        return body

    def _write_disk_body(self, kind: str, identity: str, body: dict) -> None:
        path = self.cache / self.version / f"{kind}-{identity}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{uuid4().hex}.tmp")
        temporary.write_text(json.dumps(body, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
        if kind == "route":
            self._prune_disk_cache()

    def _prune_disk_cache(self) -> None:
        """Bound exact-departure route files while retaining the newest entries."""
        now = time.monotonic()
        if now - self._disk_pruned_at < ROUTE_DISK_PRUNE_INTERVAL_SEC:
            return
        self._disk_pruned_at = now
        try:
            entries = [
                path
                for path in self.cache.rglob("route-*.json")
                if path.is_file()
            ]
            total = sum(path.stat().st_size for path in entries)
            if len(entries) <= ROUTE_DISK_CACHE_MAX_FILES and total <= ROUTE_DISK_CACHE_MAX_BYTES:
                return
            entries.sort(key=lambda path: path.stat().st_mtime)
            while entries and (len(entries) > ROUTE_DISK_CACHE_MAX_FILES or total > ROUTE_DISK_CACHE_MAX_BYTES):
                path = entries.pop(0)
                size = path.stat().st_size
                path.unlink()
                total -= size
        except OSError:
            return

    def _validate_response(self, body: dict) -> dict:
        """Reject responses from a different graph/model than this lifecycle."""
        versions = self._validate_versions(body)
        if self._versions is None:
            self._versions = versions
        elif versions != self._versions:
            raise TravelUnavailable("ROUTE3_VERSION_CHANGED")
        return body

    def route(
        self,
        origin: GeoPoint,
        destination: GeoPoint,
        profile: str,
        *,
        traffic: bool = False,
        metro: bool = False,
        departure: int,
    ) -> dict:
        """One /route3 call; returns the parsed response body."""
        self.ensure_versions()
        identity = self._identity("route", [origin.lat, origin.lon, destination.lat, destination.lon, profile, traffic, metro, departure])
        cached = _cached_route("route", identity)
        if cached is not None:
            return self._validate_response(cached)
        cached = self._disk_body("route", identity)
        if cached is not None:
            return cached
        if self.offline:
            raise TravelUnavailable("ROUTE3_CACHE_MISS")
        response = httpx.get(
            f"{self.base_url}/route3",
            params={
                "a": f"{origin.lat},{origin.lon}",
                "b": f"{destination.lat},{destination.lon}",
                "profile": profile,
                "traffic": "1" if traffic else "0",
                "metro": "1" if metro else "0",
                "departure": departure,
            },
            timeout=30.0,
            trust_env=False,
        )
        response.raise_for_status()
        body = self._validate_response(response.json())
        _remember_route("route", identity, body)
        self._write_disk_body("route", identity, body)
        return body

    def matrix(
        self,
        points: list[GeoPoint],
        profile: str,
        *,
        traffic: bool = False,
        planning: bool = False,
        departure: int,
    ) -> dict:
        """One /matrix3 call for a whole point set."""
        self.ensure_versions()
        identity = self._identity("matrix", [profile, traffic, planning, departure, [(p.lat, p.lon) for p in points]])
        cached = _cached_route("matrix", identity)
        if cached is not None:
            return self._validate_response(cached)
        if self.offline:
            raise TravelUnavailable("ROUTE3_CACHE_MISS")
        response = httpx.get(
            f"{self.base_url}/matrix3",
            params={
                "points": ";".join(f"{p.lat},{p.lon}" for p in points),
                "profile": profile,
                "traffic": "1" if traffic else "0",
                "planning": "1" if planning else "0",
                "departure": departure,
            },
            timeout=120.0,
            trust_env=False,
        )
        response.raise_for_status()
        body = self._validate_response(response.json())
        _remember_route("matrix", identity, body)
        return body


def quote_from_route3(body: dict, origin: GeoPoint, destination: GeoPoint) -> TravelQuote | None:
    """Convert a /route3 body into a solver quote; None stays None (NoRoute)."""
    mode = body.get("mode")
    distance = body.get("distance_m")
    if mode == "unreachable" or distance is None:
        return None
    if mode == "straight":
        provenance = "approximate"
    elif mode == "metro_composite":
        provenance = "metro"
    elif body.get("traffic_applied"):
        provenance = "traffic_api"
    else:
        provenance = "route_api"
    geometry = body.get("geometry") or []
    points = tuple(GeoPoint(lat=point[0], lon=point[1]) for point in geometry if len(point) >= 2)
    segments = []
    for segment in body.get("segments") or []:
        segment_points = tuple(
            GeoPoint(lat=point[0], lon=point[1])
            for point in segment.get("geometry") or []
            if len(point) >= 2
        )
        segments.append(
            TravelSegment(
                points=segment_points,
                provenance="metro" if segment.get("kind") == "metro" else "route_api",
                duration_sec=int(segment.get("duration_s") or 0),
                distance_m=int(segment.get("distance_m") or 0),
            )
        )
    duration_sec = math.ceil(float(body["duration_s"]))
    distance_m = math.ceil(float(distance))
    # Ceil of the aggregate can exceed the sum of truncated segment parts.
    # The leg contract requires those sums to match, so the residual stays on
    # the last segment instead of failing the whole verified plan.
    if segments:
        duration_gap = duration_sec - sum(segment.duration_sec for segment in segments)
        distance_gap = distance_m - sum(segment.distance_m for segment in segments)
        if duration_gap or distance_gap:
            last = segments[-1]
            segments[-1] = TravelSegment(
                points=last.points,
                provenance=last.provenance,
                duration_sec=last.duration_sec + duration_gap,
                distance_m=last.distance_m + distance_gap,
            )
    joined = joined_segments(segments, origin, destination) if segments else ()
    if joined:
        # The body's own geometry is only the access walk; the leg line is all parts.
        points = tuple(point for index, segment in enumerate(joined) for point in (segment.points if index == 0 else segment.points[1:]))
    return TravelQuote(
        duration_sec,
        distance_m,
        points or (origin, destination),
        provenance,
        float(body.get("effective_factor") or 1.0),
        geometry_exact=mode in ("road", "metro_composite"),
        segments=joined,
        traffic_prepriced=bool(body.get("traffic_applied")),
    )


def verify_plan_with_route3(
    client: Route3Client,
    snapshot: RouterTaskSnapshot,
    plan,
    *,
    metro: bool = True,
    traffic: bool = True,
    known: dict | None = None,
    technical: RouterTechnicalSettings | None = None,
) -> dict:
    """Verify every chosen leg of a plan against /route3.

    Returns a report with corrected quotes keyed by
    ``(lat, lon, lat, lon, profile, departure)`` for the solver override, per-route
    duration drift and the jobs whose corrected schedule would break a window.
    Car legs ask for traffic; walk/transit legs ask for metro composites only
    when ``metro`` is on, so a disabled metro setting is not bypassed here.
    ``traffic`` follows the technical planning setting and prevents verification
    from introducing traffic costs when the planner explicitly disabled them.
    The diagnostic replays duration drift through waits and checks job completion.
    ``technical`` aligns corrected costs with access buffers and weather scaling;
    the re-solved plan validator remains the feasibility authority.
    ``known`` carries pairs verified in earlier rounds: they are reused, not
    re-requested, and ``new_legs`` counts only the pairs this call added.
    """
    profile_of_engineer = {
        engineer.engineer_id: engineer.travel_profile() for engineer in snapshot.engineers
    }
    requests = {request.request_id: request for request in snapshot.requests}
    corrections: dict[tuple[float, float, float, float, str, int], TravelQuote | None] = dict(known or {})
    already_known = len(corrections)
    routes_report = []
    for route in plan.routes:
        profile = profile_of_engineer.get(route.engineer_id, "car")
        straight_total = corrected_total = 0
        breach = None
        stops_by_id = {stop.stop_id: stop for stop in route.stops}
        deltas_by_stop: dict[str, int] = {}
        for leg in route.legs:
            # A leg can end at a wait before a job, not at the job stop itself.
            # Its recorded departure is authoritative for traffic and metro.
            stop = stops_by_id[leg.to_stop_id]
            previous = (route.start_location if leg.from_stop_id is None
                        else stops_by_id[leg.from_stop_id].location)
            departure = leg.departure_at
            leg_profile = ("walk" if profile == "car"
                           and haversine_m(previous, stop.location) <= 300 else profile)
            key = (previous.lat, previous.lon, stop.location.lat, stop.location.lon, leg_profile, departure)
            if key not in corrections:
                body = client.route(
                    previous,
                    stop.location,
                    leg_profile,
                    traffic=traffic and leg_profile == "car",
                    metro=metro and leg_profile == "transit",
                    departure=departure,
                )
                corrections[key] = quote_from_route3(body, previous, stop.location)
            quote = corrections[key]
            straight_total += leg.travel_time_sec
            if quote is not None:
                corrected_sec = quote.duration_sec
                if technical is not None and quote.distance_m:
                    factor = getattr(leg, "weather_multiplier_used", None) or 1.0
                    corrected_sec = math.ceil(corrected_sec * factor)
                    corrected_sec = (corrected_sec + technical.access_buffer_sec
                                     if technical.travel_time_mode == "graph_with_access_buffer"
                                     else technical.fixed_travel_time_sec)
                corrected_total += corrected_sec
                deltas_by_stop[stop.stop_id] = corrected_sec - leg.travel_time_sec
        # Replay every stop: an incoming leg may belong to the wait preceding a job.
        # Existing waiting absorbs delay before it can shift the job's completion.
        shift = 0
        for stop in route.stops:
            shift += deltas_by_stop.get(stop.stop_id, 0)
            if stop.kind == "wait":
                shift = max(0, shift - (stop.end_at - stop.start_at))
            elif stop.kind == "job":
                request = requests.get(stop.request_id)
                if request is not None and request.window_end_at is not None:
                    corrected_end = stop.end_at + max(0, shift)
                    if corrected_end > request.window_end_at:
                        breach = {
                            "request_id": stop.request_id,
                            "corrected_arrival_at": stop.arrival_at + max(0, shift),
                            "corrected_end_at": corrected_end,
                            "window_end_at": request.window_end_at,
                        }
        routes_report.append({
            "engineer_id": route.engineer_id,
            "profile": profile,
            "legs": len(route.legs),
            "straight_duration_sec": straight_total,
            "corrected_duration_sec": corrected_total,
            "window_breach": breach,
        })
    return {
        "verified_legs": len(corrections),
        "new_legs": len(corrections) - already_known,
        "corrections": corrections,
        "routes": routes_report,
    }


class Route3PedestrianTravel:
    """Foot-graph walk and bike costs from /matrix3 over any base provider.

    Pedestrian and cyclist search costs must come from the route3 foot graph,
    not from the regional car-oriented graph. Car quotes, and points outside
    the prepared matrix (metro station access, invented nodes), stay with the
    base provider. Transit never reaches this layer: the profile policy asks
    for walk, and metro is composed above it.
    """

    def __init__(self, base: TravelSource, prepared: PreparedRoute3Matrix):
        self.travel = base
        self.prepared = prepared
        self.version = content_hash(
            json.dumps({"base": base.version, "route3_foot": prepared.version}, sort_keys=True).encode()
        )
        self.provenance = getattr(base, "provenance", "route_api")

    @property
    def profiles(self):
        return getattr(self.travel, "profiles", None)

    def quote(self, origin, destination, profile):
        return self._quote(origin, destination, profile, None)

    def quote_at(self, origin, destination, profile, departure_at):
        return self._quote(origin, destination, profile, departure_at)

    def _quote(self, origin, destination, profile, departure_at):
        if profile in ("walk", "bike") and profile in self.prepared.profiles:
            try:
                quote = self.prepared.quote_at(origin, destination, profile, departure_at)
            except TravelUnavailable:
                quote = None
            # An unreachable foot cell (outside the MKAD cut) keeps the base
            # provider's disclosed estimate: an edge is never dropped from a route.
            if quote is not None:
                return quote
        if departure_at is None:
            return self.travel.quote(origin, destination, profile)
        timed = getattr(self.travel, "quote_at", None)
        if timed is None:
            return self.travel.quote(origin, destination, profile)
        return timed(origin, destination, profile, departure_at)


class VerifiedRoute3:
    """Baseline travel with exact-pair overrides from /route3 verification.

    Correction lookup is transit/walk-equivalent: the engine's static search
    and the timed scheduler may express the same pedestrian leg under either
    profile name, and a correction stored under one of them must be visible
    to both — otherwise solve-time and validation-time schedules diverge.
    """

    def __init__(self, base: TravelSource, corrections: dict):
        self.travel = base
        self.corrections = corrections
        self.version = content_hash(
            json.dumps(
                {
                    "base": base.version,
                    "verified": [
                        [*key, quote.duration_sec if quote is not None else None,
                         quote.distance_m if quote is not None else None]
                        for key, quote in sorted(corrections.items(), key=lambda item: repr(item[0]))
                    ],
                },
                sort_keys=True,
            ).encode()
        )
        self.provenance = getattr(base, "provenance", "route_api")

    @property
    def profiles(self):
        return getattr(self.travel, "profiles", None)

    @staticmethod
    def _keys(origin, destination, profile, departure_at=None):
        """Correction keys for the profile and its transit/walk equivalent."""
        base = (origin.lat, origin.lon, destination.lat, destination.lon)
        equivalent = "walk" if profile == "transit" else ("transit" if profile == "walk" else profile)
        for name in dict.fromkeys((profile, equivalent)):
            if departure_at is None:
                # Static callers may consume a legacy correction. Timed callers
                # always use the six-field, departure-specific identity below.
                yield (*base, name)
            else:
                yield (*base, name, departure_at)

    def _correction(self, origin, destination, profile, departure_at=None):
        """Return (found, quote); a metro composite is never a walk-only answer."""
        for key in self._keys(origin, destination, profile, departure_at):
            if key in self.corrections:
                quote = self.corrections[key]
                if profile != "transit" and quote is not None and quote.provenance == "metro":
                    continue
                return True, quote
        return False, None

    def quote(self, origin, destination, profile):
        found, quote = self._correction(origin, destination, profile)
        if found:
            return quote
        return self.travel.quote(origin, destination, profile)

    def quote_at(self, origin, destination, profile, departure_at):
        found, quote = self._correction(origin, destination, profile, departure_at)
        if found:
            return quote
        timed = getattr(self.travel, "quote_at", None)
        if timed is None:
            # Static sources (StraightTravel) only carry quote().
            return self.travel.quote(origin, destination, profile)
        return timed(origin, destination, profile, departure_at)


def _document(path: Path, fetch, offline: bool) -> dict:
    """Read a durable cached matrix first; atomically cache complete payloads."""
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    if offline:
        raise TravelUnavailable("ROUTE3_CACHE_MISS")
    data = fetch()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return data


class PreparedRoute3Matrix:
    """Immutable per-profile cells from /matrix3, car with forecast bands.

    Car cells follow the prepared road-matrix shape (base duration, distance,
    forecast band durations); walk/bike cells carry the service's flat-speed
    durations. Points outside the matrix raise TravelUnavailable (MixedTravel
    falls back to the base graph); unreachable cells quote None.
    """

    replaces_car_graph = True

    def __init__(
        self,
        client_version: str,
        per_profile: dict[str, dict],
        points: list[GeoPoint],
        *,
        fallback: TravelSource | None = None,
    ):
        """`fallback` answers points outside the matrix (metro station access
        legs, invented intermediate nodes) exactly like GraphTravel's own
        disclosed straight-line fallback; unreachable cells still quote None."""
        self.version = content_hash(
            json.dumps(
                {"v": ROUTE3_VERSION, "client": client_version, "profiles": sorted(per_profile)}
            ).encode()
        )
        self.fallback = fallback
        self.provenance = "road_matrix"
        self.profiles = frozenset(per_profile)
        self.index = {(p.lat, p.lon): i for i, p in enumerate(points)}
        self.zone = ZoneInfo("Europe/Moscow")
        self.cells: dict[tuple[str, int, int], tuple | None] = {}
        self.bands: dict[str, list[int]] = {}
        for profile, body in per_profile.items():
            if body.get("profile") != profile:
                raise ValueError("route3 matrix profile mismatch")
            if [(row[0], row[1]) for row in body.get("points", [])] != [(p.lat, p.lon) for p in points]:
                raise ValueError("route3 matrix point order changed")
            grid = body.get("matrix")
            if not isinstance(grid, list) or len(grid) != len(points):
                raise ValueError("invalid route3 matrix size")
            starts = body.get("forecast_band_starts")
            if starts is not None:
                if not starts or starts[0] != 0 or sorted(set(starts)) != starts:
                    raise ValueError("invalid route3 forecast bands")
                self.bands[profile] = starts
            for i, row in enumerate(grid):
                if not isinstance(row, list) or len(row) != len(points):
                    raise ValueError("invalid route3 matrix row")
                for j, cell in enumerate(row):
                    mode = cell.get("mode")
                    if mode == "self":
                        self.cells[profile, i, j] = (0, 0, None, "self")
                    elif mode == "unreachable":
                        self.cells[profile, i, j] = None
                    elif mode in ("road", "straight"):
                        distance = float(cell["distance_m"])
                        duration = float(cell["duration_s"])
                        base = float(cell.get("base_duration_s", duration))
                        if distance > 0 and duration <= 0:
                            raise ValueError("nonzero route with zero duration")
                        forecast = cell.get("forecast_duration_s")
                        if forecast is not None and (
                            profile not in self.bands or len(forecast) != len(self.bands[profile])
                        ):
                            raise ValueError("forecast row without matching band starts")
                        self.cells[profile, i, j] = (
                            base,
                            distance,
                            tuple(float(v) for v in forecast) if forecast is not None else None,
                            mode,
                        )
                    else:
                        raise ValueError(f"invalid route3 matrix mode: {mode}")

    def _fallback_quote(self, origin, destination, profile, departure_at):
        """Answer an out-of-matrix point from the fallback source when configured."""
        if self.fallback is None:
            return None
        if departure_at is None:
            return self.fallback.quote(origin, destination, profile)
        timed = getattr(self.fallback, "quote_at", None)
        if timed is None:
            return self.fallback.quote(origin, destination, profile)
        return timed(origin, destination, profile, departure_at)

    def quote(self, origin, destination, profile) -> TravelQuote | None:
        return self.quote_at(origin, destination, profile, 0)

    def quote_at(self, origin, destination, profile, departure_at: int | None) -> TravelQuote | None:
        """Matrix lookup; car selects the forecast band by Moscow-local time."""
        origin_index = self.index.get((origin.lat, origin.lon))
        destination_index = self.index.get((destination.lat, destination.lon))
        if origin_index is None or destination_index is None:
            if self.fallback is not None:
                return self._fallback_quote(origin, destination, profile, departure_at)
            raise TravelUnavailable("ROUTE3_MATRIX_POINT_MISSING")
        key = (profile, origin_index, destination_index)
        if key not in self.cells:
            if self.fallback is not None:
                return self._fallback_quote(origin, destination, profile, departure_at)
            raise TravelUnavailable("ROUTE3_MATRIX_PAIR_MISSING")
        cell = self.cells[key]
        if cell is None:
            return None
        base, distance, forecast, mode = cell
        duration = base
        factor = 1.0
        if forecast is not None and self.bands.get(profile):
            # A missing clock is the same instant quote() already uses: departure 0.
            local = datetime.fromtimestamp(0 if departure_at is None else departure_at, self.zone)
            index = bisect.bisect_right(self.bands[profile], local.hour * 60 + local.minute) - 1
            if forecast[index] is not None:
                duration = forecast[index]
                factor = round(duration / base, 2) if base else 1.0
        return TravelQuote(
            math.ceil(duration),
            math.ceil(distance),
            (origin, destination),
            ("approximate" if mode == "straight" else
             "traffic_api" if forecast is not None and self.bands.get(profile) else "road_matrix"),
            factor,
            traffic_prepriced=forecast is not None and bool(self.bands.get(profile)),
        )


def prepare_route3(
    client: Route3Client,
    points: list[GeoPoint],
    *,
    departure: int,
    traffic: bool = True,
    planning: bool = True,
    fallback: TravelSource | None = None,
    profiles: tuple[str, ...] = ("car", "walk", "bike"),
) -> PreparedRoute3Matrix | None:
    """Prepare multi-profile cells; None when the engine has no usable profile.

    Car asks for traffic-aware planning bands; walk and bike ask for flat
    distances. Each profile response is cached on disk separately, so a
    failed foot call does not invalidate a good car matrix. `fallback`
    answers points outside the matrix (see PreparedRoute3Matrix).
    """
    if not points:
        return None
    # Establish one immutable service snapshot before reading any matrix key.
    # This prevents a graph replacement behind the same URL from reusing old data.
    try:
        client.ensure_versions()
    except _PROVIDER_FAILURES + (TravelUnavailable,):
        return None
    per_profile: dict[str, dict] = {}
    requests = tuple(
        request
        for request in (
            ("car", traffic, planning),
            ("walk", False, False),
            ("bike", False, False),
        )
        if request[0] in profiles
    )
    for profile, traffic_on, planning_on in requests:
        key = content_hash(
            json.dumps([
                ROUTE3_VERSION,
                client.version,
                profile,
                traffic_on,
                planning_on,
                departure if traffic_on and not planning_on else None,
                [(p.lat, p.lon) for p in points],
            ]).encode()
        )
        path = client.cache / f"matrix3-{key}.json"

        def fetch(current=profile, traffic_flag=traffic_on, planning_flag=planning_on):
            return client.matrix(
                points, current, traffic=traffic_flag, planning=planning_flag, departure=departure
            )

        try:
            per_profile[profile] = client._validate_response(_document(path, fetch, client.offline))
        except _PROVIDER_FAILURES:
            _LOGGER.warning("ROUTE3_MATRIX_UNAVAILABLE profile=%s; keeping other sources", profile)
    if not per_profile:
        return None
    return PreparedRoute3Matrix(client.version, per_profile, points, fallback=fallback)
