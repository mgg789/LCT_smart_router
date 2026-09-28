"""route-engine3: universal multi-graph OSRM routing service.

One container serves every OSRM graph dropped into the graphs root. Each
subdirectory with a ``*.osrm`` base file becomes a supervised osrm-routed
child (see graphs.py); profiles decide which graph answers a query:
``car`` queries go to the graph with profile ``car``, ``walk``/``bike``/
``transit`` queries to the graph with profile ``foot``.

Contracts (all GET, all parameters optional unless stated):

- ``/health``   → ``{"service", "ready", "graphs": {id: bool}}``
- ``/graphs``   → discovered graphs and their runtime status
- ``/route3``   → ``a``, ``b`` (``lat,lon``), ``profile=car|walk|bike|transit``,
                  ``metro=0|1`` (default: 1 for walk/transit), ``traffic=0|1``
                  (car only), ``departure=<epoch>``
- ``/matrix3``  → ``points`` (``lat,lon;...``), ``profile``, ``traffic``,
                  ``planning=1`` (car forecast bands), ``departure``
- ``/metro3``   → ``points`` (``lat,lon;...``), ``max_access_m``, ``top_k``
- ``/model``    → service identity and graph metadata

Cost policy: walk and bike durations are always flat — foot-graph road
distance divided by the graph's declared average speed; no traffic engine
ever touches them. Car durations are OSRM base durations, factored by the
v2 radial+magistral-rush model when ``traffic=1``.
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import traffic
from graphs import GraphSupervisor, discover_graphs
from metro import MetroService

SERVICE_VERSION = "route-engine3-v1"

ENGINE3_PORT = int(os.environ.get("ENGINE3_PORT", "8124"))
GRAPHS_DIR = Path(
    os.environ.get(
        "ENGINE3_GRAPHS_DIR", str(Path(__file__).resolve().parent / "graphs")
    )
)
PAGE_DIR = os.environ.get("ENGINE3_PAGE_DIR") or None
OSRM_ROUTED = os.environ.get("ENGINE3_OSRM_ROUTED", "osrm-routed")
OSRM_BASE_PORT = int(os.environ.get("ENGINE3_OSRM_BASE_PORT", "5300"))

MODELS: dict[str, str] = {
    "car": "osrm-mld+" + traffic.MODEL_VERSION,
    "foot": "osrm-mld+flat-speed",
}

PROFILES = ("car", "walk", "bike", "transit")

# Proxy-bypassing opener: OSRM children are loopback-only, proxies would break them.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def build_supervisor() -> GraphSupervisor:
    """Discover graphs from the environment and return a live supervisor."""
    return GraphSupervisor(
        discover_graphs(GRAPHS_DIR),
        base_port=OSRM_BASE_PORT,
        page_dir=PAGE_DIR,
        osrm_routed=OSRM_ROUTED,
    )


REGISTRY: GraphSupervisor | None = None
METRO: MetroService | None = None


# --- small parsing helpers -------------------------------------------------


def parse_point(value: str) -> tuple[float, float]:
    """Parse one ``lat,lon`` query parameter into a (lat, lon) tuple."""
    lat, lon = (float(piece) for piece in value.split(","))
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError(f"point out of range: {value}")
    return lat, lon


def parse_points(value: str) -> list[tuple[float, float]]:
    """Parse a semicolon-separated ``lat,lon`` list; at least two points."""
    points = [parse_point(piece) for piece in value.split(";") if piece]
    if len(points) < 2:
        raise ValueError("at least two points are required")
    return points


def _flag(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.lower() in ("1", "true", "yes", "on")


def _profile_of(params: dict[str, str]) -> str:
    profile = params.get("profile", "car")
    if profile not in PROFILES:
        raise ValueError(f"unsupported profile: {profile}")
    return profile


def _require_graph(profile: str):
    runtime = REGISTRY.graph_for(profile)
    if runtime is None:
        raise RuntimeError(f"NO_GRAPH_FOR_PROFILE:{profile}")
    return runtime


# --- OSRM access ------------------------------------------------------------


def _osrm_get(url: str, timeout: float = 60.0) -> dict:
    """GET one OSRM JSON payload; RuntimeError carries the OSRM status code."""
    with _OPENER.open(url, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("code") != "Ok":
        raise RuntimeError(payload.get("code", "OSRM_ERROR"))
    return payload


def _route_url(
    runtime, path: str, a: tuple[float, float], b: tuple[float, float], steps: bool
) -> str:
    """Build one OSRM /route URL against the graph's loopback port."""
    return (
        f"http://127.0.0.1:{runtime.port}/route/v1/{path}/"
        f"{a[1]},{a[0]};{b[1]},{b[0]}"
        f"?overview=full&geometries=geojson&steps={'true' if steps else 'false'}"
    )


