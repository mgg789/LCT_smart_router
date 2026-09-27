"""Prepare immutable road costs before search; the inner loop never calls HTTP."""

from __future__ import annotations

import bisect
import json
import logging
import math
import os
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Sequence
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx

from core.contracts import GeoPoint, RouterTaskSnapshot, Transport
from core.geo import (
    GraphTravel,
    MixedTravel,
    RoadGraph,
    TravelQuote,
    TravelSource,
    TravelUnavailable,
    configure_travel,
    content_hash,
)
from core.osrm import OSRMTravel, live_osrm_from_env
from core.road_api import live_road_api_from_env

if TYPE_CHECKING:
    from core.engine import SearchSettings
    from core.predict_calibration import WeatherMultiplierCalibration

PLANNING_TRAVEL_VERSION = "prepared-road-costs-v1"
_LOGGER = logging.getLogger(__name__)
_PROVIDER_FAILURES = (httpx.HTTPError, OSError, ValueError, TypeError, KeyError, AttributeError)


def snapshot_points(snapshot: RouterTaskSnapshot) -> list[GeoPoint]:
    """Deduplicate exact job, start and confirmed handoff coordinates deterministically."""
    points = [row.location for row in snapshot.requests]
    points.extend(row.start_location for row in snapshot.engineers)
    points.extend(row.location for row in snapshot.pending_equipment_handoffs)
    return [GeoPoint(lat=lat, lon=lon) for lat, lon in sorted({(p.lat, p.lon) for p in points})]


def _cost(value: object) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
        raise ValueError("invalid matrix cost")
    return float(value)


