"""The vendored road service exports forecast costs with one cold table call."""

import importlib.util
import shutil
from pathlib import Path


def test_planning_matrix_batches_and_reuses_cached_bases(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2] / "services/road-api"
    demo = tmp_path / "demo"
    demo.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    for name in ("server.py", "traffic.py"):
        shutil.copyfile(root / name, demo / name)
    shutil.copyfile(root / "data/mkad-exact.geojson", data / "mkad-exact.geojson")
    monkeypatch.setenv("OSRM_URL", "http://127.0.0.1:5000")
    monkeypatch.syspath_prepend(str(demo))
    spec = importlib.util.spec_from_file_location("road_matrix_test_server", demo / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    points = [(55.75, 37.6), (55.76, 37.61)]
    calls = []

    def table(requested):
        calls.append(requested)
        return [[0, 60], [90, 0]], [[0, 600], [900, 0]]

    monkeypatch.setattr(module, "inside_mkad", lambda *_: True)
    monkeypatch.setattr(module, "osrm_table", table)
    monkeypatch.setattr(
        module,
        "osrm_route_steps",
        lambda *_: (_ for _ in ()).throw(AssertionError("per-pair request")),
    )
    result = module.build_planning_matrix(points, 1789970400)
    assert len(calls) == 1
    assert 8 * 60 in result["forecast_band_starts"]
    assert 9 * 60 + 15 in result["forecast_band_starts"]
    assert result["matrix"][0][1]["base_duration_s"] == 60
    assert result["matrix"][1][0]["distance_m"] == 900
    assert len(result["matrix"][0][1]["forecast_duration_s"]) == len(result["forecast_band_starts"])
    assert module._cache_dirty is False
    cached = module.build_planning_matrix(points, 1789970400 + 3600)
    assert cached["matrix"] == result["matrix"]
    assert len(calls) == 1