def _route_over_graph(runtime, a, b, *, steps: bool) -> dict:
    path = "driving" if runtime.spec.profile == "car" else "walking"
    payload = _osrm_get(_route_url(runtime, path, a, b, steps))
    route = payload["routes"][0]
    geometry = [[point[1], point[0]] for point in route["geometry"]["coordinates"]]
    return {
        "duration": route["duration"],
        "distance": route["distance"],
        "geometry": geometry,
    }


def _table_over_graph(runtime, points, *, annotations: str = "duration,distance"):
    """One batched OSRM /table call for a whole point set.

    Table size must stay under the graph's --max-table-size; the caller is
    responsible for chunking (the vendored MKAD graphs run 4096).
    """
    coords = ";".join(f"{lon},{lat}" for lat, lon in points)
    url = (
        f"http://127.0.0.1:{runtime.port}/table/v1/"
        + ("driving" if runtime.spec.profile == "car" else "walking")
        + f"/{coords}?annotations={annotations}"
    )
    payload = _osrm_get(url, timeout=120.0)
    durations = payload.get("durations")
    distances = payload.get("distances")
    if not isinstance(durations, list) or len(durations) != len(points):
        raise ValueError("osrm table returned a mismatched durations grid")
    if distances is not None and len(distances) != len(points):
        raise ValueError("osrm table returned a mismatched distances grid")
    return durations, distances


def _flat_speed(runtime, profile: str) -> float:
    """Declared flat speed (m/s) for a foot-graph profile."""
    key = "bike" if profile == "bike" else "walk"
    return runtime.spec.speeds_kmh[key] * 1000 / 3600


# --- straight connectors ----------------------------------------------------


def _straight_car(a, b, departure: float) -> dict:
    """Straight connector for car queries the graph cannot answer."""
    distance = traffic.haversine_m(a, b)
    speed = traffic.straight_speed_kmh(distance)
    base = distance / (speed * 1000 / 3600)
    factor, period = traffic.endpoint_factor(departure, a, b)
    return {
        "mode": "straight",
        "distance_m": round(distance, 1),
        "base_duration_s": round(base, 1),
        "duration_s": round(base * factor, 1),
        "effective_factor": factor,
        "period": period,
        "speed_kmh": speed,
        "geometry": [[a[0], a[1]], [b[0], b[1]]],
    }


def _straight_foot(runtime, a, b, profile: str) -> dict:
    """Straight connector for pedestrian queries beyond the foot graph."""
    distance = traffic.haversine_m(a, b)
    duration = math.ceil(distance / _flat_speed(runtime, profile))
    return {
        "mode": "straight",
        "distance_m": round(distance, 1),
        "duration_s": duration,
        "speed_kmh": runtime.spec.speeds_kmh["bike" if profile == "bike" else "walk"],
        "geometry": [[a[0], a[1]], [b[0], b[1]]],
    }


# --- /route3 ----------------------------------------------------------------


def _car_route(runtime, a, b, *, traffic_on: bool, departure: float) -> dict:
    try:
        route = _route_over_graph(runtime, a, b, steps=traffic_on)
    except (RuntimeError, OSError, ValueError):
        return {
            **_straight_car(a, b, departure),
            "profile": "car",
            "graph_id": runtime.spec.graph_id,
            "map_version": runtime.spec.map_version,
            "traffic_applied": False,
        }
    base_route = {
        "mode": "road",
        "profile": "car",
        "distance_m": round(route["distance"], 1),
        "base_duration_s": round(route["duration"], 1),
        "duration_s": round(route["duration"], 1),
        "traffic_applied": False,
        "geometry": route["geometry"],
        "graph_id": runtime.spec.graph_id,
        "map_version": runtime.spec.map_version,
    }
    if not traffic_on:
        return base_route
    try:
        steps = _route_steps(runtime, a, b)
        summary = traffic.summarize_route(steps, departure)
    except (RuntimeError, OSError, ValueError, KeyError, IndexError, TypeError):
        return base_route
    return {
        "mode": "road",
        "profile": "car",
        "distance_m": round(route["distance"], 1),
        **summary,
        "traffic_applied": True,
        "geometry": route["geometry"],
        "graph_id": runtime.spec.graph_id,
        "map_version": runtime.spec.map_version,
    }


