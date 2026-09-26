"""Strict offline import and persistent merge of OSRM road resources.

The importer accepts the portable ``RoadGraph`` shape as well as native OSRM
route/table responses.  It deliberately produces the same validated graph used
by :class:`core.geo.GraphTravel`; no route cost is inferred from a straight
line when a supplied OSRM edge is malformed or missing.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import ValidationError

from core.contracts import GeoPoint, Transport
from core.geo import (
    GraphEdge,
    GraphNode,
    GraphTravel,
    RoadGraph,
    TravelQuote,
    TravelSource,
    content_hash,
    quote_at,
)

RoadProfile = Literal["car", "walk", "bike", "transit"]
PROFILES: frozenset[str] = frozenset({"car", "walk", "bike", "transit"})
MAX_IMPORT_BYTES = 64 * 1024 * 1024
MAX_NODES = 500_000
MAX_EDGES = 2_000_000
MAX_GEOMETRY_POINTS = 100_000


class RoadImportError(ValueError):
    """Validation or persistence refusal with a stable machine-readable code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class RoadImportResult:
    """Summary returned after a graph was accepted and persisted."""

    operation_id: str
    status: Literal["accepted", "replayed"]
    graph_version: str
    router_context_version: str | None
    input_sha256: str
    profiles: tuple[RoadProfile, ...]
    nodes: int
    edges: int

    def as_dict(self) -> dict[str, Any]:
        """Return the snake-case boundary representation used by FastAPI."""
        return {
            "operation_id": self.operation_id,
            "status": self.status,
            "graph_version": self.graph_version,
            "router_context_version": self.router_context_version,
            "input_sha256": self.input_sha256,
            "profiles": list(self.profiles),
            "nodes": self.nodes,
            "edges": self.edges,
        }


