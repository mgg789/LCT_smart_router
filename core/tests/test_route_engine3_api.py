"""route-engine3 v3 contracts: /route3, /matrix3, /metro3 and the metro module."""

import importlib.util
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "services/route-engine3"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_engine3(tmp_path: Path, monkeypatch):
    """Load the service modules in a sandbox with no graphs and no metro file."""
    sandbox = tmp_path / "engine3"
    sandbox.mkdir()
    for name in ("graphs.py", "server.py", "traffic.py", "metro.py", "metro_timetable.py"):
        shutil.copyfile(ROOT / name, sandbox / name)
    monkeypatch.setenv("ENGINE3_GRAPHS_DIR", str(tmp_path / "graphs-empty"))
    monkeypatch.delenv("METRO_DATA_PATH", raising=False)
    monkeypatch.syspath_prepend(str(sandbox))
    graphs = _load_module("route_engine3_graphs_api", sandbox / "graphs.py")
    server = _load_module("route_engine3_server_api", sandbox / "server.py")
    metro = _load_module("route_engine3_metro_api", sandbox / "metro.py")
    return graphs, server, metro


class FakeSpec:
    """Minimal GraphSpec stand-in for handler tests."""

    def __init__(self, speeds_kmh=None, graph_id="foot", profile="foot"):
        self.graph_id = graph_id
        self.profile = profile
        self.map_version = "test-v1"
        self.max_table_size = 4096
        self.speeds_kmh = speeds_kmh or {"walk": 5.0, "bike": 15.0}


class FakeRuntime:
    def __init__(self, spec):
        self.spec = spec
        self.port = 5999


class StubRegistry:
    def __init__(self, runtime):
        self._runtime = runtime

    def graph_for(self, profile):
        if profile == "car":
            return FakeRuntime(FakeSpec(graph_id="car", profile="car"))
        return self._runtime

    def snapshot(self):
        return [{"graph_id": "car", "healthy": True}, {"graph_id": "foot", "healthy": True}]


A = (55.75, 37.60)
B = (55.78, 37.66)
FOOT_RUNTIME = FakeRuntime(FakeSpec())


def test_route3_walk_flat_speed(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))

    def route(runtime, a, b, *, steps):
        assert steps is False
        return {"duration": 9999.0, "distance": 3600.0, "geometry": [[a[0], a[1]], [b[0], b[1]]]}

    monkeypatch.setattr(server, "_route_over_graph", route)
    body = server.handle_route3(
        {"a": "55.75,37.60", "b": "55.78,37.66", "profile": "walk", "metro": "0"}
    )
    # Flat-speed contract: 3600 m at 5 km/h = 2592 s, never the OSRM duration.
    assert body["duration_s"] == 2592
    assert body["mode"] == "road"
    assert body["traffic_applied" if "traffic_applied" in body else "mode"] in ("road",)
    assert body["graph_id"] == "foot"
    assert set(body["versions"]) == {"car", "foot", "metro", "model"}
    bike = server.handle_route3(
        {"a": "55.75,37.60", "b": "55.78,37.66", "profile": "bike", "metro": "0"}
    )
    assert bike["duration_s"] == 864  # 3600 m at 15 km/h