def _route_steps(runtime, a, b) -> list[dict]:
    """Flatten OSRM steps with midpoints for the per-step traffic model."""
    path = "driving"
    payload = _osrm_get(_route_url(runtime, path, a, b, steps=True))
    route = payload["routes"][0]
    flat = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            coords = step.get("geometry", {}).get("coordinates") or []
            if not coords:
                continue
            first, last = coords[0], coords[-1]
            flat.append(
                {
                    "duration": step["duration"],
                    "distance": step["distance"],
                    "name": step.get("name", ""),
                    "ref": step.get("ref", ""),
                    "midpoint": ((first[1] + last[1]) / 2, (first[0] + last[0]) / 2),
                }
            )
    if not flat:
        raise RuntimeError("OSRM returned no steps")
    return flat


def _foot_route(runtime, a, b, profile: str, *, metro_on: bool) -> dict:
    metro_used_note = None
    try:
        direct = _route_over_graph(runtime, a, b, steps=False)
    except (RuntimeError, OSError, ValueError):
        return {
            **_straight_foot(runtime, a, b, profile),
            "profile": profile,
            "graph_id": runtime.spec.graph_id,
            "map_version": runtime.spec.map_version,
        }
    speed = _flat_speed(runtime, profile)
    direct_quote = {
        "mode": "road",
        "duration_s": math.ceil(direct["distance"] / speed),
        "distance_m": round(direct["distance"], 1),
        "geometry": direct["geometry"],
    }
    if metro_on and METRO is not None and profile in ("walk", "transit"):
        composite = _metro_composite(runtime, a, b, direct_quote, profile)
        if composite is not None:
            return composite
        metro_used_note = "direct walk won over metro composite"
    return {
        **direct_quote,
        "profile": profile,
        "graph_id": runtime.spec.graph_id,
        "map_version": runtime.spec.map_version,
        "metro": metro_used_note,
    }


def _metro_composite(runtime, a, b, direct_quote: dict, profile: str) -> dict | None:
    """Walk+metro+walk composite when it beats the direct foot-graph route.

    Access legs are honest foot-graph routes point→station (not estimates);
    the fastest candidate pair is picked by flat access estimates first, then
    verified with real routing so at most two extra OSRM calls are spent.
    """
    origins = METRO.nearest(a, top_k=2)
    destinations = METRO.nearest(b, top_k=2)
    if not origins or not destinations:
        return None
    speed = _flat_speed(runtime, profile)
    best = None
    for origin_station in origins:
        for destination_station in destinations:
            ride = METRO.ride_path(
                origin_station["station_id"], destination_station["station_id"]
            )
            if ride is None:
                continue
            estimate = (
                origin_station["access_sec"]
                + METRO.enter_sec
                + METRO.wait_sec
                + ride["duration_sec"]
                + METRO.exit_sec
                + destination_station["access_sec"]
            )
            if best is None or estimate < best[0]:
                best = (estimate, ride, origin_station, destination_station)
    if best is None:
        return None
    _estimate, ride, origin_station, destination_station = best
    access_origin = _access_leg(
        runtime,
        a,
        (origin_station["location"][0], origin_station["location"][1]),
        speed,
    )
    access_destination = _access_leg(
        runtime,
        (destination_station["location"][0], destination_station["location"][1]),
        b,
        speed,
    )
    if access_origin is None or access_destination is None:
        return None
    metro_fixed = METRO.enter_sec + METRO.wait_sec + METRO.exit_sec
    total = (
        access_origin["duration_s"]
        + metro_fixed
        + ride["duration_sec"]
        + access_destination["duration_s"]
    )
    if total >= direct_quote["duration_s"]:
        return None
    segments = _stitched(
        [
            {
                "kind": "walk",
                "travel_source": "foot_graph",
                "duration_s": access_origin["duration_s"],
                "distance_m": access_origin["distance_m"],
                "geometry": access_origin["geometry"],
                "to_station": origin_station["name"],
            },
            {
                "kind": "metro",
                "travel_source": "metro",
                "duration_s": metro_fixed + ride["duration_sec"],
                "distance_m": ride["distance_m"],
                "geometry": ride["geometry"],
                "from_station": origin_station["name"],
                "to_station": destination_station["name"],
                "stations": ride["stations"],
            },
            {
                "kind": "walk",
                "travel_source": "foot_graph",
                "duration_s": access_destination["duration_s"],
                "distance_m": access_destination["distance_m"],
                "geometry": access_destination["geometry"],
                "from_station": destination_station["name"],
            },
        ]
    )
    return {
        "mode": "metro_composite",
        "profile": profile,
        "duration_s": total,
        "distance_m": round(
            access_origin["distance_m"]
            + ride["distance_m"]
            + access_destination["distance_m"],
            1,
        ),
        "geometry": _joined([segment["geometry"] for segment in segments]),
        "segments": segments,
        "metro": {
            "entered": origin_station["station_id"],
            "exited": destination_station["station_id"],
            "ride_duration_sec": ride["duration_sec"],
            "enter_sec": METRO.enter_sec,
            "wait_sec": METRO.wait_sec,
            "exit_sec": METRO.exit_sec,
        },
        "graph_id": runtime.spec.graph_id,
        "map_version": runtime.spec.map_version,
    }


