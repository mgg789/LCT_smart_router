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
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx

from core.contracts import GeoPoint, RouterTaskSnapshot
from core.geo import (
    TravelQuote,
    TravelSegment,
    TravelSource,
    TravelUnavailable,
    content_hash,
    stitch_segments,
)

_LOGGER = logging.getLogger(__name__)

ROUTE3_VERSION = "route3-prepared-v1"
_PROVIDER_FAILURES = (httpx.HTTPError, OSError, ValueError, TypeError, KeyError, AttributeError)
_TRUSTED_HOST_SUFFIXES = (".local",)


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

    @property
    def version(self) -> str:
        """Cache namespace: the endpoint is the deployment's identity."""
        return content_hash(json.dumps(["route3-v1", self.base_url]).encode())

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
        return response.json()

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
        return response.json()


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
    return TravelQuote(
        math.ceil(float(body["duration_s"])),
        math.ceil(float(distance)),
        points or (origin, destination),
        provenance,
        float(body.get("effective_factor") or 1.0),
        geometry_exact=mode in ("road", "metro_composite"),
        # The engine already stitches its composites; this keeps an older or
        # differently configured engine from failing result validation downstream.
        segments=stitch_segments(tuple(segments)),
    )


def verify_plan_with_route3(
    client: Route3Client,
    snapshot: RouterTaskSnapshot,
    plan,
) -> dict:
    """Verify every chosen leg of a plan against /route3.

    Returns a report with corrected quotes keyed by
    ``(lat, lon, lat, lon, profile)`` for the solver override, per-route
    duration drift and the jobs whose corrected schedule would break a window.
    Car legs ask for traffic; walk/transit legs ask for metro composites.
    The window check applies the route's total duration drift to every stop
    after the corrected leg — a deliberately conservative estimate.
    """
    profile_of_engineer = {
        engineer.engineer_id: engineer.travel_profile() for engineer in snapshot.engineers
    }
    requests = {request.request_id: request for request in snapshot.requests}
    corrections: dict[tuple[float, float, float, float, str], TravelQuote | None] = {}
    routes_report = []
    for route in plan.routes:
        profile = profile_of_engineer.get(route.engineer_id, "car")
        straight_total = corrected_total = 0
        breach = None
        stops = [
            stop
            for stop in route.stops
            if stop.kind in ("job", "lunch", "handoff", "delivery", "office_pickup")
        ]
        legs_by_stop = {leg.to_stop_id: leg for leg in route.legs}
        previous = route.start_location
        for stop in stops:
            leg = legs_by_stop.get(stop.stop_id)
            departure = leg.departure_at if leg is not None else snapshot.planning_as_of
            key = (previous.lat, previous.lon, stop.location.lat, stop.location.lon, profile)
            if key not in corrections:
                body = client.route(
                    previous,
                    stop.location,
                    profile,
                    traffic=profile == "car",
                    metro=profile in ("walk", "transit"),
                    departure=departure,
                )
                corrections[key] = quote_from_route3(body, previous, stop.location)
            quote = corrections[key]
            straight_total += leg.travel_time_sec if leg is not None else 0
            if quote is not None:
                corrected_total += quote.duration_sec
            if stop.kind == "job" and quote is not None:
                request = requests.get(stop.request_id)
                if request is not None and request.window_end_at is not None:
                    shift = corrected_total - straight_total
                    corrected_arrival = stop.arrival_at + max(0, shift)
                    if corrected_arrival > request.window_end_at:
                        breach = {
                            "request_id": stop.request_id,
                            "corrected_arrival_at": corrected_arrival,
                            "window_end_at": request.window_end_at,
                        }
            previous = stop.location
        routes_report.append({
            "engineer_id": route.engineer_id,
            "profile": profile,
            "legs": len(stops),
            "straight_duration_sec": straight_total,
            "corrected_duration_sec": corrected_total,
            "window_breach": breach,
        })
    return {
        "verified_legs": len(corrections),
        "corrections": corrections,
        "routes": routes_report,
    }


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
            json.dumps({"base": base.version, "verified": len(corrections)}, sort_keys=True).encode()
        )
        self.provenance = getattr(base, "provenance", "route_api")

    @property
    def profiles(self):
        return getattr(self.travel, "profiles", None)

    @staticmethod
    def _keys(origin, destination, profile):
        """Correction keys for the profile and its transit/walk equivalent."""
        base = (origin.lat, origin.lon, destination.lat, destination.lon)
        equivalent = "walk" if profile == "transit" else ("transit" if profile == "walk" else profile)
        for name in dict.fromkeys((profile, equivalent)):
            yield (*base, name)

    def quote(self, origin, destination, profile):
        for key in self._keys(origin, destination, profile):
            if key in self.corrections:
                return self.corrections[key]
        return self.travel.quote(origin, destination, profile)

    def quote_at(self, origin, destination, profile, departure_at):
        for key in self._keys(origin, destination, profile):
            if key in self.corrections:
                return self.corrections[key]
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
                        self.cells[profile, i, j] = (0, 0, None)
                    elif mode == "unreachable":
                        self.cells[profile, i, j] = None
                    elif mode == "road":
                        distance = float(cell["distance_m"])
                        duration = float(cell["duration_s"])
                        base = float(cell.get("base_duration_s", duration))
                        if distance > 0 and duration <= 0:
                            raise ValueError("nonzero road with zero duration")
                        forecast = cell.get("forecast_duration_s")
                        if forecast is not None and (
                            profile not in self.bands or len(forecast) != len(self.bands[profile])
                        ):
                            raise ValueError("forecast row without matching band starts")
                        self.cells[profile, i, j] = (
                            base,
                            distance,
                            tuple(float(v) for v in forecast) if forecast is not None else None,
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
        base, distance, forecast = cell
        duration = base
        factor = 1.0
        if forecast is not None and self.bands.get(profile):
            local = datetime.fromtimestamp(departure_at, self.zone)
            index = bisect.bisect_right(self.bands[profile], local.hour * 60 + local.minute) - 1
            if forecast[index] is not None:
                duration = forecast[index]
                factor = round(duration / base, 2) if base else 1.0
        return TravelQuote(
            math.ceil(duration),
            math.ceil(distance),
            (origin, destination),
            "road_matrix",
            factor,
        )


def prepare_route3(
    client: Route3Client,
    points: list[GeoPoint],
    *,
    departure: int,
    traffic: bool = True,
    planning: bool = True,
    fallback: TravelSource | None = None,
) -> PreparedRoute3Matrix | None:
    """Prepare multi-profile cells; None when the engine has no usable profile.

    Car asks for traffic-aware planning bands; walk and bike ask for flat
    distances. Each profile response is cached on disk separately, so a
    failed foot call does not invalidate a good car matrix. `fallback`
    answers points outside the matrix (see PreparedRoute3Matrix).
    """
    if not points:
        return None
    per_profile: dict[str, dict] = {}
    requests = (
        ("car", traffic, planning),
        ("walk", False, False),
        ("bike", False, False),
    )
    for profile, traffic_on, planning_on in requests:
        key = content_hash(
            json.dumps([
                ROUTE3_VERSION,
                client.version,
                profile,
                traffic_on,
                planning_on,
                [(p.lat, p.lon) for p in points],
            ]).encode()
        )
        path = client.cache / f"matrix3-{key}.json"

        def fetch(current=profile, traffic_flag=traffic_on, planning_flag=planning_on):
            return client.matrix(
                points, current, traffic=traffic_flag, planning=planning_flag, departure=departure
            )

        try:
            per_profile[profile] = _document(path, fetch, client.offline)
        except _PROVIDER_FAILURES:
            _LOGGER.warning("ROUTE3_MATRIX_UNAVAILABLE profile=%s; keeping other sources", profile)
    if not per_profile:
        return None
    return PreparedRoute3Matrix(client.version, per_profile, points, fallback=fallback)