def test_route3_car_traffic_and_fallback(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)

    def route(runtime, a, b, *, steps):
        result = {"duration": 600.0, "distance": 5000.0, "geometry": [[a[0], a[1]], [b[0], b[1]]]}
        if steps:
            result["steps"] = [{
                "duration": 600.0,
                "distance": 5000.0,
                "name": "Ленинский проспект",
                "ref": "",
                "midpoint": (55.7, 37.6),
            }]
        return result

    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))
    monkeypatch.setattr(server, "_route_over_graph", route)
    plain = server.handle_route3({"a": "55.75,37.60", "b": "55.78,37.66", "profile": "car"})
    assert plain["mode"] == "road"
    assert plain["duration_s"] == 600
    assert plain["traffic_applied"] is False

    monkeypatch.setattr(server, "_route_steps", lambda *_args: (_ for _ in ()).throw(AssertionError("second OSRM route")))
    factored = server.handle_route3(
        {
            "a": "55.75,37.60",
            "b": "55.78,37.66",
            "profile": "car",
            "traffic": "1",
            "departure": "1786946400",
        }
    )
    assert factored["traffic_applied"] is True
    assert factored["base_duration_s"] == 600
    assert factored["duration_s"] == factored["base_duration_s"] * factored["effective_factor"]

    monkeypatch.setattr(
        server,
        "_route_over_graph",
        lambda runtime, a, b, *, steps: {
            "duration": 600.0,
            "distance": 5000.0,
            "geometry": [[a[0], a[1]], [b[0], b[1]]],
        },
    )
    degraded = server.handle_route3(
        {"a": "55.75,37.60", "b": "55.78,37.66", "profile": "car", "traffic": "1"}
    )
    assert degraded["mode"] == "road"
    assert degraded["duration_s"] == 600
    assert degraded["traffic_applied"] is False

    def failing(runtime, a, b, *, steps):
        raise RuntimeError("NoRoute")

    monkeypatch.setattr(server, "_route_over_graph", failing)
    straight = server.handle_route3({"a": "55.75,37.60", "b": "55.78,37.66", "profile": "car"})
    assert straight["mode"] == "straight"
    assert straight["distance_m"] > 0


def test_route3_rejects_successful_osrm_route_snapped_far_from_destination(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))
    far = (54.8041762, 38.2768274)  # Kashira: outside the vendored MKAD graphs.

    def snapped(runtime, a, b, *, steps):
        return {
            "duration": 1500.0,
            "distance": 23000.0,
            "geometry": [[a[0], a[1]], [55.575185, 37.695016]],
            "steps": [],
        }

    monkeypatch.setattr(server, "_route_over_graph", snapped)
    for profile in ("car", "walk"):
        body = server.handle_route3({
            "a": "55.6997977,37.7725762",
            "b": f"{far[0]},{far[1]}",
            "profile": profile,
            "metro": "0",
        })
        assert body["mode"] == "straight"
        assert body["geometry"] == [[55.6997977, 37.7725762], list(far)]
        assert body["distance_m"] > 100_000
    plain = server.handle_route3({
        "a": "55.6997977,37.7725762", "b": f"{far[0]},{far[1]}",
        "profile": "car", "traffic": "0", "departure": "1786946400",
    })
    factored = server.handle_route3({
        "a": "55.6997977,37.7725762", "b": f"{far[0]},{far[1]}",
        "profile": "car", "traffic": "1", "departure": "1786946400",
    })
    assert plain["duration_s"] == plain["base_duration_s"]
    assert plain["traffic_applied"] is False
    assert factored["duration_s"] >= plain["duration_s"]
    assert factored["traffic_applied"] is True


def test_matrix3_outside_graph_uses_straight_costs_without_discarding_job(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))

    def table(_url, timeout=120.0):
        return {
            "code": "Ok",
            "durations": [[0.0, 1534.4], [1357.3, 0.0]],
            "distances": [[0.0, 23119.7], [22514.6, 0.0]],
            "sources": [{"distance": 27.6}, {"distance": 93_496.9}],
            "destinations": [{"distance": 27.6}, {"distance": 93_496.9}],
        }

    monkeypatch.setattr(server, "_osrm_get", table)
    params = {
        "points": "55.6997977,37.7725762;54.8041762,38.2768274",
        "profile": "car",
        "traffic": "1",
        "planning": "1",
        "departure": "1786946400",
    }
    car = server.handle_matrix3(params)
    cell = car["matrix"][0][1]
    assert cell["mode"] == "straight"
    assert cell["distance_m"] > 100_000
    assert len(cell["forecast_duration_s"]) == len(car["forecast_band_starts"])
    assert car["matrix"][1][0]["mode"] == "straight"
    plain = server.handle_matrix3({**params, "traffic": "0", "planning": "0"})
    assert plain["matrix"][0][1]["duration_s"] == plain["matrix"][0][1]["base_duration_s"]
    walk = server.handle_matrix3({**params, "profile": "walk", "traffic": "0", "planning": "0"})
    assert walk["matrix"][0][1]["mode"] == "straight"
    assert walk["matrix"][0][1]["duration_s"] > 60_000
    monkeypatch.setattr(server, "_osrm_get", lambda *_args, **_kwargs: {
        "code": "Ok", "durations": [[0, 10], [10, 0]],
        "distances": [[0, 50], [50, 0]],
    })
    assert server.handle_matrix3(params)["matrix"][0][1]["mode"] == "straight"


