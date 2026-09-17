"""2GIS traffic and multimodal matrix preparation with durable offline cache."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal, Self

import httpx
from pydantic import Field, model_validator

from core.contracts import GeoPoint, Record, RouterTaskSnapshot, Transport
from core.geo import GraphEdge, GraphNode, RoadGraph, content_hash

_PROFILE_ORDER: tuple[Transport, ...] = ("car", "walk", "bike", "transit")
_API_TRANSPORT: dict[Transport, str] = {
    "car": "driving",
    "walk": "walking",
    "bike": "bicycle",
    "transit": "public_transport",
}
_UNREACHABLE = {"ROUTE_NOT_FOUND", "ROUTE_DOES_NOT_EXISTS"}
_CACHE_READ_ERRORS = (OSError, json.JSONDecodeError)
PublicTransportType = Literal[
    "pedestrian",
    "metro",
    "light_metro",
    "suburban_train",
    "aeroexpress",
    "tram",
    "bus",
    "trolleybus",
    "shuttle_bus",
    "monorail",
    "funicular_railway",
    "river_transport",
    "cable_car",
    "light_rail",
    "premetro",
    "mcc",
    "mcd",
]


class TwoGISConfig(Record):
    """Validated provider settings; the API key itself stays in the environment."""

    schema_version: Literal["1.0"] = "1.0"
    endpoint: Annotated[str, Field(min_length=1)] = "https://routing.api.2gis.com"
    dataset_version: Annotated[str, Field(min_length=1)]
    cache_dir: Annotated[str, Field(min_length=1)]
    api_key_env: Annotated[str, Field(pattern=r"^[A-Z_][A-Z0-9_]*$")] = "TWOGIS_API_KEY"
    offline: bool = True
    chunk_size: Annotated[int, Field(ge=1, le=25)] = 25
    traffic_mode: Literal["jam", "statistics"] = "jam"
    transit_types: list[PublicTransportType] = Field(
        default_factory=lambda: [
            "metro",
            "bus",
            "tram",
            "trolleybus",
            "shuttle_bus",
            "suburban_train",
            "mcc",
            "mcd",
        ]
    )
    enable_transit_schedule: bool = True

    @model_validator(mode="after")
    def check_values(self) -> Self:
        """Reject unsafe endpoints and duplicate public-transport modes."""
        if not self.endpoint.startswith("https://"):
            raise ValueError("2GIS endpoint must use HTTPS")
        if not self.transit_types or len(self.transit_types) != len(set(self.transit_types)):
            raise ValueError("2GIS transit types must be non-empty and unique")
        return self


class TwoGISMatrixProvider:
    """Prepare immutable Router graphs from cached or live 2GIS matrix chunks."""

    def __init__(self, config: TwoGISConfig):
        """Create a secret-free cache namespace from validated provider settings."""
        self.config = config
        identity = config.model_dump(exclude={"cache_dir", "offline", "api_key_env"})
        self.version = content_hash(
            json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
        self.cache = Path(config.cache_dir) / self.version

    def build_graph(
        self,
        snapshot: RouterTaskSnapshot,
        *,
        departure_at: int | None = None,
        profiles: tuple[Transport, ...] = _PROFILE_ORDER,
    ) -> RoadGraph:
        """Build a complete directed matrix graph for the snapshot's unique points.

        Args:
            snapshot: Strict Router input whose request and engineer starts define nodes.
            departure_at: Matrix time. Defaults to ``snapshot.planning_as_of``.
            profiles: Unique Router transport profiles to prepare.

        Returns:
            A versioned graph with profile-specific parallel edges and attribution.

        Raises:
            ValueError: For invalid profiles, cache misses or malformed provider data.
        """
        departure_at = snapshot.planning_as_of if departure_at is None else departure_at
        if type(departure_at) is not int or departure_at < 0:
            raise ValueError("2GIS departure_at must be a nonnegative integer timestamp")
        if not profiles or len(profiles) != len(set(profiles)):
            raise ValueError("2GIS profiles must be non-empty and unique")
        if any(profile not in _PROFILE_ORDER for profile in profiles):
            raise ValueError("unsupported 2GIS Router profile")
        profiles = tuple(profile for profile in _PROFILE_ORDER if profile in profiles)
        locations = sorted(
            {
                (point.lat, point.lon)
                for point in (
                    [engineer.start_location for engineer in snapshot.engineers]
                    + [request.location for request in snapshot.requests]
                )
            }
        )
        nodes = [
            GraphNode(
                node_id=f"twogis-{index:04d}",
                location=GeoPoint(lat=lat, lon=lon),
            )
            for index, (lat, lon) in enumerate(locations)
        ]
        edges = []
        for profile in profiles:
            costs = self._profile_matrix(nodes, profile, departure_at)
            for (source, target), quote in sorted(costs.items()):
                if quote is None:
                    continue
                distance, duration = quote
                edges.append(
                    GraphEdge(
                        source=nodes[source].node_id,
                        target=nodes[target].node_id,
                        distance_m=distance,
                        duration_sec={profile: duration},
                    )
                )
        profile_label = ",".join(profiles)
        traffic_basis = (
            "current-at-cache-fill"
            if self.config.traffic_mode == "jam"
            else f"statistics-at-{departure_at}"
        )
        source = (
            "2GIS Distance Matrix API; profile-specific distances and durations; "
            f"profiles={profile_label}; traffic_mode={self.config.traffic_mode}; "
            f"car_traffic={traffic_basis}; matrix_context_at={departure_at}; "
            f"dataset={self.config.dataset_version}."
        )
        resource_hash = content_hash(
            json.dumps(
                {
                    "provider_version": self.version,
                    "departure_at": departure_at,
                    "profiles": profiles,
                    "nodes": [node.model_dump(mode="json") for node in nodes],
                    "edges": [edge.model_dump(mode="json") for edge in edges],
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        return RoadGraph(
            version=f"2gis:{self.config.dataset_version}:{resource_hash}",
            source=source,
            nodes=nodes,
            edges=edges,
        )

    def _profile_matrix(
        self, nodes: list[GraphNode], profile: Transport, departure_at: int
    ) -> dict[tuple[int, int], tuple[int, int] | None]:
        result: dict[tuple[int, int], tuple[int, int] | None] = {}
        size = self.config.chunk_size
        for source_start in range(0, len(nodes), size):
            sources = list(range(source_start, min(len(nodes), source_start + size)))
            for target_start in range(0, len(nodes), size):
                targets = list(range(target_start, min(len(nodes), target_start + size)))
                result.update(self._chunk(nodes, sources, targets, profile, departure_at))
        return result

    def _chunk(
        self,
        nodes: list[GraphNode],
        sources: list[int],
        targets: list[int],
        profile: Transport,
        departure_at: int,
    ) -> dict[tuple[int, int], tuple[int, int] | None]:
        selected = list(dict.fromkeys(sources + targets))
        local_by_global = {global_index: local for local, global_index in enumerate(selected)}
        global_by_local = dict(enumerate(selected))
        body: dict[str, object] = {
            "points": [nodes[index].location.model_dump() for index in selected],
            "sources": [local_by_global[index] for index in sources],
            "targets": [local_by_global[index] for index in targets],
            "transport": _API_TRANSPORT[profile],
        }
        if profile == "car":
            body["type"] = self.config.traffic_mode
            if self.config.traffic_mode == "statistics":
                body["start_time"] = _rfc3339(departure_at)
        elif profile == "transit":
            body["start_time"] = _rfc3339(departure_at)
            body["public_transport_params"] = {
                "transport": self.config.transit_types,
                "enable_schedule": self.config.enable_transit_schedule,
            }
        identity = {
            "provider_version": self.version,
            "departure_at": departure_at,
            "profile": profile,
            "body": body,
        }
        cache_path = self.cache / (
            content_hash(
                json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
            )
            + ".json"
        )
        if cache_path.exists():
            try:
                data = json.loads(cache_path.read_text(encoding="utf-8"))
            except _CACHE_READ_ERRORS:
                raise ValueError("TWOGIS_CACHE_INVALID: expected valid JSON") from None
            if not isinstance(data, dict):
                raise ValueError("TWOGIS_CACHE_INVALID: expected object")
        elif self.config.offline:
            raise ValueError("TWOGIS_CACHE_MISS: prepare this matrix online first")
        else:
            data = self._request(body)
            self._decode_chunk(data, sources, targets, global_by_local)
            self.cache.mkdir(parents=True, exist_ok=True)
            temporary = cache_path.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            temporary.replace(cache_path)
        return self._decode_chunk(data, sources, targets, global_by_local)

    def _request(self, body: dict[str, object]) -> dict[str, object]:
        api_key = os.environ.get(self.config.api_key_env)
        if not api_key:
            raise ValueError(f"TWOGIS_API_KEY_MISSING: set {self.config.api_key_env}")
        url = f"{self.config.endpoint.rstrip('/')}/get_dist_matrix"
        try:
            response = httpx.post(
                url,
                params={"key": api_key, "version": "2.0"},
                json=body,
                timeout=15.0,
            )
        except httpx.RequestError:
            raise ValueError("TWOGIS_NETWORK_ERROR") from None
        if response.status_code != 200:
            raise ValueError(f"TWOGIS_HTTP_{response.status_code}")
        try:
            data = response.json()
        except ValueError:
            raise ValueError("TWOGIS_RESPONSE_INVALID: expected JSON") from None
        if not isinstance(data, dict):
            raise ValueError("TWOGIS_RESPONSE_INVALID: expected object")
        return data

    @staticmethod
    def _decode_chunk(
        data: dict[str, object],
        sources: list[int],
        targets: list[int],
        global_by_local: dict[int, int],
    ) -> dict[tuple[int, int], tuple[int, int] | None]:
        routes = data.get("routes")
        if not isinstance(routes, list):
            raise ValueError("TWOGIS_RESPONSE_INVALID: routes must be an array")
        expected = {
            (source, target) for source in sources for target in targets if source != target
        }
        decoded: dict[tuple[int, int], tuple[int, int] | None] = {}
        for route in routes:
            if not isinstance(route, dict):
                raise ValueError("TWOGIS_RESPONSE_INVALID: route must be an object")
            source_id, target_id = route.get("source_id"), route.get("target_id")
            if type(source_id) is not int or type(target_id) is not int:
                raise ValueError("TWOGIS_RESPONSE_INVALID: route IDs must be integers")
            if source_id not in global_by_local or target_id not in global_by_local:
                raise ValueError("TWOGIS_RESPONSE_INVALID: route ID is outside the request")
            pair = (global_by_local[source_id], global_by_local[target_id])
            if pair[0] == pair[1]:
                continue
            if pair not in expected or pair in decoded:
                raise ValueError("TWOGIS_RESPONSE_INVALID: unexpected or duplicate route")
            status = route.get("status")
            if status == "OK":
                distance, duration = route.get("distance"), route.get("duration")
                if (
                    type(distance) is not int
                    or type(duration) is not int
                    or distance < 0
                    or duration < 0
                    or (distance > 0 and duration == 0)
                ):
                    raise ValueError("TWOGIS_RESPONSE_INVALID: invalid integer costs")
                decoded[pair] = (distance, duration)
            elif status in _UNREACHABLE:
                decoded[pair] = None
            else:
                raise ValueError(f"TWOGIS_PROVIDER_ERROR: route status {status!r}")
        if set(decoded) != expected:
            raise ValueError("TWOGIS_RESPONSE_INVALID: incomplete matrix chunk")
        return decoded


def _rfc3339(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")
