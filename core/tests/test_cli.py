"""Real subprocess smoke for the documented offline solve/export workflow."""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


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