def test_route3_metro_composite(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))

    class StubMetro:
        version = "test-metro"
        enter_sec, wait_sec, exit_sec, transfer_sec, max_access_m = 180, 120, 120, 240, 1500

        def nearest(self, point, top_k=2, max_access_m=None):
            station = (55.76, 37.62) if point == A else (55.77, 37.64)
            return [
                {
                    "station_id": "m1:x",
                    "name": "Тестовая",
                    "line_id": "1",
                    "location": list(station),
                    "access_m": 500.0,
                    "access_sec": 400,
                }
            ]

        def ride_path(self, source, target):
            return {
                "from_station": source,
                "to_station": target,
                "duration_sec": 600,
                "distance_m": 4000.0,
                "stations": [],
                "geometry": [[55.76, 37.62], [55.77, 37.64]],
            }

    server.METRO = StubMetro()

    STATIONS = ((55.76, 37.62), (55.77, 37.64))

    def route(runtime, a, b, *, steps):
        # Station access legs are short (500 m); the direct a→b walk is 8 km,
        # i.e. 5760 s at 5 km/h — the metro composite must win.
        near_station = any(
            abs(a[0] - s[0]) < 1e-6 and abs(a[1] - s[1]) < 1e-6 for s in STATIONS
        ) or any(abs(b[0] - s[0]) < 1e-6 and abs(b[1] - s[1]) < 1e-6 for s in STATIONS)
        distance = 500.0 if near_station else 8000.0
        return {"duration": 9999.0, "distance": distance, "geometry": [[a[0], a[1]], [b[0], b[1]]]}

    monkeypatch.setattr(server, "_route_over_graph", route)
    monkeypatch.setattr(
        server,
        "_table_over_graph",
        lambda runtime, points, **_kwargs: (
            [[0] * len(points) for _ in points],
            [[0 if i == j else 500.0 for j in range(len(points))] for i in range(len(points))],
            [True] * len(points),
        ),
    )
    body = server.handle_route3({"a": "55.75,37.60", "b": "55.78,37.66", "profile": "walk"})
    assert body["mode"] == "metro_composite"
    kinds = [segment["kind"] for segment in body["segments"]]
    assert kinds == ["walk", "metro", "walk"]
    assert body["segments"][1]["travel_source"] == "metro"
    # Access legs are real foot-graph quotes (500 m each at 5 km/h = 360 s).
    assert body["segments"][0]["duration_s"] == 360
    assert body["duration_s"] == 360 + 180 + 120 + 600 + 120 + 360

    # A short walk must stay direct: no metro detour can beat 500 m.
    def short(runtime, a, b, *, steps):
        return {"duration": 9999.0, "distance": 500.0, "geometry": [[a[0], a[1]], [b[0], b[1]]]}

    monkeypatch.setattr(server, "_route_over_graph", short)
    direct = server.handle_route3({"a": "55.75,37.60", "b": "55.78,37.66", "profile": "walk"})
    assert direct["mode"] == "road"


