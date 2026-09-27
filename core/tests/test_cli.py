"""Real subprocess smoke for the documented offline solve/export workflow."""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_serve_keeps_calibration_beside_explicit_settings(tmp_path, monkeypatch):
    """The writable state volume, not the process working directory, owns calibration."""
    from core.__main__ import main
    from core.predict_calibration import factory_calibration
    from fastapi.testclient import TestClient

    state = tmp_path / "state"
    monkeypatch.chdir(tmp_path)
    # A blocked default directory exposes accidental writes outside the state volume.
    (tmp_path / ".router").write_text("not a state directory", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [
        "core", "serve", "--graph", str(ROOT / "core/examples/graph.json"),
        "--snapshot", str(ROOT / "core/examples/snapshot.json"),
        "--settings", str(state / "settings.json"),
    ])
    learned = factory_calibration().model_copy(update={"service_cv": 0.2})
    calls = 0

    def run(app, **kwargs):
        nonlocal calls
        with TestClient(app) as client:
            if calls == 0:
                response = client.put("/v1/config/predict-calibration", json={
                    "operation_id": "persist-test", "calibration": learned.model_dump(),
                })
                assert response.status_code == 200
            else:
                response = client.get("/v1/config/predict-calibration")
                assert response.json()["calibration"] == learned.model_dump()
        calls += 1

    monkeypatch.setattr("uvicorn.run", run)
    main()
    assert (state / "predict-calibration.json").exists()
    main()
    assert calls == 2


def test_offline_cli_pipeline(tmp_path):
    result = tmp_path / "result.json"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "core",
            "solve",
            "--graph",
            "core/examples/graph.json",
            "--snapshot",
            "core/examples/snapshot.json",
            "--budget-ms",
            "900",
            "--output",
            str(result),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(result.read_text(encoding="utf-8"))
    assert data["status"] == "ready"
    assert data["main"]["summary"]["assigned_count"] == 3
    geometry = tmp_path / "routes.geojson"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "core",
            "export-map",
            "--result",
            str(result),
            "--output",
            str(geometry),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(geometry.read_text(encoding="utf-8"))["features"]


def test_invalid_snapshot_cli_fails_with_machine_readable_error(tmp_path):
    invalid = tmp_path / "invalid.json"
    invalid.write_text("{}", encoding="utf-8")
    result = tmp_path / "error.json"
    command = subprocess.run(
        [
            sys.executable,
            "-m",
            "core",
            "solve",
            "--graph",
            "core/examples/graph.json",
            "--snapshot",
            str(invalid),
            "--output",
            str(result),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert command.returncode == 1
    assert json.loads(result.read_text(encoding="utf-8"))["status"] == "error"


def test_official_east_benchmark_cli(tmp_path):
    result = tmp_path / "east-benchmark.json"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "core",
            "benchmark",
            "--region",
            "east",
            "--budget-ms",
            "500",
            "--solution-limit",
            "4",
            "--event-budget-ms",
            "100",
            "--output",
            str(result),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(result.read_text(encoding="utf-8"))
    assert data["scenario_id"] == "official-east-v1"
    assert data["source"]["requests"] == 66
    assert len(data["evidence"]["requests"]) == 66
    assert [event["event_id"] for event in data["events"]] == [
        "new_normal_request",
        "new_urgent_request",
        "engineer_offline",
        "two_technical_stops_15m",
        "district_traffic_x3",
    ]
