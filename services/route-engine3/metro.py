"""Metro path service for route-engine3: stations, Dijkstra rides, constants.

Loads the versioned metro artifact produced by data/metro/build_moscow.py
(stations, ride/transfer edges, per-edge optional geometry, access/wait
constants). Pure stdlib, no boundary logic: the artifact is Moscow-only by
construction, boundary filtering stays the caller's concern.

Composite walk+metro+walk quotes are assembled by server.py on top of these
primitives so the pedestrian access legs stay honest (foot-graph routes,
not estimates).
"""

from __future__ import annotations

import heapq
import json
import math
import os
from itertools import pairwise
from pathlib import Path

DEFAULT_DATA_PATH = str(Path(__file__).resolve().parent / "data" / "metro.json")


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres between two (lat, lon) points."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(min(1.0, math.sqrt(h)))


def _edge_geometry(points) -> list[list[float]] | None:
    """Normalize one edge geometry payload to [[lat, lon], ...] or None."""
    if not isinstance(points, list) or len(points) < 2:
        return None
    try:
        return [[float(point[0]), float(point[1])] for point in points]
    except (TypeError, ValueError, IndexError):
        return None


class MetroService:
    """Read-only metro network with cached shortest-path trees per source."""

    def __init__(self, data: dict):
        version = str(data.get("version") or "")
        if not version:
            raise ValueError("metro artifact lacks a version")
        self.version = version
        self.enter_sec = int(data.get("enter_sec", 180))
        self.exit_sec = int(data.get("exit_sec", 120))
        self.wait_sec = int(data.get("wait_sec", 120))
        self.transfer_sec = int(data.get("transfer_sec", 240))
        self.max_access_m = int(data.get("max_access_m", 1500))
        self.stations = {
            row["station_id"]: {
                "station_id": row["station_id"],
                "name": row.get("name", ""),
                "line_id": row.get("line_id"),
                "lat": float(row["location"]["lat"]),
                "lon": float(row["location"]["lon"]),
            }
            for row in data.get("stations", [])
        }
        self.adjacency: dict[str, list[dict]] = {}
        for row in data.get("edges", []):
            source, target = row["source"], row["target"]
            if source not in self.stations or target not in self.stations:
                continue
            edge = {
                "duration_sec": int(row["duration_sec"]),
                "distance_m": int(row.get("distance_m") or 0),
                "kind": row.get("kind", "ride"),
                "geometry": _edge_geometry(row.get("geometry")),
            }
            # Rides and transfers are bidirectional on the network artifact.
            self.adjacency.setdefault(source, []).append({**edge, "target": target})
            self.adjacency.setdefault(target, []).append({**edge, "target": source})
        self._trees: dict[str, dict[str, tuple[int, list[str]]]] = {}

    @classmethod
    def from_env(cls) -> MetroService | None:
        """Load from METRO_DATA_PATH; None when unset or missing (no metro)."""
        path = os.environ.get("METRO_DATA_PATH", DEFAULT_DATA_PATH)
        try:
            payload = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        try:
            return cls(payload)
        except (KeyError, TypeError, ValueError):
            return None

    def nearest(
        self,
        point: tuple[float, float],
        top_k: int = 2,
        max_access_m: int | None = None,
    ) -> list[dict]:
        """Nearest stations to one point with flat-speed access estimates."""
        limit = self.max_access_m if max_access_m is None else int(max_access_m)
        access_speed_kmh = 4.5  # disclosed constant: crowded-street walking speed
        ranked = sorted(
            (haversine_m(point, (s["lat"], s["lon"])), station_id)
            for station_id, s in self.stations.items()
        )[: max(1, top_k) * 4]
        result = []
        for distance, station_id in ranked:
            if distance > limit:
                continue
            station = self.stations[station_id]
            result.append(
                {
                    "station_id": station_id,
                    "name": station["name"],
                    "line_id": station["line_id"],
                    "location": [station["lat"], station["lon"]],
                    "access_m": round(distance, 1),
                    "access_sec": math.ceil(
                        distance / (access_speed_kmh * 1000 / 3600)
                    ),
                }
            )
            if len(result) >= top_k:
                break
        return result

    def _tree(self, source: str) -> dict[str, tuple[int, list[str]]]:
        """Dijkstra from one station over ride+transfer edges, cached per source."""
        cached = self._trees.get(source)
        if cached is not None:
            return cached
        distances: dict[str, tuple[int, list[str]]] = {source: (0, [source])}
        queue: list[tuple[int, str, list[str]]] = [(0, source, [source])]
        while queue:
            cost, node, path = heapq.heappop(queue)
            if cost > distances.get(node, (math.inf, ()))[0]:
                continue
            for edge in self.adjacency.get(node, []):
                penalty = 0  # walk time on the transfer edge already covers the interchange
                candidate = cost + edge["duration_sec"] + penalty
                target = edge["target"]
                if candidate < distances.get(target, (math.inf, ()))[0]:
                    distances[target] = (candidate, [*path, target])
                    heapq.heappush(queue, (candidate, target, distances[target][1]))
        self._trees[source] = distances
        return distances

    def ride_path(self, source: str, target: str) -> dict | None:
        """Fastest ride between two stations with joined geometry.

        Prefer per-edge line geometry when the artifact carries it, else join
        the station coordinates. duration_sec includes transfer penalties but
        never enter/wait/exit — those are service constants, not path costs.
        """
        if (
            source == target
            or source not in self.stations
            or target not in self.stations
        ):
            return None
        tree = self._tree(source)
        if target not in tree:
            return None
        duration, path = tree[target]
        geometry: list[list[float]] = []
        distance = 0
        for current, nxt in pairwise(path):
            edge = next(
                (e for e in self.adjacency[current] if e["target"] == nxt), None
            )
            if edge is None:
                continue
            distance += edge["distance_m"]
            leg = edge["geometry"] or [
                [self.stations[current]["lat"], self.stations[current]["lon"]],
                [self.stations[nxt]["lat"], self.stations[nxt]["lon"]],
            ]
            geometry = geometry[:-1] + leg if geometry else [point[:] for point in leg]
        return {
            "from_station": source,
            "to_station": target,
            "duration_sec": duration,
            "distance_m": distance,
            "stations": [
                {
                    "station_id": station_id,
                    "name": self.stations[station_id]["name"],
                    "line_id": self.stations[station_id]["line_id"],
                }
                for station_id in path
            ],
            "geometry": geometry or None,
        }