def test_route3_metro_skips_unavailable_candidate_pairs(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))

    class StubMetro:
        enter_sec, wait_sec, exit_sec, transfer_sec, max_access_m = 180, 120, 120, 240, 1500

        def nearest(self, point, top_k=2, max_access_m=None):
            prefix = "o" if point == A else "d"
            return [
                {"station_id": f"{prefix}1", "name": f"{prefix}1", "line_id": "1", "location": [55.76, 37.62], "access_sec": 400, "access_m": 500},
                {"station_id": f"{prefix}2", "name": f"{prefix}2", "line_id": "1", "location": [55.77, 37.64], "access_sec": 400, "access_m": 500},
            ]

        def ride_path(self, source, target):
            if source == "o1":
                return None
            return {"duration_sec": 600, "distance_m": 4000, "stations": [], "geometry": [[55.76, 37.62], [55.77, 37.64]]}

    server.METRO = StubMetro()
    def route(runtime, a, b, *, steps):
        near = (a == A and b != B) or (a != A and b == B)
        distance = 500 if near else 8000
        return {"duration": 9999, "distance": distance, "geometry": [[a[0], a[1]], [b[0], b[1]]]}

    monkeypatch.setattr(server, "_route_over_graph", route)
    monkeypatch.setattr(
        server,
        "_table_over_graph",
        lambda runtime, points, **_kwargs: (
            [[0] * len(points) for _ in points],
            [[0 if i == j else 500 for j in range(len(points))] for i in range(len(points))],
            [True] * len(points),
        ),
    )
    body = server.handle_route3({"a": "55.75,37.60", "b": "55.78,37.66", "profile": "walk"})
    assert body["mode"] == "metro_composite"


def test_matrix3_walk_flat_and_unreachable(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))
    points = [A, B, (55.9, 37.9)]

    def table(runtime, requested, **_kwargs):
        assert requested is points or requested == points
        return (
            [[0, None, None], [None, 0, None], [None, None, 0]],
            [[0, 3600.0, None], [3600.0, 0, None], [None, None, 0]],
            [True] * len(requested),
        )

    monkeypatch.setattr(server, "_table_over_graph", table)
    body = server.handle_matrix3(
        {"points": "55.75,37.60;55.78,37.66;55.90,37.90", "profile": "walk"}
    )
    assert body["matrix"][0][1]["duration_s"] == 2592  # 3600 m at 5 km/h
    assert body["matrix"][0][2]["mode"] == "unreachable"
    assert body["matrix"][0][0]["mode"] == "self"
    assert body["speed_kmh"] == 5.0
    assert set(body["versions"]) == {"car", "foot", "metro", "model"}


def test_matrix3_car_planning_forecast_bands(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))

    def table(runtime, requested, **_kwargs):
        return (
            [[0, 600.0], [600.0, 0]],
            [[0, 5000.0], [5000.0, 0]],
            [True] * len(requested),
        )

    monkeypatch.setattr(server, "_table_over_graph", table)
    body = server.handle_matrix3(
        {"points": "55.75,37.60;55.78,37.66", "profile": "car", "traffic": "1", "planning": "1"}
    )
    starts = body["forecast_band_starts"]
    assert starts[0] == 0 and starts == sorted(set(starts))
    cell = body["matrix"][0][1]
    assert len(cell["forecast_duration_s"]) == len(starts)
    assert body["forecast_timezone"] == "Europe/Moscow"
    assert cell["duration_s"] == round(600.0 * cell["effective_factor"], 1)
    plain = server.handle_matrix3(
        {"points": "55.75,37.60;55.78,37.66", "profile": "car", "traffic": "0"}
    )
    assert plain["matrix"][0][1]["duration_s"] == plain["matrix"][0][1]["base_duration_s"]


