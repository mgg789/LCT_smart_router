"""route-engine3 skeleton: graph discovery, supervision and identity endpoints."""

import importlib.util
import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "services/route-engine3"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # Dataclasses resolve annotations through sys.modules[module.__name__].
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_engine3(tmp_path: Path, monkeypatch) -> tuple[object, object]:
    """Copy the service into a sandbox with its own graphs dir and load it."""
    sandbox = tmp_path / "engine3"
    sandbox.mkdir()
    for name in ("graphs.py", "server.py"):
        shutil.copyfile(ROOT / name, sandbox / name)
    graphs_dir = tmp_path / "graphs"
    (graphs_dir / "car").mkdir(parents=True)
    (graphs_dir / "car" / "moscow-mkad.osrm").touch()
    (graphs_dir / "car" / "graph.json").write_text(
        json.dumps(
            {
                "graph_id": "car",
                "profile": "car",
                "map_version": "moscow-mkad",
                "speeds_kmh": {"walk": 4.0},
            }
        ),
        encoding="utf-8",
    )
    (graphs_dir / "foot").mkdir()
    (graphs_dir / "foot" / "moscow-mkad-foot.osrm").touch()
    (graphs_dir / "empty").mkdir()
    (graphs_dir / "broken-foot").mkdir()
    (graphs_dir / "broken-foot" / "graph.json").write_text("{not json", encoding="utf-8")
    (graphs_dir / "broken-foot" / "graph.osrm").touch()
    monkeypatch.setenv("ENGINE3_GRAPHS_DIR", str(graphs_dir))
    monkeypatch.syspath_prepend(str(sandbox))
    graphs = _load_module("route_engine3_graphs", sandbox / "graphs.py")
    server = _load_module("route_engine3_server", sandbox / "server.py")
    return graphs, server


def test_discover_graphs_defaults_meta_and_broken(tmp_path, monkeypatch):
    graphs, _ = load_engine3(tmp_path, monkeypatch)
    specs = {spec.graph_id: spec for spec in graphs.discover_graphs(graphs_dir_of(monkeypatch))}
    assert set(specs) == {"car", "foot", "broken-foot"}
    assert specs["car"].profile == "car"
    assert specs["car"].map_version == "moscow-mkad"
    assert specs["car"].speeds_kmh["walk"] == 4.0
    # The foot folder carries no meta: id-based profile inference and default speeds.
    assert specs["foot"].profile == "foot"
    assert specs["foot"].speeds_kmh == {"walk": 5.0, "bike": 15.0}
    # A malformed graph.json degrades to defaults instead of killing discovery.
    assert specs["broken-foot"].profile == "foot"
    assert specs["broken-foot"].max_table_size == 4096


def graphs_dir_of(monkeypatch) -> Path:
    import os

    return Path(os.environ["ENGINE3_GRAPHS_DIR"])


def test_supervisor_routes_profiles_and_reports_health(tmp_path, monkeypatch):
    graphs, _ = load_engine3(tmp_path, monkeypatch)
    specs = graphs.discover_graphs(graphs_dir_of(monkeypatch))

    class FakeProcess:
        def poll(self):
            return None

        def terminate(self):
            pass

        def wait(self, timeout=None):
            return 0

        def kill(self):
            pass

    prober_ports = set()
    supervisor = graphs.GraphSupervisor(
        specs,
        base_port=6300,
        runner=lambda runtime: (prober_ports.add(runtime.port), FakeProcess())[1],
        prober=lambda port: True,
    )
    supervisor.start()
    deadline = time.monotonic() + 5.0
    while not all(entry["healthy"] for entry in supervisor.snapshot()):
        assert time.monotonic() < deadline, "graphs never became healthy"
        time.sleep(0.05)
    assert supervisor.graph_for("car").spec.graph_id == "car"
    for profile in ("walk", "bike", "transit"):
        assert supervisor.graph_for(profile).spec.graph_id == "foot"
    status = {entry["graph_id"]: entry for entry in supervisor.snapshot()}
    assert status["car"]["map_version"] == "moscow-mkad"
    assert status["foot"]["max_table_size"] == 4096
    supervisor.stop()


def test_identity_endpoints(tmp_path, monkeypatch):
    _, server = load_engine3(tmp_path, monkeypatch)

    class StubSupervisor:
        def snapshot(self):
            return [
                {"graph_id": "car", "healthy": True, "profile": "car"},
                {"graph_id": "foot", "healthy": True, "profile": "foot"},
            ]

    server.REGISTRY = StubSupervisor()
    health = server.handle_health()
    assert health["service"] == server.SERVICE_VERSION
    assert health["ready"] is True
    assert health["graphs"] == {"car": True, "foot": True}
    model = server.handle_model()
    assert model["models"]["car"].startswith("osrm-mld")
    assert "no traffic engines" in model["walk_bike_policy"]
    assert {graph["graph_id"] for graph in model["graphs"]} == {"car", "foot"}