def _stitched(segments: list[dict]) -> list[dict]:
    """Make consecutive segments share an endpoint, as the result contract demands.

    Each component is drawn on its own graph, so a walk snapped to the pedestrian
    network does not end on the exact platform coordinate the ride geometry starts
    from. A leg whose segments do not join is rejected by the System Layer
    (`apps/api/src/routing/router-gateway/result.types.ts`), so the short connector
    between them is drawn rather than left as a gap. Costs are untouched.
    """
    previous_end: list[float] | None = None
    for segment in segments:
        geometry = [point[:] for point in (segment.get("geometry") or [])]
        if previous_end is not None and (not geometry or geometry[0] != previous_end):
            geometry.insert(0, previous_end[:])
        if geometry:
            previous_end = geometry[-1]
        segment["geometry"] = geometry
    return segments


def _joined(parts: list[list[list[float]]]) -> list[list[float]]:
    """Concatenate stitched component polylines without repeating the shared joins."""
    points: list[list[float]] = []
    for part in parts:
        for point in part or []:
            if not points or point != points[-1]:
                points.append(point[:])
    return points


def _access_leg(runtime, origin, destination, speed: float) -> dict | None:
    """One foot-graph route between two (lat, lon) points; None when unreachable."""
    try:
        route = _route_over_graph(runtime, origin, destination, steps=False)
    except (RuntimeError, OSError, ValueError):
        return None
    return {
        "duration_s": math.ceil(route["distance"] / speed),
        "distance_m": round(route["distance"], 1),
        "geometry": route["geometry"],
    }


def handle_route3(params: dict[str, str]) -> dict:
    """One pair, one profile: geometry plus flat-speed or traffic durations."""
    a = parse_point(params["a"])
    b = parse_point(params["b"])
    profile = _profile_of(params)
    traffic_on = _flag(params.get("traffic")) and profile == "car"
    metro_default = profile in ("walk", "transit")
    metro_on = _flag(params.get("metro"), metro_default) and profile in (
        "walk",
        "transit",
    )
    departure = float(params.get("departure") or time.time())
    runtime = _require_graph(profile)
    if profile == "car":
        return _car_route(runtime, a, b, traffic_on=traffic_on, departure=departure)
    return _foot_route(runtime, a, b, profile, metro_on=metro_on)


# --- /matrix3 ---------------------------------------------------------------