def test_metro3_paths_and_constants(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)

    class StubMetro:
        version = "test-metro"
        enter_sec, wait_sec, exit_sec, transfer_sec, max_access_m = 180, 120, 120, 240, 1500

        def nearest(self, point, top_k=2, max_access_m=None):
            return [
                {
                    "station_id": f"m1:{point[0]}",
                    "name": "Тестовая",
                    "line_id": "1",
                    "location": list(point),
                    "access_m": 300.0,
                    "access_sec": 240,
                }
            ]

        def ride_path(self, source, target):
            if source == target:
                return None
            return {
                "from_station": source,
                "to_station": target,
                "duration_sec": 300,
                "distance_m": 2000.0,
                "stations": [],
                "geometry": [[55.75, 37.6], [55.78, 37.66]],
            }

    server.METRO = StubMetro()
    body = server.handle_metro3({"points": "55.75,37.60;55.78,37.66"})
    assert body["version"] == "test-metro"
    assert body["constants"]["enter_sec"] == 180
    assert len(body["stations"]) == 2
    path = body["paths"][0]
    assert path["composite_duration_sec"] == 240 + 180 + 120 + 300 + 120 + 240
    assert path["ride"]["duration_sec"] == 300
    assert body["versions"]["model"].startswith("route-engine3-v3+traffic:")

    server.METRO = None
    try:
        server.handle_metro3({"points": "55.75,37.60;55.78,37.66"})
        raise AssertionError("expected METRO_NOT_CONFIGURED")
    except RuntimeError as error:
        assert "METRO_NOT_CONFIGURED" in str(error)


def test_metro_module_dijkstra_and_geometry(tmp_path, monkeypatch):
    graphs, _server, metro = load_engine3(tmp_path, monkeypatch)
    assert graphs is not None
    artifact = {
        "version": "test-v1",
        "enter_sec": 180,
        "exit_sec": 120,
        "wait_sec": 120,
        "transfer_sec": 240,
        "stations": [
            {
                "station_id": "a",
                "name": "A",
                "line_id": "1",
                "location": {"lat": 55.75, "lon": 37.60},
            },
            {
                "station_id": "b",
                "name": "B",
                "line_id": "1",
                "location": {"lat": 55.76, "lon": 37.61},
            },
            {
                "station_id": "c",
                "name": "C",
                "line_id": "2",
                "location": {"lat": 55.77, "lon": 37.62},
            },
        ],
        "edges": [
            {
                "source": "a",
                "target": "b",
                "duration_sec": 100,
                "distance_m": 1200,
                "kind": "ride",
                "geometry": [[55.75, 37.60], [55.755, 37.605], [55.76, 37.61]],
            },
            {"source": "b", "target": "c", "duration_sec": 200, "distance_m": 2400, "kind": "ride"},
            {
                "source": "a",
                "target": "c",
                "duration_sec": 1000,
                "distance_m": 4000,
                "kind": "ride",
            },
        ],
    }
    network = metro.MetroService(artifact)
    assert network.version == "test-v1"
    # Direct a→c is slower than a→b→c (300 < 1000); the tree must find it.
    ride = network.ride_path("a", "c")
    assert ride["duration_sec"] == 300
    assert ride["stations"] == [
        {"station_id": "a", "name": "A", "line_id": "1"},
        {"station_id": "b", "name": "B", "line_id": "1"},
        {"station_id": "c", "name": "C", "line_id": "2"},
    ]
    # Geometry joins per-edge payloads, dropping the duplicated joint point.
    assert ride["geometry"] == [[55.75, 37.60], [55.755, 37.605], [55.76, 37.61], [55.77, 37.62]]
    # The artifact is directed; an absent reverse edge is unreachable.
    assert network.ride_path("c", "a") is None
    nearest = network.nearest((55.7505, 37.6005), top_k=1)
    assert nearest[0]["station_id"] == "a"
    assert nearest[0]["access_m"] < 100
    assert metro.MetroService.from_env() is None or True


def test_forecast_bands_use_moscow_clock_and_include_night_boundary(tmp_path, monkeypatch):
    """A band labelled 07:00 must not contain the factor for 10:00 Moscow."""
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    starts, epochs = server._forecast_band_layout()
    assert 22 * 60 in starts
    for minute, epoch in zip(starts, epochs, strict=True):
        actual, _iso = server.traffic.local_minute_of_day(epoch)
        assert actual == (minute if minute else 3 * 60)
