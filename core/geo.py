"""Offline directed transport graph, shortest paths and explicit address lookup.

Graph costs are provided data, not inferred traffic. Transit edges must be supplied
explicitly; walking or driving is never silently substituted for public transport.
"""

import hashlib
import heapq
import json
import math
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from pydantic import Field, model_validator

from core.contracts import (
    GeoPoint,
    Record,
    RouterTechnicalSettings,
    Transport,
    TravelProvenance,
)
from core.traffic_engine import (
    _FORECAST_TRAFFIC_VERSION,
    ForecastTrafficTravel,
    configure_forecast_traffic,
)
from core.traffic_engine import (
    forecast_traffic_factor as forecast_traffic_factor,
)

_FALLBACK_ROAD_FACTOR = 1.25
_FALLBACK_SPEED_KMH: dict[Transport, float] = {
    "car": 28.0,
    "walk": 5.0,
    "bike": 15.0,
    "transit": 22.0,
}
_FALLBACK_TRANSIT_ACCESS_SEC = 480


def content_hash(payload: bytes) -> str:
    """Return SHA-256 of exact published UTF-8 bytes, without reserialization."""
    return hashlib.sha256(payload).hexdigest()


def haversine_m(a: GeoPoint, b: GeoPoint) -> float:
    """Great-circle metres for matching coordinates, never a road ETA substitute."""
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat, dlon = lat2 - lat1, math.radians(b.lon - a.lon)
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371008.8 * 2 * math.asin(min(1, math.sqrt(value)))


class GraphNode(Record):
    """Stable road vertex in WGS84."""

    node_id: str = Field(min_length=1)
    location: GeoPoint


class GraphEdge(Record):
    """Directed arc with profile-specific seconds and integer metres."""

    source: str
    target: str
    distance_m: int = Field(ge=0)
    duration_sec: dict[Transport, int]
    geometry: list[GeoPoint] | None = None

    @model_validator(mode="after")
    def check_costs(self):
        """Exclude invalid travel costs before shortest-path computation."""
        if not self.duration_sec or any(
            type(v) is not int or v < 0 for v in self.duration_sec.values()
        ):
            raise ValueError("edge durations must be nonnegative integer seconds")
        if self.distance_m > 0 and any(v == 0 for v in self.duration_sec.values()):
            raise ValueError("positive-distance travel requires positive duration")
        return self


class RoadGraph(Record):
    """Portable graph resource; content hash, not its label, controls invalidation."""

    version: str
    source: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]

    @model_validator(mode="after")
    def check_graph(self):
        """Verify identity, geometry endpoints and edge referential integrity."""
        lookup = {n.node_id: n.location for n in self.nodes}
        if len(lookup) != len(self.nodes):
            raise ValueError("duplicate graph node ID")
        if len({(p.lat, p.lon) for p in lookup.values()}) != len(lookup):
            raise ValueError(
                "duplicate node coordinates require explicit disambiguation before import"
            )
        for edge in self.edges:
            if edge.source not in lookup or edge.target not in lookup:
                raise ValueError("edge references missing node")
            if edge.geometry and (
                edge.geometry[0] != lookup[edge.source] or edge.geometry[-1] != lookup[edge.target]
            ):
                raise ValueError("edge geometry endpoints must match its nodes")
        return self


@dataclass(frozen=True)
class TravelQuote:
    """One path's time, distance and geometry; None represents unreachable travel."""

    duration_sec: int
    distance_m: int
    points: tuple[GeoPoint, ...]
    provenance: TravelProvenance
    traffic_factor: float = 1.0
    geometry_exact: bool = False


class TravelSource(Protocol):
    """Minimal immutable provider contract accepted by timing-policy decoration."""

    version: str

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Return one route quote or ``None`` when the route is unreachable."""
        ...


def quote_at(
    travel: TravelSource,
    origin: GeoPoint,
    destination: GeoPoint,
    profile: Transport,
    departure_at: int,
) -> TravelQuote | None:
    """Quote at a departure clock when supported, otherwise use the legacy quote."""
    timed_quote = getattr(travel, "quote_at", None)
    if callable(timed_quote):
        return timed_quote(origin, destination, profile, departure_at)
    return travel.quote(origin, destination, profile)


class TechnicalTravel:
    """Apply Router-owned timing policy while preserving the graph path and distance."""

    def __init__(self, travel: TravelSource, settings: RouterTechnicalSettings):
        """Wrap one immutable provider with a complete technical settings revision."""
        self.travel = travel
        self.settings = settings
        timing = {
            "base_version": travel.version,
            "travel_time_mode": settings.travel_time_mode,
            "access_buffer_sec": settings.access_buffer_sec,
            "fixed_travel_time_sec": settings.fixed_travel_time_sec,
        }
        self.version = content_hash(
            json.dumps(timing, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Return configured duration; zero-distance legs remain zero-cost."""
        return self._apply(self.travel.quote(origin, destination, profile))

    def quote_at(
        self,
        origin: GeoPoint,
        destination: GeoPoint,
        profile: Transport,
        departure_at: int,
    ) -> TravelQuote | None:
        """Apply technical timing to the provider's departure-aware quote."""
        return self._apply(quote_at(self.travel, origin, destination, profile, departure_at))

    def _apply(self, quote: TravelQuote | None) -> TravelQuote | None:
        """Apply configured timing once while retaining one quote's provenance."""
        if quote is None or quote.distance_m == 0:
            return quote
        duration_sec = (
            quote.duration_sec + self.settings.access_buffer_sec
            if self.settings.travel_time_mode == "graph_with_access_buffer"
            else self.settings.fixed_travel_time_sec
        )
        provenance = (
            quote.provenance
            if self.settings.travel_time_mode == "graph_with_access_buffer"
            else "approximate"
        )
        traffic_factor = (
            quote.traffic_factor
            if self.settings.travel_time_mode == "graph_with_access_buffer"
            else 1.0
        )
        return TravelQuote(
            duration_sec,
            quote.distance_m,
            quote.points,
            provenance,
            traffic_factor,
            quote.geometry_exact if provenance != "approximate" else False,
        )