def _unique_json_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject duplicate keys before a later value could silently win."""
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RoadImportError("DUPLICATE_JSON_KEY", f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _decode_bytes(payload: bytes) -> bytes:
    """Decode optional gzip while bounding decompressed input against zip bombs."""
    if len(payload) > MAX_IMPORT_BYTES:
        raise RoadImportError("IMPORT_TOO_LARGE", "road import exceeds the byte limit")
    if payload[:2] != b"\x1f\x8b":
        return payload
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
            decoded = stream.read(MAX_IMPORT_BYTES + 1)
    except (OSError, EOFError) as exc:
        raise RoadImportError("INVALID_GZIP", "road import is not valid gzip") from exc
    if len(decoded) > MAX_IMPORT_BYTES:
        raise RoadImportError("IMPORT_TOO_LARGE", "decompressed road import exceeds the byte limit")
    return decoded


def decode_payload(payload: bytes | str) -> tuple[bytes, dict[str, Any]]:
    """Decode UTF-8 JSON and return exact decoded bytes plus a strict object."""
    if isinstance(payload, str):
        try:
            payload_bytes = base64.b64decode(payload, validate=True)
        except ValueError as exc:
            raise RoadImportError("INVALID_BASE64", "payload_base64 is invalid") from exc
    else:
        payload_bytes = payload
    decoded = _decode_bytes(payload_bytes)
    try:
        document = json.loads(decoded.decode("utf-8"), object_pairs_hook=_unique_json_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RoadImportError("INVALID_JSON", "road import must be UTF-8 JSON") from exc
    if not isinstance(document, dict):
        raise RoadImportError("INVALID_DOCUMENT", "road import root must be an object")
    return decoded, document


def _number(value: Any, name: str, *, integer: bool = False) -> int | float:
    """Require finite JSON numbers without accepting booleans or string coercion."""
    import math

    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RoadImportError("INVALID_COST", f"{name} must be a finite number")
    if integer and type(value) is not int:
        raise RoadImportError("INVALID_COST", f"{name} must be an integer")
    return value


def _point(raw: Any) -> GeoPoint:
    """Convert either OSRM ``[lon,lat]`` or a strict ``{lat,lon}`` point."""
    try:
        if isinstance(raw, dict):
            point = GeoPoint.model_validate(raw)
        elif isinstance(raw, (list, tuple)) and len(raw) >= 2:
            if type(raw[0]) not in (int, float) or type(raw[1]) not in (int, float):
                raise ValueError
            point = GeoPoint(lat=raw[1], lon=raw[0])
        else:
            raise ValueError
    except (ValidationError, ValueError, TypeError) as exc:
        raise RoadImportError("INVALID_COORDINATE", "coordinate is outside WGS84 bounds") from exc
    return point


def _geometry(raw: Any) -> list[GeoPoint] | None:
    """Validate a route geometry, including endpoints later in graph validation."""
    if raw is None:
        return None
    if isinstance(raw, dict):
        raw = raw.get("coordinates")
    if not isinstance(raw, list) or len(raw) < 2 or len(raw) > MAX_GEOMETRY_POINTS:
        raise RoadImportError("INVALID_GEOMETRY", "geometry needs 2..100000 points")
    return [_point(item) for item in raw]


def _profile(raw: Any, fallback: str | None) -> RoadProfile:
    """Validate a closed Router profile catalog."""
    if raw is not None and fallback is not None and raw != fallback:
        raise RoadImportError("PROFILE_CONFLICT", "payload and upload profile differ")
    value = raw if raw is not None else fallback
    if not isinstance(value, str) or value not in PROFILES:
        raise RoadImportError("INVALID_PROFILE", "profile must be car, walk, bike or transit")
    return value  # type: ignore[return-value]


def _node_id(raw: dict[str, Any]) -> str:
    """Read the common node id aliases used by native OSRM exports."""
    value = raw.get("node_id", raw.get("id"))
    if not isinstance(value, str) or not value.strip():
        raise RoadImportError("INVALID_NODE", "every node needs a non-empty id")
    return value.strip()


def _location(raw: dict[str, Any]) -> GeoPoint:
    """Read a node location from ``location``, ``coord`` or lat/lon fields."""
    value = raw.get("location", raw.get("coord", raw.get("coordinates")))
    if value is None and "lat" in raw and "lon" in raw:
        value = {"lat": raw["lat"], "lon": raw["lon"]}
    return _point(value)


def _parse_graph(document: dict[str, Any], default_profile: str | None) -> tuple[list[GraphNode], list[GraphEdge], set[RoadProfile]]:
    """Parse the portable graph document and merge scalar profile fields into edges."""
    if document.get("profile") is not None and default_profile is not None and document.get("profile") != default_profile:
        raise RoadImportError("PROFILE_CONFLICT", "payload and upload profile differ")
    raw_nodes = document.get("nodes")
    raw_edges = document.get("edges")
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
        raise RoadImportError("INVALID_DOCUMENT", "graph import needs nodes and edges arrays")
    if len(raw_nodes) > MAX_NODES or len(raw_edges) > MAX_EDGES:
        raise RoadImportError("IMPORT_TOO_LARGE", "graph node or edge count exceeds the limit")
    nodes: list[GraphNode] = []
    seen_nodes: set[str] = set()
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            raise RoadImportError("INVALID_NODE", "node must be an object")
        node_id = _node_id(raw)
        if node_id in seen_nodes:
            raise RoadImportError("DUPLICATE_NODE", f"duplicate node id: {node_id}")
        seen_nodes.add(node_id)
        nodes.append(GraphNode(node_id=node_id, location=_location(raw)))
    edges: list[GraphEdge] = []
    edge_map: dict[tuple[str, str], GraphEdge] = {}
    profiles: set[RoadProfile] = set()
    seen_profiles: set[tuple[str, str, str]] = set()
    for raw in raw_edges:
        if not isinstance(raw, dict):
            raise RoadImportError("INVALID_EDGE", "edge must be an object")
        source = raw.get("source", raw.get("from"))
        target = raw.get("target", raw.get("to"))
        if not isinstance(source, str) or not isinstance(target, str) or not source or not target:
            raise RoadImportError("INVALID_EDGE", "edge needs source and target")
        geometry = _geometry(raw.get("geometry"))
        duration = raw.get("duration_sec", raw.get("duration"))
        distance = raw.get("distance_m", raw.get("distance"))
        profile_map = duration if isinstance(duration, dict) else None
        if profile_map is None:
            profile = _profile(raw.get("profile"), default_profile or document.get("profile"))
            profile_map = {profile: duration}
        elif not profile_map:
            raise RoadImportError("INVALID_COST", "edge duration profile map is empty")
        costs: dict[Transport, int] = {}
        for profile_name, value in profile_map.items():
            profile = _profile(profile_name, None)
            if type(value) is not int or value < 0:
                raise RoadImportError("INVALID_COST", "duration must be a non-negative integer")
            costs[profile] = value
            profiles.add(profile)
            key = (source, target, profile)
            if key in seen_profiles:
                raise RoadImportError("DUPLICATE_DIRECTED_EDGE", f"duplicate {source}->{target} {profile}")
            seen_profiles.add(key)
        if type(distance) is not int or distance < 0:
            raise RoadImportError("INVALID_COST", "distance must be a non-negative integer")
        candidate = GraphEdge(
            source=source,
            target=target,
            distance_m=distance,
            duration_sec=costs,
            geometry=geometry,
        )
        previous = edge_map.get((source, target))
        if previous is None:
            edge_map[(source, target)] = candidate
            edges.append(candidate)
        else:
            if previous.distance_m != distance or (
                previous.geometry is not None
                and geometry is not None
                and previous.geometry != geometry
            ):
                raise RoadImportError("EDGE_COST_CONFLICT", f"cost differs for {source}->{target}")
            edge_map[(source, target)] = previous.model_copy(
                update={
                    "duration_sec": {**previous.duration_sec, **costs},
                    "geometry": previous.geometry or geometry,
                }
            )
            edges[-1] = edge_map[(source, target)]
    return nodes, edges, profiles


def _parse_navix_overlay(document: dict[str, Any], default_profile: str | None) -> tuple[list[GraphNode], list[GraphEdge], set[RoadProfile]]:
    """Parse the compact self-contained offline overlay format without a node catalog."""
    profile = _profile(document.get("profile"), default_profile)
    raw_edges = document.get("edges")
    if not isinstance(raw_edges, list) or len(raw_edges) > MAX_EDGES:
        raise RoadImportError("INVALID_DOCUMENT", "navix overlay needs an edges array")
    nodes: list[GraphNode] = []
    node_ids: dict[tuple[float, float], str] = {}

    def node_for(point: GeoPoint) -> str:
        key = (point.lat, point.lon)
        node_id = node_ids.get(key)
        if node_id is None:
            node_id = f"navix-{len(node_ids):08d}"
            node_ids[key] = node_id
            nodes.append(GraphNode(node_id=node_id, location=point))
        return node_id

    edges: list[GraphEdge] = []
    seen: set[tuple[str, str]] = set()
    for raw in raw_edges:
        if not isinstance(raw, dict):
            raise RoadImportError("INVALID_EDGE", "navix edge must be an object")
        coordinates = raw.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) != 2:
            raise RoadImportError("INVALID_EDGE", "navix edge needs two endpoint coordinates")
        source, target = node_for(_point(coordinates[0])), node_for(_point(coordinates[1]))
        if (source, target) in seen:
            raise RoadImportError("DUPLICATE_DIRECTED_EDGE", f"duplicate {source}->{target} {profile}")
        seen.add((source, target))
        duration, distance = raw.get("duration_sec"), raw.get("distance_m")
        if type(duration) is not int or duration < 0 or type(distance) is not int or distance < 0:
            raise RoadImportError("INVALID_COST", "navix edge costs must be non-negative integers")
        geometry = _geometry(raw.get("geometry"))
        if geometry is not None and (geometry[0] != nodes[int(source.rsplit("-", 1)[1])].location or geometry[-1] != nodes[int(target.rsplit("-", 1)[1])].location):
            raise RoadImportError("INVALID_GEOMETRY", "navix geometry endpoints must match coordinates")
        edges.append(
            GraphEdge(
                source=source,
                target=target,
                distance_m=distance,
                duration_sec={profile: duration},
                geometry=geometry,
            )
        )
    return nodes, edges, {profile}


def _osrm_locations(document: dict[str, Any], key: str) -> list[GeoPoint]:
    """Read OSRM waypoint locations from ``sources``/``destinations``."""
    raw = document.get(key)
    if not isinstance(raw, list):
        raw = document.get("locations")
    if not isinstance(raw, list):
        raise RoadImportError("INVALID_DOCUMENT", f"OSRM table response needs {key}")
    points: list[GeoPoint] = []
    for item in raw:
        value = item.get("location") if isinstance(item, dict) else item
        points.append(_point(value))
    return points


def _parse_osrm(document: dict[str, Any], profile: str | None) -> tuple[list[GraphNode], list[GraphEdge], set[RoadProfile]]:
    """Parse OSRM Table or Route responses into a directed graph."""
    selected = _profile(document.get("profile"), profile)
    durations = document.get("durations")
    distances = document.get("distances")
    if durations is not None:
        if not isinstance(durations, list) or not all(isinstance(row, list) for row in durations):
            raise RoadImportError("INVALID_OSRM", "durations must be a matrix")
        sources = _osrm_locations(document, "sources")
        destinations = _osrm_locations(document, "destinations")
        if len(durations) != len(sources) or any(len(row) != len(destinations) for row in durations):
            raise RoadImportError("INVALID_OSRM", "duration matrix dimensions do not match waypoints")
        if distances is not None and (
            not isinstance(distances, list)
            or len(distances) != len(sources)
            or any(not isinstance(row, list) or len(row) != len(destinations) for row in distances)
        ):
            raise RoadImportError("INVALID_OSRM", "distance matrix dimensions do not match waypoints")
        nodes: list[GraphNode] = []
        node_ids: list[str] = []
        by_coord: dict[tuple[float, float], str] = {}
        for index, point in enumerate(sources + destinations):
            key = (point.lat, point.lon)
            node_id = by_coord.setdefault(key, f"osrm-{len(by_coord):08d}")
            if node_id not in node_ids:
                node_ids.append(node_id)
                nodes.append(GraphNode(node_id=node_id, location=point))
        source_ids = [by_coord[(p.lat, p.lon)] for p in sources]
        target_ids = [by_coord[(p.lat, p.lon)] for p in destinations]
        edges: list[GraphEdge] = []
        seen_table: set[tuple[str, str, RoadProfile]] = set()
        for source_index, row in enumerate(durations):
            for target_index, value in enumerate(row):
                if value is None:
                    continue
                if type(value) not in (int, float) or value < 0:
                    raise RoadImportError("INVALID_COST", "OSRM duration must be non-negative")
                distance_value = 0 if distances is None or distances[source_index][target_index] is None else distances[source_index][target_index]
                if type(distance_value) not in (int, float) or distance_value < 0:
                    raise RoadImportError("INVALID_COST", "OSRM distance must be non-negative")
                key = (source_ids[source_index], target_ids[target_index], selected)
                if key in seen_table:
                    raise RoadImportError("DUPLICATE_DIRECTED_EDGE", f"duplicate {key[0]}->{key[1]} {selected}")
                seen_table.add(key)
                edges.append(
                    GraphEdge(
                        source=source_ids[source_index],
                        target=target_ids[target_index],
                        distance_m=max(0, round(distance_value)),
                        duration_sec={selected: max(0, round(value))},
                    )
                )
        return nodes, edges, {selected}
    routes = document.get("routes")
    if not isinstance(routes, list) or not routes:
        raise RoadImportError("INVALID_DOCUMENT", "native OSRM import needs routes or durations")
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
    seen_routes: set[tuple[str, str, RoadProfile]] = set()
    by_coord: dict[tuple[float, float], str] = {}

    def add_node(point: GeoPoint) -> str:
        key = (point.lat, point.lon)
        node_id = by_coord.get(key)
        if node_id is None:
            node_id = f"osrm-{len(by_coord):08d}"
            by_coord[key] = node_id
            nodes.append(GraphNode(node_id=node_id, location=point))
        return node_id

    for route in routes:
        if not isinstance(route, dict):
            raise RoadImportError("INVALID_OSRM", "route must be an object")
        geometry = _geometry(route.get("geometry"))
        if not geometry:
            raise RoadImportError("INVALID_GEOMETRY", "OSRM route must include full geometry")
        source_point, target_point = geometry[0], geometry[-1]
        source_id, target_id = add_node(source_point), add_node(target_point)
        distance = route.get("distance")
        duration = route.get("duration")
        if type(distance) not in (int, float) or type(duration) not in (int, float):
            raise RoadImportError("INVALID_COST", "OSRM route needs numeric distance and duration")
        route_key = (source_id, target_id, selected)
        if route_key in seen_routes:
            raise RoadImportError("DUPLICATE_DIRECTED_EDGE", f"duplicate {source_id}->{target_id} {selected}")
        seen_routes.add(route_key)
        edges.append(
            GraphEdge(
                source=source_id,
                target=target_id,
                distance_m=round(distance),
                duration_sec={selected: round(duration)},
                geometry=geometry,
            )
        )
    return nodes, edges, {selected}


def parse_import(document: dict[str, Any], profile: str | None = None) -> tuple[RoadGraph, tuple[RoadProfile, ...]]:
    """Parse one supported input into a validated ``RoadGraph``."""
    if document.get("format") == "navix-road-overlay/v1":
        nodes, edges, profiles = _parse_navix_overlay(document, profile)
        version = str(document.get("version", "navix-road-overlay/v1"))
        source = str(document.get("source", "Navix offline road overlay"))
    elif "nodes" in document or "edges" in document:
        nodes, edges, profiles = _parse_graph(document, profile)
        version = str(document.get("version", "road-import-input"))
        source = str(document.get("source", "OSRM road import"))
    else:
        nodes, edges, profiles = _parse_osrm(document, profile)
        version = "osrm-native"
        source = "OSRM native JSON"
    try:
        graph = RoadGraph(version=version, source=source, nodes=nodes, edges=edges)
    except (ValidationError, ValueError) as exc:
        raise RoadImportError("INVALID_GRAPH", str(exc)) from exc
    return graph, tuple(sorted(profiles))  # type: ignore[return-value]


def merge_graph(existing: RoadGraph | None, incoming: RoadGraph, profiles: tuple[RoadProfile, ...], input_sha256: str) -> RoadGraph:
    """Merge profiles and directed costs while rejecting ambiguous duplicates."""
    if existing is None:
        return incoming.model_copy(update={"version": f"osrm-import:{input_sha256}", "source": incoming.source})
    nodes = list(existing.nodes)
    by_id = {node.node_id: node for node in nodes}
    by_coord = {(node.location.lat, node.location.lon): node.node_id for node in nodes}
    aliases: dict[str, str] = {}
    for node in incoming.nodes:
        current = by_id.get(node.node_id)
        if current is not None:
            if current.location != node.location:
                raise RoadImportError("NODE_COORDINATE_CONFLICT", f"node {node.node_id} changed coordinates")
            aliases[node.node_id] = node.node_id
            continue
        same = by_coord.get((node.location.lat, node.location.lon))
        if same is not None:
            aliases[node.node_id] = same
            continue
        by_id[node.node_id] = node
        by_coord[(node.location.lat, node.location.lon)] = node.node_id
        nodes.append(node)
        aliases[node.node_id] = node.node_id
    edge_map: dict[tuple[str, str], GraphEdge] = {}
    for edge in existing.edges:
        key = (edge.source, edge.target)
        previous = edge_map.get(key)
        if previous is None:
            edge_map[key] = edge
            continue
        if previous.distance_m != edge.distance_m or (
            previous.geometry is not None
            and edge.geometry is not None
            and previous.geometry != edge.geometry
        ):
            raise RoadImportError("GRAPH_STORE_INVALID", f"conflicting existing edge {key[0]}->{key[1]}")
        overlap = set(previous.duration_sec).intersection(edge.duration_sec)
        if overlap:
            raise RoadImportError("GRAPH_STORE_INVALID", f"duplicate existing edge profile {key[0]}->{key[1]}")
        edge_map[key] = previous.model_copy(
            update={
                "duration_sec": {**previous.duration_sec, **edge.duration_sec},
                "geometry": previous.geometry or edge.geometry,
            }
        )
    for edge in incoming.edges:
        source, target = aliases.get(edge.source, edge.source), aliases.get(edge.target, edge.target)
        key = (source, target)
        previous = edge_map.get(key)
        if previous is None:
            edge_map[key] = edge.model_copy(update={"source": source, "target": target})
            continue
        costs = dict(previous.duration_sec)
        for name, duration in edge.duration_sec.items():
            if name in costs:
                raise RoadImportError("DUPLICATE_DIRECTED_EDGE", f"duplicate {source}->{target} {name}")
            costs[name] = duration
        geometry = previous.geometry or edge.geometry
        if previous.geometry is not None and edge.geometry is not None and previous.geometry != edge.geometry:
            raise RoadImportError("EDGE_GEOMETRY_CONFLICT", f"geometry differs for {source}->{target}")
        if previous.distance_m != edge.distance_m:
            raise RoadImportError("EDGE_DISTANCE_CONFLICT", f"distance differs for {source}->{target}")
        edge_map[key] = previous.model_copy(update={"duration_sec": costs, "geometry": geometry})
    merged = RoadGraph(
        version=f"osrm-import:{input_sha256}",
        source=f"{existing.source}; OSRM profiles={','.join(profiles)}",
        nodes=nodes,
        edges=list(edge_map.values()),
    )
    return merged


class ImportedRoadOverlay:
    """Prefer exact imported coordinate-to-coordinate paths and fall back to the base provider."""

    def __init__(self, base: TravelSource, graph: RoadGraph):
        self.base = base
        self.graph = GraphTravel(graph)
        self.version = content_hash(json.dumps({"base": base.version, "overlay": self.graph.version}, sort_keys=True, separators=(",", ":")).encode("utf-8"))

    def quote(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport
    ) -> TravelQuote | None:
        """Use an imported route only when both endpoints are exact overlay coordinates."""
        if self.graph._node(origin) is not None and self.graph._node(destination) is not None:
            imported = self.graph.quote(origin, destination, profile)
            if imported is not None:
                return imported
        return self.base.quote(origin, destination, profile)

    def quote_at(
        self, origin: GeoPoint, destination: GeoPoint, profile: Transport, departure_at: int
    ) -> TravelQuote | None:
        """Keep departure-aware fallback behavior while imported costs stay offline-static."""
        if self.graph._node(origin) is not None and self.graph._node(destination) is not None:
            imported = self.graph.quote(origin, destination, profile)
            if imported is not None:
                return imported
        return quote_at(self.base, origin, destination, profile, departure_at)


class RoadGraphStore:
    """Persist imported overlay and idempotency receipts in one atomic document."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()

    def load(self) -> RoadGraph | None:
        """Read a validated graph or return ``None`` when the store is absent."""
        return self._document()[0]

    def _document(self) -> tuple[RoadGraph | None, dict[str, dict[str, Any]]]:
        """Read one complete transaction; legacy graph-only files remain readable."""
        if not self.path.exists():
            return None, {}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"), object_pairs_hook=_unique_json_pairs)
        except (OSError, json.JSONDecodeError, UnicodeError) as exc:
            raise RoadImportError("GRAPH_STORE_INVALID", "road import store is invalid") from exc
        if not isinstance(value, dict):
            raise RoadImportError("GRAPH_STORE_INVALID", "road import store must be an object")
        if value.get("format") != "road-import-store/v1":
            try:
                return RoadGraph.model_validate(value), {}
            except ValidationError as exc:
                raise RoadImportError("GRAPH_STORE_INVALID", "persisted road graph is invalid") from exc
        try:
            graph = RoadGraph.model_validate(value.get("graph"))
            operations = value.get("operations", {})
        except ValidationError as exc:
            raise RoadImportError("GRAPH_STORE_INVALID", "persisted road graph is invalid") from exc
        if not isinstance(operations, dict) or not all(isinstance(key, str) and isinstance(item, dict) for key, item in operations.items()):
            raise RoadImportError("GRAPH_STORE_INVALID", "road operation journal is invalid")
        return graph, operations

    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        """Replace a destination only after the complete bytes reach disk."""
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        try:
            # Windows requires a writable descriptor for FlushFileBuffers/fsync.
            with temporary.open("wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def import_bytes(
        self,
        operation_id: str,
        payload: bytes,
        profile: str | None = None,
        source: str | None = None,
    ) -> RoadImportResult:
        """Validate, merge and atomically persist one idempotent import."""
        if not isinstance(operation_id, str) or not 1 <= len(operation_id) <= 128:
            raise RoadImportError("INVALID_OPERATION_ID", "operation_id must be 1..128 characters")
        normalized_source: str | None = None
        if source is not None:
            if not isinstance(source, str) or not 1 <= len(source.strip()) <= 200:
                raise RoadImportError("INVALID_SOURCE", "source must be 1..200 characters")
            normalized_source = source.strip()
        decoded, document = decode_payload(payload)
        digest = hashlib.sha256(decoded).hexdigest()
        incoming, profiles = parse_import(document, profile)
        if normalized_source is not None:
            incoming = incoming.model_copy(update={"source": normalized_source})
        with self._lock:
            existing, journal = self._document()
            previous = journal.get(operation_id)
            if previous is not None:
                if previous.get("input_sha256") != digest or previous.get("source") != normalized_source:
                    raise RoadImportError("OPERATION_CONFLICT", "operation_id was used for another payload")
                return RoadImportResult(
                    operation_id=str(previous["operation_id"]),
                    status="replayed",
                    graph_version=str(previous["graph_version"]),
                    router_context_version=previous.get("router_context_version"),
                    input_sha256=str(previous["input_sha256"]),
                    profiles=tuple(previous.get("profiles", ())),
                    nodes=int(previous["nodes"]),
                    edges=int(previous["edges"]),
                )
            merged = merge_graph(existing, incoming, profiles, digest)
            context = RoadImportResult(
                operation_id=operation_id,
                status="accepted",
                graph_version=merged.version,
                router_context_version=None,
                input_sha256=digest,
                profiles=profiles,
                nodes=len(merged.nodes),
                edges=len(merged.edges),
            )
            journal_entry = context.as_dict()
            journal_entry["source"] = normalized_source
            journal[operation_id] = journal_entry
            document = {"format": "road-import-store/v1", "version": 1, "graph": merged.model_dump(mode="json"), "operations": journal}
            self._atomic_write(self.path, (json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
            return context


def import_into_runtime(
    runtime: Any,
    store: RoadGraphStore,
    operation_id: str,
    payload: bytes,
    profile: str | None = None,
    source: str | None = None,
) -> RoadImportResult:
    """Persist an import, activate its graph and expose the new context identity.

    ``RouterRuntime.update_graph`` owns the calculation invalidation and context
    hash.  Keeping this adapter outside Runtime avoids coupling the solver
    coordinator to filesystem concerns while still making one import atomic from
    the API caller's perspective.
    """
    result = store.import_bytes(operation_id, payload, profile, source)
    graph = store.load()
    if graph is None:
        raise RoadImportError("GRAPH_STORE_INVALID", "road graph disappeared after import")
    runtime.update_road_overlay(graph)
    context = getattr(runtime, "context_version", None)
    return RoadImportResult(
        operation_id=result.operation_id,
        status=result.status,
        graph_version=result.graph_version,
        router_context_version=context,
        input_sha256=result.input_sha256,
        profiles=result.profiles,
        nodes=result.nodes,
        edges=result.edges,
    )
