"""Offline Moscow Metro graph loading and deterministic composite pedestrian quotes.

The module intentionally ships no station data.  A reviewed, versioned JSON artifact
is required; absent or malformed configured data leaves the legacy pedestrian quote
unchanged instead of inventing a metro path.
"""

from __future__ import annotations

import heapq
import json
import os
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator

from core.contracts import GeoPoint, Record, Transport
from core.geo import (
    TravelQuote,
    TravelSegment,
    TravelSource,
    content_hash,
    haversine_m,
    joined_segments,
    quote_at,
)
from core.metro_timetable import TIMETABLE_VERSION, next_departure


class MetroStation(Record):
    """One named station/platform point in the reviewed offline network."""

    station_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    location: GeoPoint
    line_id: str | None = Field(default=None, min_length=1)


class MetroEdge(Record):
    """Directed ride or reviewed interchange edge; time is an offline estimate."""

    source: str
    target: str
    duration_sec: int = Field(ge=0)
    distance_m: int = Field(ge=0)
    kind: Literal["ride", "transfer"] = "ride"
    geometry: list[GeoPoint] | None = None

    @field_validator("geometry", mode="before")
    @classmethod
    def _parse_geometry(cls, value):
        """Accept the artifact's compact [[lat, lon], ...] geometry payloads."""
        if isinstance(value, list):
            return [
                GeoPoint.model_validate({"lat": point[0], "lon": point[1]})
                if isinstance(point, (list, tuple))
                else point
                for point in value
            ]
        return value


class MetroBoundaryGeoJSON(Record):
    """Moscow boundary in standard GeoJSON lon/lat order, including holes/enclaves."""

    type: str = "MultiPolygon"
    coordinates: list[list[list[list[float]]]] = Field(min_length=1)

    @model_validator(mode="after")
    def check_coordinates(self):
        """Require closed-enough polygon rings without converting GeoJSON ordering."""
        if self.type != "MultiPolygon" or any(
            not polygon or any(len(ring) < 3 for ring in polygon)
            for polygon in self.coordinates
        ):
            raise ValueError("invalid metro MultiPolygon boundary")
        if any(
            len(point) != 2 or not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90)
            for polygon in self.coordinates
            for ring in polygon
            for point in ring
        ):
            raise ValueError("invalid metro boundary coordinate")
        return self


class MetroNetwork(Record):
    """Strict portable metro resource, including exact supported Moscow boundary rings."""

    schema_version: str = "1.0"
    version: str = Field(min_length=1)
    source: str = Field(min_length=1)
    boundary_geojson: MetroBoundaryGeoJSON
    stations: list[MetroStation] = Field(min_length=1)
    edges: list[MetroEdge]
    enter_sec: int = Field(ge=0)
    exit_sec: int = Field(ge=0)
    wait_sec: int = Field(ge=0)
    transfer_sec: int = Field(ge=0)
    max_access_m: int = Field(default=1_500, gt=0, le=10_000)

    @model_validator(mode="after")
    def check_network(self):
        """Reject incomplete rings, duplicate stations and dangling graph edges."""
        ids = {station.station_id for station in self.stations}
        if len(ids) != len(self.stations):
            raise ValueError("duplicate metro station ID")
        if any(edge.source not in ids or edge.target not in ids for edge in self.edges):
            raise ValueError("metro edge references missing station")
        return self

    @property
    def content_version(self) -> str:
        """Hash actual resource content so a label alone cannot retain stale routes."""
        return content_hash(self.model_dump_json().encode("utf-8"))


def load_metro_network(path: Path) -> MetroNetwork:
    """Load one checked UTF-8 static artifact; no network acquisition occurs here."""
    return MetroNetwork.model_validate_json(path.read_bytes())


def _inside_ring(point: GeoPoint, ring: list[list[float]]) -> bool:
    """Use a boundary-inclusive ray cast for one WGS84 outer ring."""
    inside = False
    for index, current in enumerate(ring):
        previous = ring[index - 1]
        if (current[1] > point.lat) != (previous[1] > point.lat):
            crossing = (previous[0] - current[0]) * (point.lat - current[1]) / (
                previous[1] - current[1]
            ) + current[0]
            if point.lon < crossing:
                inside = not inside
    return inside