def configure_travel(
    travel: TravelSource,
    settings: RouterTechnicalSettings,
    planning_as_of: int | None = None,
) -> TechnicalTravel:
    """Return one timing and optional planning-time-traffic context for all paths."""
    if isinstance(travel, TechnicalTravel) and travel.settings == settings:
        configured_base = travel.travel
        if planning_as_of is None or (
            isinstance(configured_base, ForecastTrafficTravel)
            and configured_base.planning_as_of == planning_as_of
        ):
            return travel
    if isinstance(travel, TechnicalTravel):
        travel = travel.travel
    if planning_as_of is not None and settings.traffic_enabled:
        travel = configure_forecast_traffic(travel, planning_as_of)
    elif not settings.traffic_enabled and isinstance(travel, ForecastTrafficTravel):
        travel = travel.travel
    return TechnicalTravel(travel, settings)


def routing_context_version(travel: TravelSource, settings: RouterTechnicalSettings) -> str:
    """Return stable routing-data identity, excluding the planning-time proxy band."""
    while isinstance(travel, TechnicalTravel):
        travel = travel.travel
    while isinstance(travel, ForecastTrafficTravel):
        travel = travel.travel
    context = {
        "base_version": travel.version,
        "forecast_version": _FORECAST_TRAFFIC_VERSION,
        "traffic_enabled": settings.traffic_enabled,
        "equipment_enabled": settings.equipment_enabled,
        "window_lateness_tolerance_sec": settings.window_lateness_tolerance_sec,
        "travel_time_mode": settings.travel_time_mode,
        "access_buffer_sec": settings.access_buffer_sec,
        "fixed_travel_time_sec": settings.fixed_travel_time_sec,
    }
    return content_hash(json.dumps(context, sort_keys=True, separators=(",", ":")).encode("utf-8"))


