#!/usr/bin/env python3
"""Local MKAD routing demo server (Python stdlib only, no dependencies).

Serves the interactive map demo and proxies routing to the local OSRM:

  GET /                       — demo UI (demo/index.html)
  GET /mkad-exact.geojson     — MKAD ring polygon for display and classification
  GET /health                 — {"osrm": true|false} reachability probe
  GET /route?a=lat,lon&b=lat,lon
        Both points inside the MKAD ring → road route via osrm-routed
        (mode="road", OSRM distance/duration/geometry, snapped endpoints).
        Any point outside the ring → straight line between the points, even when
        the other point is inside (mode="straight", haversine distance, duration
        assumed at STRAIGHT_SPEED_KMH).

Environment: OSRM_URL (default http://127.0.0.1:5111), DEMO_PORT (default 8123),
HOST (default 127.0.0.1; set 0.0.0.0 to serve from a container).
Run the OSRM container first:  ./scripts/pipeline.sh serve
"""

import ipaddress
import json
import math
import os
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DEMO = Path(__file__).resolve().parent
sys.path.insert(0, str(DEMO))
import traffic  # noqa: E402  (demo-local model, stdlib only)

DEMO_PORT = int(os.environ.get("DEMO_PORT", "8123"))
HOST = os.environ.get("HOST", "127.0.0.1")
STRAIGHT_SPEED_KMH = 40.0  # v1 flat assumption; v2 uses traffic.straight_speed_kmh

# Base (traffic-free) duration/distance cache for /matrix2 cells. Keyed by the
# rounded coordinates pair; traffic factors are applied AFTER the cache, so a
# cached base stays valid for every departure time and model tweak.
CACHE_PATH = DEMO / "cache" / "base_durations.json"
_CACHE_LOCK = threading.Lock()
_base_cache: dict[str, dict] = {}
_cache_dirty = False


def _load_cache():
    global _base_cache
    try:
        _base_cache = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        _base_cache = {}


