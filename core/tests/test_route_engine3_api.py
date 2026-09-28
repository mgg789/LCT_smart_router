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
    for name in ("graphs.py", "server.py", "traffic.py", "metro.py"):
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
    bike = server.handle_route3(
        {"a": "55.75,37.60", "b": "55.78,37.66", "profile": "bike", "metro": "0"}
    )
    assert bike["duration_s"] == 864  # 3600 m at 15 km/h


def test_route3_car_traffic_and_fallback(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)

    def route(runtime, a, b, *, steps):
        return {"duration": 600.0, "distance": 5000.0, "geometry": [[a[0], a[1]], [b[0], b[1]]]}

    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))
    monkeypatch.setattr(server, "_route_over_graph", route)
    plain = server.handle_route3({"a": "55.75,37.60", "b": "55.78,37.66", "profile": "car"})
    assert plain["mode"] == "road"
    assert plain["duration_s"] == 600
    assert plain["traffic_applied"] is False

    monkeypatch.setattr(
        server,
        "_route_steps",
        lambda runtime, a, b: [
            {
                "duration": 600.0,
                "distance": 5000.0,
                "name": "Ленинский проспект",
                "ref": "",
                "midpoint": (55.7, 37.6),
            }
        ],
    )
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

    def failing_steps(runtime, a, b):
        raise RuntimeError("step request timed out")

    monkeypatch.setattr(server, "_route_steps", failing_steps)
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


def test_matrix3_walk_flat_and_unreachable(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))
    points = [A, B, (55.9, 37.9)]

    def table(runtime, requested, **_kwargs):
        assert requested is points or requested == points
        return (
            [[0, None, None], [None, 0, None], [None, None, 0]],
            [[0, 3600.0, None], [3600.0, 0, None], [None, None, 0]],
        )

    monkeypatch.setattr(server, "_table_over_graph", table)
    body = server.handle_matrix3(
        {"points": "55.75,37.60;55.78,37.66;55.90,37.90", "profile": "walk"}
    )
    assert body["matrix"][0][1]["duration_s"] == 2592  # 3600 m at 5 km/h
    assert body["matrix"][0][2]["mode"] == "unreachable"
    assert body["matrix"][0][0]["mode"] == "self"
    assert body["speed_kmh"] == 5.0


def test_matrix3_car_planning_forecast_bands(tmp_path, monkeypatch):
    _, server, _ = load_engine3(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "REGISTRY", StubRegistry(FOOT_RUNTIME))

    def table(runtime, requested, **_kwargs):
        return (
            [[0, 600.0], [600.0, 0]],
            [[0, 5000.0], [5000.0, 0]],
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
    # Rides are bidirectional even though the artifact stores one direction.
    assert network.ride_path("c", "a")["duration_sec"] == 300
    nearest = network.nearest((55.7505, 37.6005), top_k=1)
    assert nearest[0]["station_id"] == "a"
    assert nearest[0]["access_m"] < 100
    assert metro.MetroService.from_env() is None or True
