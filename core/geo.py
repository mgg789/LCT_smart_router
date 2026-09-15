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

from pydantic import Field, model_validator

from core.contracts import GeoPoint, Record, Transport


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


class GraphTravel:
    """Deterministic Dijkstra by time then distance, with cached source trees.

    V1 matches exact node coordinates (within 1 mm for float round-off). Address points
    must be projected to graph nodes explicitly before snapshot publication. This
    avoids inventing zero-cost access roads or silently snapping across barriers.
    """

    def __init__(self, graph: RoadGraph):
        """Copy the validated resource so later caller mutations cannot change costs."""
        self.graph = graph.model_copy(deep=True)
        self.version = content_hash(self.graph.model_dump_json().encode("utf-8"))
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
        """Return a real directed path or None; never fill a missing path with zeros."""
        source, target = self._node(origin), self._node(destination)
        if source is None or target is None:
            return None
        if source == target:
            return TravelQuote(0, 0, (origin, destination))
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
        for edge in reversed(edges):
            points.extend((edge.geometry or [self.nodes[edge.source], self.nodes[edge.target]])[1:])
        seconds, metres = distances[target]
        return TravelQuote(seconds, metres, tuple(points))

    def matrix(self, points: list[GeoPoint], profile: Transport) -> list[list[TravelQuote | None]]:
        """Prepare an asymmetric all-pairs matrix from cached source trees."""
        return [[self.quote(a, b, profile) for b in points] for a in points]


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