def _document(path: Path, fetch, offline: bool) -> dict:
    """Read a durable matrix first; atomically cache only a fully validated response."""
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    if offline:
        raise TravelUnavailable("PLANNING_MATRIX_CACHE_MISS")
    data, validate = fetch()
    validate(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return data


class PreparedRoadMatrix:
    """In-memory car costs and daily forecast bands returned by one /matrix2 call."""

    replaces_car_graph = True
    provenance = "road_matrix"
    profiles = frozenset({"car"})

    def __init__(
        self, points: list[GeoPoint], data: dict, version: str, planning_at: int, traffic: bool
    ):
        """Validate the complete grid before exposing any costs to a solver."""
        self.index = {(p.lat, p.lon): i for i, p in enumerate(points)}
        self.version = version
        self.planning_at = planning_at
        self.traffic = traffic
        bands = data.get("forecast_band_starts")
        if (
            not isinstance(bands, list)
            or not bands
            or bands[0] != 0
            or any(type(v) is not int or not 0 <= v < 1440 for v in bands)
            or sorted(set(bands)) != bands
            or data.get("forecast_timezone") != "Europe/Moscow"
            or not isinstance(data.get("model_version"), str)
        ):
            raise ValueError("invalid forecast bands")
        self.bands = bands
        self.zone = ZoneInfo("Europe/Moscow")
        returned = data.get("points", [])
        if [(row.get("lat"), row.get("lon")) for row in returned] != [
            (p.lat, p.lon) for p in points
        ]:
            raise ValueError("matrix point order changed")
        rows = data.get("matrix")
        if not isinstance(rows, list) or len(rows) != len(points):
            raise ValueError("invalid matrix size")
        self.cells = {}
        for i, row in enumerate(rows):
            if not isinstance(row, list) or len(row) != len(points):
                raise ValueError("invalid matrix row")
            for j, cell in enumerate(row):
                mode = cell.get("mode")
                if mode == "unreachable":
                    self.cells[i, j] = None
                elif mode in ("straight", "out_of_scope"):
                    continue  # Let the prepared regional graph answer this pair.
                elif mode in ("road", "self"):
                    base = _cost(cell.get("base_duration_s", 0) if mode == "road" else 0)
                    distance = _cost(cell.get("distance_m"))
                    durations = cell.get("forecast_duration_s")
                    if not isinstance(durations, list) or len(durations) != len(bands):
                        raise ValueError("invalid forecast row")
                    times = tuple(_cost(value) for value in durations)
                    if distance > 0 and (base == 0 or min(times) == 0):
                        raise ValueError("nonzero road has zero duration")
                    self.cells[i, j] = (base, distance, times)
                else:
                    raise ValueError("invalid matrix mode")

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Use the snapshot clock for static search callbacks."""
        return self.quote_at(origin, destination, profile, self.planning_at)

    def quote_at(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport, departure_at: int
    ) -> TravelQuote | None:
        """Select the exact forecast regime with no network or file access."""
        if profile != "car":
            raise TravelUnavailable("ROAD_API_PROFILE_NOT_CONFIGURED")
        pair = (
            self.index.get((origin.lat, origin.lon)),
            self.index.get((destination.lat, destination.lon)),
        )
        if pair not in self.cells:
            raise TravelUnavailable("PLANNING_MATRIX_PAIR_MISSING")
        costs = self.cells[pair]
        if costs is None:
            return None
        base, distance, times = costs
        local = datetime.fromtimestamp(departure_at, self.zone)
        index = bisect.bisect_right(self.bands, local.hour * 60 + local.minute) - 1
        duration = times[index] if self.traffic else base
        return TravelQuote(
            math.ceil(duration),
            math.ceil(distance),
            (origin, destination),
            "traffic_api" if self.traffic else "road_matrix",
            round(duration / base, 2) if base else 1.0,
        )


def prepare_road_api(
    points: list[GeoPoint], planning_at: int, traffic: bool, offline: bool
) -> PreparedRoadMatrix | None:
    """Load one versioned car matrix including forecast bands, or keep the offline graph."""
    road = live_road_api_from_env()
    if road is None or not points:
        return None
    key = content_hash(
        json.dumps([PLANNING_TRAVEL_VERSION, [(p.lat, p.lon) for p in points]]).encode()
    )
    path = road.cache / f"matrix-{key}.json"

    def validate(data):
        return PreparedRoadMatrix(points, data, road.version, planning_at, traffic)

    def fetch():
        response = httpx.get(
            f"{road.base_url}/matrix2",
            params={
                "points": ";".join(f"{p.lat},{p.lon}" for p in points),
                "departure": planning_at,
                "planning": "1",
            },
            timeout=15.0,
            trust_env=False,
        )
        response.raise_for_status()
        return response.json(), validate

    try:
        return validate(_document(path, fetch, offline))
    except _PROVIDER_FAILURES:
        _LOGGER.warning("PLANNING_ROAD_MATRIX_UNAVAILABLE; using the prepared regional graph")
        return None


class PreparedOSRMMatrix:
    """Immutable directed costs from a configured OSRM profile's table service."""

    def __init__(self, version: str, cells: dict):
        self.version = version
        self.cells = cells
        self.profiles = frozenset(key[0] for key in cells)

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Return table costs, preserving NoRoute separately from missing provider data."""
        key = (profile, origin.lat, origin.lon, destination.lat, destination.lon)
        if key not in self.cells:
            raise TravelUnavailable("OSRM_TABLE_PAIR_MISSING")
        value = self.cells[key]
        if value is None:
            return None
        duration, distance = value
        return TravelQuote(
            math.ceil(duration), math.ceil(distance), (origin, destination), "road_matrix"
        )


def prepare_osrm(provider: OSRMTravel, points: list[GeoPoint], offline: bool) -> PreparedOSRMMatrix:
    """Prepare directed blocks of at most 100 coordinates, with durable offline reuse."""
    cells = {}
    profiles = {"car": "driving", "walk": "walking", "bike": "cycling", "transit": "transit"}
    blocks = [points[i : i + 50] for i in range(0, len(points), 50)]
    for profile, endpoint in provider.endpoints.items():
        try:
            for sources in blocks:
                for targets in blocks:
                    combined = list({(p.lat, p.lon): p for p in [*sources, *targets]}.values())
                    indices = {(p.lat, p.lon): i for i, p in enumerate(combined)}
                    identity = [
                        "table-v1",
                        profile,
                        [(p.lat, p.lon) for p in sources],
                        [(p.lat, p.lon) for p in targets],
                    ]
                    path = provider.cache / (
                        "table-" + content_hash(json.dumps(identity).encode()) + ".json"
                    )

                    def validate(data):
                        if data.get("code") != "Ok":
                            raise ValueError("invalid table status")
                        for field in ("durations", "distances"):
                            rows = data.get(field)
                            if not isinstance(rows, list) or len(rows) != len(sources):
                                raise ValueError("invalid table rows")
                            for row in rows:
                                if not isinstance(row, list) or len(row) != len(targets):
                                    raise ValueError("invalid table columns")
                                for value in row:
                                    if value is not None:
                                        _cost(value)
                        for i in range(len(sources)):
                            for j in range(len(targets)):
                                duration, distance = (
                                    data["durations"][i][j],
                                    data["distances"][i][j],
                                )
                                if (duration is None) != (distance is None) or (
                                    distance and duration == 0
                                ):
                                    raise ValueError("inconsistent table cell")

                    def fetch():
                        coordinates = ";".join(f"{p.lon},{p.lat}" for p in combined)
                        response = httpx.get(
                            f"{endpoint.rstrip('/')}/table/v1/{profiles[profile]}/{coordinates}",
                            params={
                                "annotations": "duration,distance",
                                "sources": ";".join(str(indices[p.lat, p.lon]) for p in sources),
                                "destinations": ";".join(
                                    str(indices[p.lat, p.lon]) for p in targets
                                ),
                            },
                            timeout=15.0,
                            trust_env=False,
                        )
                        response.raise_for_status()
                        return response.json(), validate

                    data = _document(path, fetch, offline or provider.offline)
                    validate(data)
                    for i, source in enumerate(sources):
                        for j, target in enumerate(targets):
                            duration, distance = data["durations"][i][j], data["distances"][i][j]
                            cells[profile, source.lat, source.lon, target.lat, target.lon] = (
                                None if duration is None else (duration, distance)
                            )
        except _PROVIDER_FAILURES:
            _LOGGER.warning(
                "PLANNING_OSRM_MATRIX_UNAVAILABLE profile=%s; using prepared regional costs",
                profile,
            )
    return PreparedOSRMMatrix(provider.version, cells)


def _prepared_travel(
    graph: RoadGraph | TravelSource,
    settings: SearchSettings,
    snapshot: RouterTaskSnapshot,
    offline: bool,
) -> TravelSource:
    from core.roadimport import ImportedRoadOverlay

    points = snapshot_points(snapshot)
    base = GraphTravel(graph) if isinstance(graph, RoadGraph) else graph
    # Imported edges remain authoritative; prepare only the provider underneath them.
    if isinstance(base, ImportedRoadOverlay):
        prepared = _prepared_travel(base.base, settings, snapshot, offline)
        return ImportedRoadOverlay(prepared, base.graph.graph)
    osrm = base if isinstance(base, OSRMTravel) else (None if offline else live_osrm_from_env())
    if isinstance(base, OSRMTravel):
        # With no regional graph, an offline miss is an honest provider failure.
        # Inventing a straight-line base here would hide a missing required source.
        if osrm is None:
            raise TravelUnavailable("PLANNING_OSRM_UNAVAILABLE")
        base = prepare_osrm(osrm, points, offline)
    elif osrm is not None:
        base = MixedTravel(base, prepare_osrm(osrm, points, offline))
    if not offline:
        cache_only = os.environ.get("ROUTER_ROAD_API_OFFLINE", "").lower() in {"1", "true", "yes"}
        road = prepare_road_api(
            points, snapshot.planning_as_of, settings.traffic_enabled, cache_only
        )
        if road is not None:
            base = MixedTravel(base, road)
    return base


def planning_travel(
    graph: RoadGraph | TravelSource,
    settings: SearchSettings,
    snapshot: RouterTaskSnapshot,
    *,
    offline: bool = False,
    learned_weather: Sequence[WeatherMultiplierCalibration] = (),
    learned_weather_enabled: bool = False,
) -> TravelSource:
    """Use prepared road costs; learned weather affects solver quotes only by explicit opt-in."""
    base = _prepared_travel(graph, settings, snapshot, offline)
    configured = configure_travel(base, settings.technical(), snapshot.planning_as_of)
    regions = {engineer.region for engineer in snapshot.engineers}
    if not learned_weather_enabled or len(regions) != 1 or None in regions or not learned_weather:
        return configured
    from core.geo import TechnicalTravel
    from core.weather import LearnedWeatherTravel

    region = next(iter(regions))
    return TechnicalTravel(
        LearnedWeatherTravel(configured.travel, region, tuple(learned_weather)),
        configured.settings,
    )


def planning_configuration() -> dict:
    """Include provider origins/map revisions in Runtime identity without network access."""
    names = (
        "ROUTER_ROAD_API_URL",
        "ROUTER_ROAD_API_MAP_VERSION",
        "ROUTER_ROAD_API_OFFLINE",
        "ROUTER_OSRM_URL",
        "ROUTER_OSRM_CAR_URL",
        "ROUTER_OSRM_WALK_URL",
        "ROUTER_OSRM_BIKE_URL",
        "ROUTER_OSRM_MAP_VERSION",
        "ROUTER_OSRM_OFFLINE",
    )
    return {"version": PLANNING_TRAVEL_VERSION, **{key: os.environ.get(key, "") for key in names}}