def _forecast_band_layout() -> tuple[list[int], list[float]]:
    """Band starts anchored at midnight plus one representative epoch each.

    The layout matches the main project's prepared matrices: index 0 is night
    (minute 0), then the model bands in minute order.
    """
    starts = [0] + sorted({band[0] for band in traffic.BANDS})
    representatives = []
    for start in starts:
        minute = start if start else 3 * 60  # night representative: 03:00
        representatives.append(float(minute * 60))
    return starts, representatives


def handle_matrix3(params: dict[str, str]) -> dict:
    """All-pairs matrix for one profile from one batched OSRM /table call."""
    points = parse_points(params["points"])
    profile = _profile_of(params)
    traffic_on = _flag(params.get("traffic")) and profile == "car"
    planning = _flag(params.get("planning"))
    departure = float(params.get("departure") or time.time())
    runtime = _require_graph(profile)

    if profile == "car":
        durations, distances = _table_over_graph(runtime, points)
        matrix = []
        for i, row in enumerate(durations):
            cells = []
            for j, duration in enumerate(row):
                if i == j:
                    cells.append(
                        {"mode": "self", "base_duration_s": 0, "distance_m": 0}
                    )
                elif duration is None or (distances is None or distances[i][j] is None):
                    cells.append({"mode": "unreachable"})
                else:
                    cell = {
                        "mode": "road",
                        "base_duration_s": round(float(duration), 1),
                        "distance_m": round(float(distances[i][j]), 1),
                    }
                    if traffic_on:
                        factor, period = traffic.endpoint_factor(
                            departure, points[i], points[j]
                        )
                        cell["duration_s"] = round(float(duration) * factor, 1)
                        cell["effective_factor"] = factor
                        cell["period"] = period
                    cells.append(cell)
            matrix.append(cells)
        response = {
            "profile": profile,
            "points": [[lat, lon] for lat, lon in points],
            "matrix": matrix,
            "traffic_applied": traffic_on,
            "graph_id": runtime.spec.graph_id,
            "map_version": runtime.spec.map_version,
        }
        if traffic_on and planning:
            starts, representatives = _forecast_band_layout()
            for i, row in enumerate(matrix):
                for j, cell in enumerate(row):
                    if cell["mode"] != "road":
                        continue
                    bands = []
                    for epoch in representatives:
                        factor, _period = traffic.endpoint_factor(
                            epoch, points[i], points[j]
                        )
                        bands.append(round(cell["base_duration_s"] * factor, 1))
                    cell["forecast_duration_s"] = bands
            response["forecast_band_starts"] = starts
            response["forecast_timezone"] = "Europe/Moscow"
            response["model_version"] = traffic.MODEL_VERSION
            response["departure_iso"] = traffic.local_minute_of_day(departure)[1]
        return response

    # Walk/bike: flat speeds over foot-graph distances; no traffic engines.
    speed = _flat_speed(runtime, profile)
    _durations, distances = _table_over_graph(runtime, points)
    matrix = []
    for i, row in enumerate(distances):
        cells = []
        for j, distance in enumerate(row):
            if i == j:
                cells.append({"mode": "self", "duration_s": 0, "distance_m": 0})
            elif distance is None:
                cells.append({"mode": "unreachable"})
            else:
                cells.append(
                    {
                        "mode": "road",
                        "duration_s": math.ceil(float(distance) / speed),
                        "distance_m": round(float(distance), 1),
                    }
                )
        matrix.append(cells)
    return {
        "profile": profile,
        "points": [[lat, lon] for lat, lon in points],
        "matrix": matrix,
        "speed_kmh": runtime.spec.speeds_kmh["bike" if profile == "bike" else "walk"],
        "traffic_applied": False,
        "graph_id": runtime.spec.graph_id,
        "map_version": runtime.spec.map_version,
    }


# --- /metro3 ----------------------------------------------------------------


