# SPDX-License-Identifier: Apache-2.0
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

import hashlib
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

    def __init__(self, data: dict, *, content_hash: str | None = None):
        version = str(data.get("version") or "")
        if not version:
            raise ValueError("metro artifact lacks a version")
        self.version = version
        self.content_hash = content_hash
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
            # The artifact is a directed graph.  A reverse edge may have a
            # different geometry and is present explicitly when it exists.
            self.adjacency.setdefault(source, []).append({**edge, "target": target})
        self._trees: dict[str, dict[str, tuple[int, list[str]]]] = {}

    @classmethod
    def from_env(cls) -> MetroService | None:
        """Load from METRO_DATA_PATH; None when unset or missing (no metro)."""
        path = os.environ.get("METRO_DATA_PATH", DEFAULT_DATA_PATH)
        try:
            file_path = Path(path)
            raw = file_path.read_bytes()
            payload = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        try:
            return cls(payload, content_hash=hashlib.sha256(raw).hexdigest())
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
                penalty = 60 if edge["kind"] == "transfer" else 0  # escalator overhead on transfers only
                candidate = cost + edge["duration_sec"] + penalty
                target = edge["target"]
                if candidate < distances.get(target, (math.inf, ()))[0]:
                    distances[target] = (candidate, [*path, target])
                    heapq.heappush(queue, (candidate, target, distances[target][1]))
        self._trees[source] = distances
        return distances

    def _geometry(self, edge: dict, source: str, target: str) -> list[list[float]]:
        """Return the directed artifact geometry without changing its points."""
        chord = [
            [self.stations[source]["lat"], self.stations[source]["lon"]],
            [self.stations[target]["lat"], self.stations[target]["lon"]],
        ]
        line = edge["geometry"]
        if not line:
            return chord
        return [point[:] for point in line]

    def _timed_tree(self, source: str, departure_at: float) -> dict:
        """Run time-dependent Dijkstra with boarding waits at ride starts."""
        from metro_timetable import next_departure

        start = int(departure_at)
        # The boolean tracks whether the next ride requires boarding.  A ride
        # continues through same-line stations without another timetable wait;
        # transfers set it back to true.
        distances: dict[tuple[str, bool], tuple[int, list[str]]] = {
            (source, True): (start, [source])
        }
        queue: list[tuple[int, str, bool, list[str]]] = [
            (start, source, True, [source])
        ]
        while queue:
            arrival, node, needs_boarding, path = heapq.heappop(queue)
            state = (node, needs_boarding)
            if arrival != distances.get(state, (math.inf, ()))[0]:
                continue
            for edge in self.adjacency.get(node, []):
                edge_ready = arrival
                next_boarding = edge["kind"] == "transfer"
                if edge["kind"] == "ride" and needs_boarding:
                    departure = next_departure(arrival)
                    if departure is None:
                        continue
                    edge_ready = departure
                penalty = 60 if edge["kind"] == "transfer" else 0
                candidate = edge_ready + edge["duration_sec"] + penalty
                target = edge["target"]
                next_state = (target, next_boarding)
                if candidate < distances.get(next_state, (math.inf, ()))[0]:
                    distances[next_state] = (candidate, [*path, target])
                    heapq.heappush(
                        queue,
                        (candidate, target, next_boarding, distances[next_state][1]),
                    )
        return distances

    def ride_path(
        self, source: str, target: str, departure_at: float | None = None
    ) -> dict | None:
        """Fastest ride between two stations with joined geometry.

        Prefer per-edge line geometry when the artifact carries it, else join
        the station coordinates. With ``departure_at`` the duration includes
        timetable waits at initial boarding and after transfers; static calls
        retain the old ride-plus-transfer duration contract.
        """
        if (
            source == target
            or source not in self.stations
            or target not in self.stations
        ):
            return None
        if departure_at is None:
            tree = self._tree(source)
            result = tree.get(target)
        else:
            timed = self._timed_tree(source, departure_at)
            result = min(
                (value for (station, _boarding), value in timed.items() if station == target),
                default=None,
                key=lambda value: value[0],
            )
        if result is None:
            return None
        duration, path = result
        geometry: list[list[float]] = []
        distance = 0
        for current, nxt in pairwise(path):
            edge = next(
                (e for e in self.adjacency[current] if e["target"] == nxt), None
            )
            if edge is None:
                continue
            distance += edge["distance_m"]
            leg = self._geometry(edge, current, nxt)
            if not geometry:
                geometry = [point[:] for point in leg]
                continue
            # Drop the join only when the legs really share it: an edge whose line
            # stops short of the platform must stay connected, not be cut open.
            tail = leg[1:] if leg[0] == geometry[-1] else leg
            geometry += [point[:] for point in tail]
        return {
            "from_station": source,
            "to_station": target,
            "duration_sec": duration if departure_at is None else duration - int(departure_at),
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