def _save_cache():
    global _cache_dirty
    if not _cache_dirty:
        return
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = CACHE_PATH.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(_base_cache, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(CACHE_PATH)
    _cache_dirty = False


def _pair_key(a, b):
    return f"{a[0]:.6f},{a[1]:.6f}~{b[0]:.6f},{b[1]:.6f}"


PROFILE_PV = 1  # bump when classify_step/factor semantics change
PROFILE_KEYS = ("ring", "magistral", "street")
PROFILE_BUDGET = 500  # max new corridor profiles computed per /matrix2 call


def corridor_profile(a, b):
    """Traffic-free per-class duration split of one road route (the slow path).

    Cached per ordered pair, it lets the matrix apply the per-step class
    factors (ring crawl etc.) with pure arithmetic at query time.
    """
    steps, route = osrm_route_steps(a, b)
    profile = dict.fromkeys(PROFILE_KEYS, 0.0)
    for step in steps:
        profile[traffic.classify_step(step.get("name"), step.get("ref"))] += step["duration"]
    return {
        "duration_s": round(route["duration"], 1),
        "distance_m": round(route["distance"], 1),
        "profile": {key: round(value, 1) for key, value in profile.items()},
        "pv": PROFILE_PV,
    }


def _factored_from_profile(base, minute_of_day, direction, avg_radius):
    """Per-step-equivalent duration for one cached corridor profile."""
    radial = traffic.radial_factor(minute_of_day, direction)
    radial += traffic.radius_bonus_m(avg_radius)
    rush = traffic.in_rush(minute_of_day)
    total = 0.0
    for cls in PROFILE_KEYS:
        share = base["profile"].get(cls, 0.0)
        if not share:
            continue
        factor = radial * (traffic.RUSH_FACTORS[cls] if rush else 1.0)
        total += share * factor
    return total


EARTH_RADIUS_M = 6_371_000.0


def _validate_osrm_base(url):
    """Accept only http(s) OSRM bases on loopback/private addresses (no SSRF)."""
    parts = urllib.parse.urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SystemExit(f"OSRM_URL must be http(s)://host:port — got {url!r}")
    for info in socket.getaddrinfo(parts.hostname, port, proto=socket.IPPROTO_TCP):
        addr = ipaddress.ip_address(info[4][0])
        if not (addr.is_loopback or addr.is_private):
            raise SystemExit(
                f"OSRM_URL must point at loopback/private network — "
                f"{parts.hostname} resolves to {addr}"
            )
    return url.rstrip("/")


OSRM_URL = _validate_osrm_base(os.environ.get("OSRM_URL", "http://127.0.0.1:5111"))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("OSRM must not redirect")


# OSRM is explicitly restricted to local/private addresses above. Windows can
# otherwise send even loopback requests through its system proxy.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def haversine_m(a, b):
    """Great-circle distance in metres between two (lat, lon) points."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def load_ring():
    """[(lat, lon)] of the MKAD ring from data/mkad-exact.geojson."""
    fc = json.loads((DATA / "mkad-exact.geojson").read_text(encoding="utf-8"))
    coords = fc["features"][0]["geometry"]["coordinates"][0]
    return [(lat, lon) for lon, lat in coords]


RING = load_ring()


def inside_mkad(lat, lon):
    """Ray-casting point-in-polygon against the MKAD ring."""
    inside = False
    j = len(RING) - 1
    for i in range(len(RING)):
        lat_i, lon_i = RING[i]
        lat_j, lon_j = RING[j]
        if (lon_i > lon) != (lon_j > lon):
            cross_lat = (lat_j - lat_i) * (lon - lon_i) / (lon_j - lon_i) + lat_i
            if lat < cross_lat:
                inside = not inside
        j = i
    return inside


def osrm_route(a, b):
    """Road route between (lat, lon) points; raises on OSRM failure/NoRoute."""
    url = (
        f"{OSRM_URL}/route/v1/driving/"
        f"{a[1]},{a[0]};{b[1]},{b[0]}"
        "?overview=full&geometries=geojson&steps=false"
    )
    with _OPENER.open(url, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise RuntimeError(payload.get("code", "OSRM_ERROR"))
    route = payload["routes"][0]
    waypoints = payload.get("waypoints", [])
    snapped = [
        {"lat": w["location"][1], "lon": w["location"][0]} for w in waypoints[:2]
    ]
    return {
        "mode": "road",
        "distance_m": round(route["distance"], 1),
        "duration_s": round(route["duration"], 1),
        "geometry": [[lat, lon] for lon, lat in route["geometry"]["coordinates"]],
        "snapped": snapped,
    }


def osrm_route_steps(a, b):
    """Road route with per-step legs for the v2 traffic model.

    Returns (flat_steps, route) where each step carries duration/distance/
    name/ref and a (lat, lon) midpoint from its own geometry.
    """
    url = (
        f"{OSRM_URL}/route/v1/driving/"
        f"{a[1]},{a[0]};{b[1]},{b[0]}"
        "?overview=full&geometries=geojson&steps=true"
    )
    with _OPENER.open(url, timeout=90) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise RuntimeError(payload.get("code", "OSRM_ERROR"))
    route = payload["routes"][0]
    flat = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            coords = step["geometry"]["coordinates"]
            if not coords:
                continue
            first, last = coords[0], coords[-1]
            flat.append({
                "duration": step["duration"],
                "distance": step["distance"],
                "name": step.get("name", ""),
                "ref": step.get("ref", ""),
                "midpoint": ((first[1] + last[1]) / 2, (first[0] + last[0]) / 2),
            })
    return flat, route


def straight_line(a, b):
    """Fallback connector: straight segment, duration at the assumed speed."""
    distance = haversine_m(a, b)
    return {
        "mode": "straight",
        "distance_m": round(distance, 1),
        "duration_s": round(distance / (STRAIGHT_SPEED_KMH / 3.6), 1),
        "geometry": [[a[0], a[1]], [b[0], b[1]]],
        "snapped": None,
    }


def straight_line_v2(a, b, departure_epoch):
    """Straight connector with the length-aware speed curve and v1 time factor."""
    distance = haversine_m(a, b)
    kmh = traffic.straight_speed_kmh(distance)
    factor, period = traffic.endpoint_factor(departure_epoch, a, b)
    base_s = distance / (kmh / 3.6)
    return {
        "mode": "straight",
        "distance_m": round(distance, 1),
        "speed_kmh": kmh,
        "base_duration_s": round(base_s, 1),
        "duration_s": round(base_s * factor, 1),
        "effective_factor": factor,
        "period": period,
        "model_version": traffic.MODEL_VERSION,
        "geometry": [[a[0], a[1]], [b[0], b[1]]],
        "snapped": None,
    }


def road_route_v2(a, b, departure_epoch):
    """Road route factored per step by the v2 traffic model."""
    steps, route = osrm_route_steps(a, b)
    summary = traffic.summarize_route(steps, departure_epoch)
    waypoints = route.get("waypoints", [])
    summary.update({
        "mode": "road",
        "distance_m": round(route["distance"], 1),
        "geometry": [[lat, lon] for lon, lat in route["geometry"]["coordinates"]],
        "snapped": [
            {"lat": w["location"][1], "lon": w["location"][0]} for w in waypoints[:2]
        ],
    })
    return summary


def osrm_table(points):
    """One /table call for a whole region's points (the batch fast path).

    Returns (durations, distances) as N×N lists in input order. Raises on
    OSRM failure. Table size must stay under osrm-routed --max-table-size.
    """
    coords = ";".join(f"{lon},{lat}" for lat, lon in points)
    url = f"{OSRM_URL}/table/v1/driving/{coords}?annotations=duration,distance"
    with _OPENER.open(url, timeout=90) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("code") != "Ok":
        raise RuntimeError(payload.get("code", "OSRM_ERROR"))
    # OSRM names the matrix "table" for a single annotation, "durations" when
    # duration and distance are both requested.
    table = payload.get("durations") or payload.get("table")
    distances = payload.get("distances") or [[None] * len(table) for _ in table]
    return table, distances


def build_matrix(raw_points, departure_epoch, bbox=None, refine=False):
    """Region-scale batch matrix: one /table call + cached bases + fast factors.

    raw_points: [(lat, lon)]; bbox: (minlon, minlat, maxlon, maxlat) or None —
    points outside the scope box are cut (cells marked out_of_scope, no OSRM
    cost). Inside-MKAD bases come from one /table call cached by exact
    endpoints. With refine=True, up to PROFILE_BUDGET pairs per call are
    upgraded to a cached corridor profile (per-class base split), which makes
    the matrix match the per-step model of /route2; cells with a profile use
    class factors, the rest fall back to the fast endpoint factor.
    """
    started = time.perf_counter()
    points = [parse_point(f"{lat},{lon}") for lat, lon in raw_points]

    def in_scope(p):
        return bbox is None or (bbox[0] <= p[1] <= bbox[2] and bbox[1] <= p[0] <= bbox[3])

    scope = [in_scope(p) for p in points]
    inside = [inside_mkad(*p) for p in points]
    n = len(points)

    # --- batch fill of the base cache with a single /table call ------------
    table_ms = 0.0
    cache_hits = 0
    fresh = 0
    inside_idx = [i for i in range(n) if scope[i] and inside[i]]
    if len(inside_idx) >= 2:
        need_table = any(
            _pair_key(points[i], points[j]) not in _base_cache
            for i in inside_idx
            for j in inside_idx
            if i != j
        )
        if need_table:
            t0 = time.perf_counter()
            durations, distances = osrm_table([points[i] for i in inside_idx])
            table_ms = (time.perf_counter() - t0) * 1000
            for a_pos, i in enumerate(inside_idx):
                for b_pos, j in enumerate(inside_idx):
                    if a_pos == b_pos:
                        continue
                    key = _pair_key(points[i], points[j])
                    if key not in _base_cache:
                        _base_cache[key] = {
                            "duration_s": durations[a_pos][b_pos],
                            "distance_m": distances[a_pos][b_pos],
                        }
                        fresh += 1
    with _CACHE_LOCK:
        global _cache_dirty
        if fresh:
            _cache_dirty = True
        _save_cache()

    # --- optional refine: cached corridor profiles (slow first time only) ---
    profiles_fresh = 0
    if refine and len(inside_idx) >= 2:
        with _CACHE_LOCK:
            for i in inside_idx:
                for j in inside_idx:
                    if i == j or profiles_fresh >= PROFILE_BUDGET:
                        continue
                    key = _pair_key(points[i], points[j])
                    base = _base_cache.get(key)
                    if base is None or base.get("pv") == PROFILE_PV:
                        continue
                    base.update(corridor_profile(points[i], points[j]))
                    profiles_fresh += 1
                    _cache_dirty = True
            _save_cache()

    minute_of_day, iso = traffic.local_minute_of_day(departure_epoch)
    period = traffic.period_of(minute_of_day)

    # --- assemble cells ----------------------------------------------------
    matrix = []
    factor_ms0 = time.perf_counter()
    center = traffic.MOSCOW_CENTER
    for i in range(n):
        row = []
        for j in range(n):
            if i == j:
                row.append({"mode": "self", "duration_s": 0.0, "distance_m": 0.0})
                continue
            if not (scope[i] and scope[j]):
                row.append({"mode": "out_of_scope"})
                continue
            a, b = points[i], points[j]
            if not (inside[i] and inside[j]):
                factor, _ = traffic.endpoint_factor(departure_epoch, a, b)
                distance = traffic.haversine_m(a, b)
                kmh = traffic.straight_speed_kmh(distance)
                base_s = distance / (kmh / 3.6)
                row.append({
                    "mode": "straight",
                    "base_duration_s": round(base_s, 1),
                    "duration_s": round(base_s * factor, 1),
                    "factor": factor,
                    "speed_kmh": kmh,
                })
                continue
            key = _pair_key(a, b)
            base = _base_cache.get(key)
            if base is None or base["duration_s"] is None:
                # OSRM could not connect these snaps — keep it explicit.
                row.append({"mode": "unreachable"})
                continue
            cache_hits += 1
            if base.get("pv") == PROFILE_PV and base.get("profile"):
                # per-step-equivalent: class factors over the cached corridor
                radius_a = traffic.haversine_m(a, center)
                radius_b = traffic.haversine_m(b, center)
                direction = traffic.step_direction(radius_a, radius_b)
                duration = _factored_from_profile(base, minute_of_day, direction,
                                                  (radius_a + radius_b) / 2)
                row.append({
                    "mode": "road",
                    "refined": True,
                    "base_duration_s": base["duration_s"],
                    "duration_s": round(duration, 1),
                    "factor": round(duration / base["duration_s"], 2),
                    "distance_m": round(base["distance_m"] or 0.0, 1),
                })
            else:
                factor, _ = traffic.endpoint_factor(departure_epoch, a, b)
                row.append({
                    "mode": "road",
                    "refined": False,
                    "base_duration_s": round(base["duration_s"], 1),
                    "duration_s": round(base["duration_s"] * factor, 1),
                    "factor": factor,
                    "distance_m": round(base["distance_m"] or 0.0, 1),
                })
        matrix.append(row)

    return {
        "departure_iso": iso,
        "period": period,
        "factor_method": ("corridor profiles (per-step equivalent) where cached, "
                          "endpoint factor elsewhere"),
        "points": [
            {"lat": p[0], "lon": p[1], "inside_mkad": inside[i], "in_scope": scope[i]}
            for i, p in enumerate(points)
        ],
        "matrix": matrix,
        "stats": {
            "points": n,
            "pairs": n * n - n,
            "osrm_table_ms": round(table_ms, 1),
            "factor_ms": round((time.perf_counter() - factor_ms0) * 1000, 1),
            "total_ms": round((time.perf_counter() - started) * 1000, 1),
            "cache_hits": cache_hits,
            "cache_fresh": fresh,
            "profiles_fresh": profiles_fresh,
            "cache_size": len(_base_cache),
        },
    }


def build_planning_matrix(raw_points, departure_epoch):
    """Batch road costs for every forecast regime, without pairwise route calls.

    The solver chooses a column by its actual departure minute. Geometry is fetched
    only for selected legs; cold preparation performs one OSRM table request.
    """
    if len(raw_points) > 1000:
        raise ValueError("planning matrix is limited to 1000 points")
    transitions = sorted({0, *(
        minute for start, end, *_ in traffic.BANDS for minute in (start, end)
    ), *(
        minute for start, end in traffic.RUSH_WINDOWS for minute in (start, end)
    )})
    midnight = datetime.fromtimestamp(departure_epoch, traffic.MSK).replace(
        hour=0, minute=0, second=0, microsecond=0
    ).timestamp()
    result = build_matrix(raw_points, midnight)
    # Freeze the base cells once. Another handler may refine the shared cache,
    # but it cannot mix different corridor revisions inside this response.
    with _CACHE_LOCK:
        bases = {key: dict(value) for key, value in _base_cache.items()}
    for i, row in enumerate(result["matrix"]):
        for j, cell in enumerate(row):
            if cell["mode"] == "self":
                cell["forecast_duration_s"] = [0.0] * len(transitions)
            elif cell["mode"] == "road":
                a, b = raw_points[i], raw_points[j]
                base = bases[_pair_key(a, b)]
                ra = traffic.haversine_m(a, traffic.MOSCOW_CENTER)
                rb = traffic.haversine_m(b, traffic.MOSCOW_CENTER)
                direction = traffic.step_direction(ra, rb)
                refined = base.get("pv") == PROFILE_PV and base.get("profile")
                cell["base_duration_s"] = base["duration_s"]
                cell["distance_m"] = base["distance_m"]
                cell["forecast_duration_s"] = [round(
                    _factored_from_profile(base, minute, direction, (ra + rb) / 2)
                    if refined else base["duration_s"] * traffic.endpoint_factor(midnight + minute * 60, a, b)[0],
                    1,
                ) for minute in transitions]
    result["model_version"] = traffic.MODEL_VERSION
    result["forecast_band_starts"] = transitions
    result["forecast_timezone"] = "Europe/Moscow"
    return result


MODEL_INFO = {
    "model_version": traffic.MODEL_VERSION,
    "base": "moscow-radial-v1 (core/traffic_engine.py, LCT_smart_router)",
    "timezone": "Europe/Moscow",
    "bands": [
        {"period": name, "from": f"{s // 60:02d}:{s % 60:02d}",
         "to": f"{e // 60:02d}:{e % 60:02d}", "factors": f}
        for s, e, name, f in traffic.BANDS
    ] + [{"period": "night", "from": "22:00", "to": "06:00", "factors": traffic.NIGHT_FACTOR}],
    "center_bonus": [
        {"radius_below_m": limit, "add": bonus} for limit, bonus in traffic.CENTER_BONUS
    ],
    "rush_windows": [
        {"from": f"{s // 60:02d}", "to": f"{s // 60:02d}"}
        for s, e in traffic.RUSH_WINDOWS
    ],
    "rush_factors": traffic.RUSH_FACTORS,
    "straight_curve": [
        {"up_to_m": (None if math.isinf(limit) else limit), "kmh": kmh}
        for limit, kmh in traffic.STRAIGHT_CURVE
    ],
}


def parse_point(raw):
    """'lat,lon' → (lat, lon); raises ValueError on malformed input."""
    lat_s, lon_s = raw.split(",")
    lat, lon = float(lat_s), float(lon_s)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("point out of range")
    return lat, lon


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _params(self):
        """Decoded query parameters (parse_qs handles %XX in scripted calls)."""
        return {
            key: vals[0]
            for key, vals in urllib.parse.parse_qs(
                self.path.split("?", 1)[1], keep_blank_values=True
            ).items()
        }

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/":
                self._send(200, (DEMO / "index.html").read_bytes(),
                           "text/html; charset=utf-8")
            elif path == "/mkad-exact.geojson":
                self._send(200, (DATA / "mkad-exact.geojson").read_bytes(),
                           "application/geo+json; charset=utf-8")
            elif path == "/health":
                try:
                    with _OPENER.open(f"{OSRM_URL}/", timeout=3) as _:
                        pass
                    self._json(200, {"osrm": True})
                except urllib.error.HTTPError:
                    # Any HTTP response, including osrm-routed's 404 on /, means alive.
                    self._json(200, {"osrm": True})
                except (urllib.error.URLError, OSError, RuntimeError):
                    self._json(200, {"osrm": False})
            elif path == "/route":
                query = self._params()
                a = parse_point(query["a"])
                b = parse_point(query["b"])
                a_in, b_in = inside_mkad(*a), inside_mkad(*b)
                if a_in and b_in:
                    result = osrm_route(a, b)
                else:
                    result = straight_line(a, b)
                result["a_inside_mkad"] = a_in
                result["b_inside_mkad"] = b_in
                self._json(200, result)
            elif path == "/v2":
                self._send(200, (DEMO / "v2.html").read_bytes(),
                           "text/html; charset=utf-8")
            elif path == "/model":
                self._json(200, MODEL_INFO)
            elif path == "/route2":
                query = self._params()
                a = parse_point(query["a"])
                b = parse_point(query["b"])
                departure = float(query.get("departure") or time.time())
                a_in, b_in = inside_mkad(*a), inside_mkad(*b)
                # A point just outside the ring used to skip OSRM entirely, so a
                # real street became a dashed chord. Ask OSRM first; the straight
                # connector remains only when the graph has no route.
                try:
                    result = road_route_v2(a, b, departure)
                except (urllib.error.URLError, OSError, RuntimeError, json.JSONDecodeError):
                    result = straight_line_v2(a, b, departure)
                result["a_inside_mkad"] = a_in
                result["b_inside_mkad"] = b_in
                self._json(200, result)
            elif path == "/matrix2":
                query = self._params()
                raw_points = [
                    tuple(map(float, piece.split(",")))
                    for piece in query["points"].split(";")
                    if piece
                ]
                if not raw_points:
                    raise ValueError("points is empty")
                departure = float(query.get("departure") or time.time())
                bbox = None
                if query.get("bbox"):
                    vals = [float(v) for v in query["bbox"].split(",")]
                    if len(vals) != 4:
                        raise ValueError("bbox must be minlon,minlat,maxlon,maxlat")
                    bbox = tuple(vals)
                refine = query.get("refine") in ("1", "true", "yes")
                if query.get("planning") == "1":
                    self._json(200, build_planning_matrix(raw_points, departure))
                else:
                    self._json(200, build_matrix(raw_points, departure, bbox, refine))
            else:
                self._json(404, {"error": "not found"})
        except (ValueError, KeyError) as exc:
            self._json(400, {"error": f"bad request: {exc}"})
        except urllib.error.HTTPError as exc:
            self._json(502, {"error": f"OSRM NoRoute or HTTP {exc.code}"})
        except (urllib.error.URLError, OSError, RuntimeError, json.JSONDecodeError) as exc:
            self._json(502, {"error": f"OSRM unavailable: {exc}"})

    def log_message(self, fmt, *args):
        pass  # keep the demo console quiet


if __name__ == "__main__":
    _load_cache()
    server = ThreadingHTTPServer((HOST, DEMO_PORT), Handler)
    print(f"MKAD demo: http://{HOST}:{DEMO_PORT}  (OSRM at {OSRM_URL}, "
          f"base cache: {len(_base_cache)} pairs)")
    server.serve_forever()