def handle_metro3(params: dict[str, str]) -> dict:
    """Nearest metro stations per point and fast metro paths between them."""
    if METRO is None:
        raise RuntimeError("METRO_NOT_CONFIGURED")
    points = parse_points(params["points"])
    max_access = int(params["max_access_m"]) if params.get("max_access_m") else None
    top_k = int(params.get("top_k", "2"))
    stations_per_point = [
        METRO.nearest(point, top_k=top_k, max_access_m=max_access) for point in points
    ]
    paths = []
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            best = None
            for origin_station in stations_per_point[i]:
                for destination_station in stations_per_point[j]:
                    ride = METRO.ride_path(
                        origin_station["station_id"], destination_station["station_id"]
                    )
                    if ride is None:
                        continue
                    total = (
                        origin_station["access_sec"]
                        + METRO.enter_sec
                        + METRO.wait_sec
                        + ride["duration_sec"]
                        + METRO.exit_sec
                        + destination_station["access_sec"]
                    )
                    if best is None or total < best[0]:
                        best = (total, ride, origin_station, destination_station)
            if best is None:
                continue
            total, ride, origin_station, destination_station = best
            paths.append(
                {
                    "from_point": i,
                    "to_point": j,
                    "composite_duration_sec": total,
                    "enter_sec": METRO.enter_sec,
                    "wait_sec": METRO.wait_sec,
                    "exit_sec": METRO.exit_sec,
                    "access_sec": {
                        "from": origin_station["access_sec"],
                        "to": destination_station["access_sec"],
                    },
                    "from_station": origin_station["name"],
                    "to_station": destination_station["name"],
                    "ride": ride,
                }
            )
    return {
        "version": METRO.version,
        "points": [[lat, lon] for lat, lon in points],
        "stations": stations_per_point,
        "paths": paths,
        "constants": {
            "enter_sec": METRO.enter_sec,
            "wait_sec": METRO.wait_sec,
            "exit_sec": METRO.exit_sec,
            "transfer_sec": METRO.transfer_sec,
            "max_access_m": METRO.max_access_m,
        },
    }


# --- identity ---------------------------------------------------------------


def handle_health() -> dict:
    """Aggregate readiness: every discovered graph must answer."""
    graphs = {entry["graph_id"]: entry["healthy"] for entry in REGISTRY.snapshot()}
    return {
        "service": SERVICE_VERSION,
        "ready": bool(graphs) and all(graphs.values()),
        "graphs": graphs,
    }


def handle_graphs() -> dict:
    """Discovered graphs with runtime status."""
    return {"service": SERVICE_VERSION, "graphs": REGISTRY.snapshot()}


def handle_model() -> dict:
    """Service identity, per-profile cost models and graph metadata."""
    return {
        "service": SERVICE_VERSION,
        "models": MODELS,
        "walk_bike_policy": "flat average speed, no traffic engines",
        "metro": {
            "configured": METRO is not None,
            "version": METRO.version if METRO else None,
        },
        "graphs": REGISTRY.snapshot(),
    }


class Handler(BaseHTTPRequestHandler):
    """Thin HTTP shell: parse query, dispatch to a handler, emit JSON."""

    def _send(self, status: int, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, status: int, body: dict) -> None:
        self._send(
            status,
            json.dumps(body, ensure_ascii=False).encode("utf-8"),
            "application/json",
        )

    def _params(self) -> dict[str, str]:
        query = parse_qs(urlparse(self.path).query)
        return {key: values[0] for key, values in query.items() if values}

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/health":
                self._json(200, handle_health())
            elif path == "/graphs":
                self._json(200, handle_graphs())
            elif path == "/model":
                self._json(200, handle_model())
            elif path == "/route3":
                self._json(200, handle_route3(self._params()))
            elif path == "/matrix3":
                self._json(200, handle_matrix3(self._params()))
            elif path == "/metro3":
                self._json(200, handle_metro3(self._params()))
            else:
                self._json(404, {"error": "unknown endpoint", "path": path})
        except (ValueError, KeyError) as error:
            self._json(400, {"error": str(error)})
        except (OSError, RuntimeError) as error:
            self._json(502, {"error": str(error)})

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}", flush=True)


def main() -> None:
    global REGISTRY, METRO
    REGISTRY = build_supervisor()
    REGISTRY.start()
    METRO = MetroService.from_env()
    server = ThreadingHTTPServer(("0.0.0.0", ENGINE3_PORT), Handler)
    graphs = ", ".join(spec.graph_id for spec in discover_graphs(GRAPHS_DIR))
    print(
        f"route-engine3: http://0.0.0.0:{ENGINE3_PORT} "
        f"(graphs: {graphs or 'none'}, metro: {'yes' if METRO else 'no'})",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