class GraphTravel:
    """Deterministic Dijkstra by time then distance, with cached source trees.

    Exact graph coordinates use published directed costs. Unknown coordinates use a
    disclosed straight-line/profile approximation; known but disconnected vertices
    remain unreachable and are never silently bridged.
    """

    def __init__(self, graph: RoadGraph):
        """Copy the validated resource so later caller mutations cannot change costs."""
        self.graph = graph.model_copy(deep=True)
        self.version = content_hash(self.graph.model_dump_json().encode("utf-8"))
        self.provenance: TravelProvenance = (
            "traffic_api" if self.graph.version.startswith("2gis:") else "road_matrix"
        )
        self.nodes = {n.node_id: n.location for n in self.graph.nodes}
        self.locations = {(p.lat, p.lon): key for key, p in self.nodes.items()}
        self.adjacency: dict[str, list[GraphEdge]] = {key: [] for key in self.nodes}
        for edge in self.graph.edges:
            self.adjacency[edge.source].append(edge)
        for edges in self.adjacency.values():
            edges.sort(key=lambda e: (e.target, e.distance_m, e.model_dump_json()))
        self._trees: dict[tuple[str, str], tuple[dict, dict]] = {}

    def nearest(self, point: GeoPoint, limit_m: float) -> tuple[str, GeoPoint, float] | None:
        """Return a candidate projection with distance; callers must accept it explicitly."""
        if not self.nodes:
            return None
        distance, key = min((haversine_m(point, p), key) for key, p in self.nodes.items())
        return (key, self.nodes[key], distance) if distance <= limit_m else None

    def _node(self, point: GeoPoint) -> str | None:
        direct = self.locations.get((point.lat, point.lon))
        if direct is not None:
            return direct
        candidate = self.nearest(point, 0.001)
        return candidate[0] if candidate else None

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Return a graph path, or a disclosed deterministic fallback for unknown points."""
        source, target = self._node(origin), self._node(destination)
        if source is None or target is None:
            distance = math.ceil(haversine_m(origin, destination) * _FALLBACK_ROAD_FACTOR)
            if distance == 0:
                return TravelQuote(0, 0, (origin, destination), "approximate")
            duration = max(
                1,
                math.ceil(distance / (_FALLBACK_SPEED_KMH[profile] * 1000 / 3600)),
            )
            if profile == "transit":
                duration += _FALLBACK_TRANSIT_ACCESS_SEC
            return TravelQuote(
                duration,
                distance,
                (origin, destination),
                "approximate",
            )
        if source == target:
            return TravelQuote(0, 0, (origin, destination), self.provenance)
        key = (source, profile)
        if key not in self._trees:
            distances = {source: (0, 0)}
            previous: dict[str, GraphEdge] = {}
            queue = [(0, 0, source)]
            while queue:
                seconds, metres, node = heapq.heappop(queue)
                if distances[node] != (seconds, metres):
                    continue
                for edge in self.adjacency[node]:
                    if profile not in edge.duration_sec:
                        continue
                    cost = (seconds + edge.duration_sec[profile], metres + edge.distance_m)
                    if edge.target not in distances or cost < distances[edge.target]:
                        distances[edge.target] = cost
                        previous[edge.target] = edge
                        heapq.heappush(queue, (*cost, edge.target))
            self._trees[key] = distances, previous
        distances, previous = self._trees[key]
        if target not in distances:
            return None
        edges = []
        cursor = target
        while cursor != source:
            edge = previous[cursor]
            edges.append(edge)
            cursor = edge.source
        points = [self.nodes[source]]
        ordered_edges = list(reversed(edges))
        for edge in ordered_edges:
            points.extend((edge.geometry or [self.nodes[edge.source], self.nodes[edge.target]])[1:])
        seconds, metres = distances[target]
        return TravelQuote(
            seconds,
            metres,
            tuple(points),
            self.provenance,
            geometry_exact=all(edge.geometry is not None for edge in ordered_edges),
        )

    def matrix(self, points: list[GeoPoint], profile: Transport) -> list[list[TravelQuote | None]]:
        """Prepare an asymmetric all-pairs matrix from cached source trees."""
        return [[self.quote(a, b, profile) for b in points] for a in points]


def _road_quality_node(graph: RoadGraph, node_id: str) -> bool:
    """Return True when this vertex belongs to a prepared road/OSRM/traffic subgraph."""
    if node_id.startswith("east:"):
        return True
    if node_id.startswith("southeast:") or node_id.startswith("south_central:"):
        return False
    version = graph.version.lower()
    if "centroid" in version or "haversine" in version:
        return False
    return "osrm" in version or "2gis" in version or version.startswith("2gis:")


class MixedTravel:
    """Use the prepared graph where it is road-quality; otherwise try a live overlay.

    A combined official graph already mixes East OSRM vertices with Southeast /
    South-central centroid vertices. Unknown uploaded points fall back to the
    overlay (OSRM/traffic) when configured, then to the graph's disclosed
    approximation. Overlay absence leaves quotes unchanged.
    """

    def __init__(self, travel: TravelSource, overlay: TravelSource):
        """Bind one immutable graph provider and one optional live road provider."""
        self.travel = travel
        self.overlay = overlay
        self.version = content_hash(
            json.dumps(
                {"base": travel.version, "overlay": overlay.version},
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        self.provenance: TravelProvenance = getattr(overlay, "provenance", "route_api")

    def _needs_overlay(
        self, origin: GeoPoint, destination: GeoPoint, quote: TravelQuote | None
    ) -> bool:
        """Upgrade centroid, approximate and missing graph legs when a better source exists."""
        if quote is None or quote.provenance == "approximate":
            return True
        graph = getattr(self.travel, "graph", None)
        nearest = getattr(self.travel, "_node", None)
        if graph is None or not callable(nearest):
            return False
        source, target = nearest(origin), nearest(destination)
        if source is None or target is None:
            return True
        return not (_road_quality_node(graph, source) and _road_quality_node(graph, target))

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Prefer exact road-graph costs; overlay only the legs that are not road-quality."""
        base = self.travel.quote(origin, destination, profile)
        if not self._needs_overlay(origin, destination, base):
            return base
        upgraded = self.overlay.quote(origin, destination, profile)
        return upgraded if upgraded is not None else base


class AddressCandidate(Record):
    """Geocoding result with provenance, not an automatically accepted address."""

    address: str
    location: GeoPoint
    source: str


def normalize_address(address: str) -> str:
    """Normalize Unicode/case/whitespace without deleting meaningful address tokens."""
    return " ".join(unicodedata.normalize("NFKC", address).casefold().split())


class Gazetteer:
    """Offline address catalog; ambiguity and missing addresses remain explicit."""

    def __init__(self, entries: list[AddressCandidate]):
        """Build a deterministic lookup index from validated, attributed candidates."""
        self.entries: dict[str, list[AddressCandidate]] = {}
        for entry in entries:
            self.entries.setdefault(normalize_address(entry.address), []).append(entry)

    @classmethod
    def from_file(cls, path: Path) -> "Gazetteer":
        """Read an UTF-8 JSON candidate array prepared by an importer/provider."""
        payload = json.loads(path.read_text(encoding="utf-8"))
        return cls([AddressCandidate.model_validate(item) for item in payload])

    def lookup(self, address: str) -> list[AddressCandidate]:
        """Return all exact normalized matches; never guess a missing location."""
        return list(self.entries.get(normalize_address(address), []))