@dataclass(frozen=True)
class _Path:
    duration_sec: int
    distance_m: int
    station_ids: tuple[str, ...]
    has_ride: bool
    edges: tuple["MetroEdge", ...] = ()


def choose_metro(walking_sec: int | None, metro_sec: int | None, *, shelter: bool) -> bool:
    """Prefer metro when it is faster, and during a storm when it is not much slower."""
    if metro_sec is None:
        return False
    if walking_sec is None:
        return True
    if metro_sec < walking_sec:
        return True
    # A thunderstorm keeps the walker under cover unless the subway is a long detour.
    return shelter and metro_sec <= int(walking_sec * 1.75)


class MetroTravel:
    """Choose an offline metro composite for transit-eligible route profiles when it wins."""

    def __init__(self, travel: TravelSource, network: MetroNetwork, *, shelter: bool = False):
        self.travel = travel
        self.network = network
        self.stations = {station.station_id: station for station in network.stations}
        self.adjacency: dict[str, list[MetroEdge]] = {station_id: [] for station_id in self.stations}
        for edge in network.edges:
            self.adjacency[edge.source].append(edge)
        for edges in self.adjacency.values():
            edges.sort(key=lambda edge: (edge.target, edge.duration_sec, edge.distance_m, edge.kind))
        self._trees: dict[str, tuple[dict[str, tuple[int, int]], dict[str, MetroEdge]]] = {}
        self._timed_trees: OrderedDict = OrderedDict()
        self.shelter = shelter
        self.version = content_hash(
            json.dumps(
                {
                    "base_version": travel.version,
                    "metro_content": network.content_version,
                    "timetable": TIMETABLE_VERSION,
                    "shelter": shelter,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )

    def _verified(
        self, origin: GeoPoint, destination: GeoPoint, departure_at: int | None = None,
    ) -> tuple[bool, TravelQuote | None]:
        """A transit pair already answered by /route3 verification, if any.

        The verified route (walk or walk+metro+walk on real foot access) is the
        final answer for that pair; the offline composite must not undercut it.
        """
        layer = self.travel
        while layer is not None:
            corrections = getattr(layer, "corrections", None)
            if isinstance(corrections, dict):
                key = (origin.lat, origin.lon, destination.lat, destination.lon, "transit", departure_at)
                if key in corrections:
                    return True, corrections[key]
            layer = getattr(layer, "travel", None)
        return False, None

    def quote(self, origin: GeoPoint, destination: GeoPoint, profile: Transport) -> TravelQuote | None:
        """Compare the explicit transit profile with the metro composite."""
        if profile != "transit":
            return self.travel.quote(origin, destination, profile)
        found, verified = self._verified(origin, destination)
        if found:
            return verified
        walking = self.travel.quote(origin, destination, "walk")
        if not self._inside_moscow(origin) or not self._inside_moscow(destination):
            return walking
        candidate = self._metro_quote(origin, destination, None)
        walking_sec = None if walking is None else walking.duration_sec
        metro_sec = None if candidate is None else candidate.duration_sec
        if choose_metro(walking_sec, metro_sec, shelter=self.shelter):
            return candidate
        return walking

    def quote_at(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport, departure_at: int
    ) -> TravelQuote | None:
        """Build access, metro and egress segments only for supported city points."""
        if profile == "transit":
            found, verified = self._verified(origin, destination, departure_at)
            if found:
                return verified
        # Transit uses pedestrian access and egress around the optional graph.
        base_profile = "walk" if profile in ("walk", "transit") else profile
        walking = quote_at(self.travel, origin, destination, base_profile, departure_at)
        if profile != "transit" or not self._inside_moscow(origin) or not self._inside_moscow(destination):
            return walking
        candidate = self._metro_quote(origin, destination, departure_at)
        walking_sec = None if walking is None else walking.duration_sec
        metro_sec = None if candidate is None else candidate.duration_sec
        if choose_metro(walking_sec, metro_sec, shelter=self.shelter):
            return candidate
        return walking

    def _inside_moscow(self, point: GeoPoint) -> bool:
        for polygon in self.network.boundary_geojson.coordinates:
            outer, *holes = polygon
            if _inside_ring(point, outer) and not any(_inside_ring(point, hole) for hole in holes):
                return True
        return False

    def _nearby(self, point: GeoPoint) -> tuple[MetroStation, ...]:
        """Return every candidate within the declared access radius in stable order."""
        return tuple(
            station
            for distance, station in sorted(
                ((haversine_m(point, station.location), station) for station in self.stations.values()),
                key=lambda item: (item[0], item[1].station_id),
            )
            if distance <= self.network.max_access_m
        )

    def _shortest(self, source: str, target: str) -> _Path | None:
        if source not in self._trees:
            distances: dict[str, tuple[int, int]] = {source: (0, 0)}
            previous: dict[str, MetroEdge] = {}
            queue = [(0, 0, source)]
            while queue:
                seconds, metres, station = heapq.heappop(queue)
                if distances[station] != (seconds, metres):
                    continue
                for edge in self.adjacency[station]:
                    transfer = 60 if edge.kind == "transfer" else 0  # escalator overhead on transfers only
                    cost = (seconds + edge.duration_sec + transfer, metres + edge.distance_m)
                    if edge.target not in distances or cost < distances[edge.target]:
                        distances[edge.target] = cost
                        previous[edge.target] = edge
                        heapq.heappush(queue, (*cost, edge.target))
            self._trees[source] = distances, previous
        distances, previous = self._trees[source]
        if target not in distances:
            return None
        ids = [target]
        path_edges = []
        cursor = target
        while cursor != source:
            edge = previous[cursor]
            path_edges.append(edge)
            cursor = edge.source
            ids.append(cursor)
        seconds, metres = distances[target]
        return _Path(
            seconds,
            metres,
            tuple(reversed(ids)),
            any(edge.kind == "ride" for edge in path_edges),
            tuple(reversed(path_edges)),
        )

    def _shortest_at(self, source: str, target: str, departure_at: int) -> _Path | None:
        """Earliest arrival with headway waits on boarding and after interchanges.

        The state distinguishes being aboard from needing to board: an earlier
        arrival on foot cannot dominate an already boarded passenger. Remaining
        on a train needs no extra wait at intermediate stations.
        """
        initial = (source, True)
        cache_key = (source, departure_at)
        cached = self._timed_trees.get(cache_key)
        if cached is None:
            costs = {initial: (departure_at, 0)}
            previous: dict[tuple[str, bool], tuple[tuple[str, bool], MetroEdge]] = {}
            queue = [(departure_at, 0, source, True)]
            while queue:
                epoch, metres, station, boarding = heapq.heappop(queue)
                state = (station, boarding)
                if costs[state] != (epoch, metres):
                    continue
                for edge in self.adjacency[station]:
                    start = epoch
                    if edge.kind == "ride" and boarding:
                        start = next_departure(epoch)
                        if start is None:
                            continue
                    transfer = edge.kind == "transfer"
                    arrival = start + edge.duration_sec + (60 if transfer else 0)
                    nxt = (edge.target, transfer)
                    candidate = (arrival, metres + edge.distance_m)
                    if nxt not in costs or candidate < costs[nxt]:
                        costs[nxt] = candidate
                        previous[nxt] = (state, edge)
                        heapq.heappush(queue, (*candidate, *nxt))
            self._timed_trees[cache_key] = (costs, previous)
            if len(self._timed_trees) > 64:
                self._timed_trees.popitem(last=False)
        else:
            costs, previous = cached
            self._timed_trees.move_to_end(cache_key)
        choices = [state for state in ((target, False), (target, True)) if state in costs]
        if not choices:
            return None
        final = min(choices, key=lambda state: costs[state])
        path_edges = []
        cursor = final
        while cursor != initial:
            cursor, edge = previous[cursor]
            path_edges.append(edge)
        path_edges.reverse()
        arrival, metres = costs[final]
        return _Path(
            arrival - departure_at, metres,
            (source, *(edge.target for edge in path_edges)),
            any(edge.kind == "ride" for edge in path_edges), tuple(path_edges),
        )

    def _metro_quote(
        self, origin: GeoPoint, destination: GeoPoint, departure_at: int | None
    ) -> TravelQuote | None:
        wait_sec = self.network.wait_sec if departure_at is None else 0
        sources, targets = self._nearby(origin), self._nearby(destination)
        if not sources or not targets:
            return None
        accesses = [
            (station, self._walking_quote(origin, station.location, departure_at))
            for station in sources
        ]
        egresses = [(station, self._walking_quote(station.location, destination, departure_at)) for station in targets]
        best: TravelQuote | None = None
        for source_station, access in accesses:
            if access is None:
                continue
            for target_station, initial_egress in egresses:
                path = (
                    self._shortest(source_station.station_id, target_station.station_id)
                    if departure_at is None
                    else self._shortest_at(
                        source_station.station_id, target_station.station_id,
                        departure_at + access.duration_sec + self.network.enter_sec,
                    )
                )
                if path is None or not path.has_ride:
                    continue
                egress_at = (
                    None
                    if departure_at is None
                    else departure_at
                    + access.duration_sec
                    + self.network.enter_sec
                    + wait_sec
                    + path.duration_sec
                    + self.network.exit_sec
                )
                egress = (
                    initial_egress
                    if departure_at is None
                    else self._walking_quote(target_station.location, destination, egress_at)
                )
                if egress is None:
                    continue
                metro_points = _path_points(path, self.stations)
                segments = joined_segments(
                    (
                        TravelSegment(access.points, access.provenance, access.duration_sec, access.distance_m),
                        TravelSegment(
                            metro_points,
                            "metro",
                            self.network.enter_sec + wait_sec + path.duration_sec + self.network.exit_sec,
                            path.distance_m,
                        ),
                        TravelSegment(egress.points, egress.provenance, egress.duration_sec, egress.distance_m),
                    ),
                    origin,
                    destination,
                )
                candidate = TravelQuote(
                    duration_sec=sum(segment.duration_sec for segment in segments),
                    distance_m=sum(segment.distance_m for segment in segments),
                    points=_join_points(*(segment.points for segment in segments)),
                    provenance="metro",
                    geometry_exact=True,
                    segments=segments,
                )
                if best is None or (candidate.duration_sec, candidate.distance_m) < (
                    best.duration_sec,
                    best.distance_m,
                ):
                    best = candidate
        return best

    def _walking_quote(
        self, origin: GeoPoint, destination: GeoPoint, departure_at: int | None
    ) -> TravelQuote | None:
        """Use static quotes in matrix construction and departure-aware quotes in schedules."""
        if departure_at is None:
            return self.travel.quote(origin, destination, "walk")
        return quote_at(self.travel, origin, destination, "walk", departure_at)


def _path_points(path: _Path, stations: dict[str, "MetroStation"]) -> tuple[GeoPoint, ...]:
    """Middle-segment polyline: per-edge line geometry when present, else chords.

    Edges are already in travel order. Artifact line geometry is stored in one
    direction and ends near, not on, the platforms, so each polyline is turned
    to run from its source station and pinned to both station coordinates:
    the ride is one continuous line from entry to exit station.
    """
    points: list[GeoPoint] = []
    for edge in path.edges:
        start = stations[edge.source].location
        end = stations[edge.target].location
        polyline = list(edge.geometry or ())
        if polyline and haversine_m(polyline[-1], start) < haversine_m(polyline[0], start):
            polyline.reverse()
        for point in (start, *polyline, end):
            if not points or point != points[-1]:
                points.append(point)
    return tuple(points)


def _join_points(*parts: tuple[GeoPoint, ...]) -> tuple[GeoPoint, ...]:
    """Concatenate component polylines without duplicate joins or invented lines."""
    points: list[GeoPoint] = []
    for part in parts:
        for point in part:
            if not points or point != points[-1]:
                points.append(point)
    return tuple(points)


def configured_metro_travel(travel: TravelSource, *, shelter: bool = False) -> TravelSource:
    """Load the bundled reviewed artifact; an environment path may override it."""
    configured = os.environ.get("ROUTER_METRO_DATA_PATH", "").strip()
    path = Path(configured) if configured else Path(__file__).parent / "resources/metro/moscow.json"
    try:
        return MetroTravel(travel, load_metro_network(path), shelter=shelter)
    except (OSError, ValueError):
        return travel
