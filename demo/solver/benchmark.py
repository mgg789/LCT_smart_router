"""Isolated cold-start audit measurements. Local versioned graphs only."""

import cProfile
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, os.environ.get("SOLVER_AUDIT_CORE_ROOT", str(ROOT)))


def child(name: str, traffic: bool, profile: bool = False) -> dict:
    """Measure one isolated offline solve, including provider setup but not CSV loading."""
    import ortools

    from core.engine import SearchSettings, solve
    from core.geo import GraphTravel
    from core.official import combine_official_scenarios, load_official_region

    names = ("east", "southeast", "south_central") if name == "all" else (name,)
    loaded = [
        load_official_region(ROOT / "data/dataset/anonymized", item) for item in names
    ]
    scenario = combine_official_scenarios(loaded) if name == "all" else loaded[0]
    settings = SearchSettings(traffic_enabled=traffic)
    profiler = cProfile.Profile() if profile else None
    if profiler:
        profiler.enable()
    wall, cpu = time.perf_counter(), time.process_time()
    out = solve(scenario.snapshot, GraphTravel(scenario.graph), settings)
    elapsed, cpu_sec = time.perf_counter() - wall, time.process_time() - cpu
    if profiler:
        profiler.disable()
        profiler.dump_stats(
            str(ROOT / f"artifacts/solver-audit/profile-{name}-{int(traffic)}.pstats")
        )
    return {
        "scenario": name,
        "traffic": traffic,
        "settings": asdict(settings),
        "python": platform.python_version(),
        "ortools": ortools.__version__,
        "requests": len(scenario.snapshot.requests),
        "engineers": len(scenario.snapshot.engineers),
        "elapsed_sec": elapsed,
        "cpu_sec": cpu_sec,
        "main": out.main.summary.model_dump(),
        "baseline": out.baseline.summary.model_dump(),
        "plan_sha256": hashlib.sha256(out.main.model_dump_json().encode()).hexdigest(),
        "snapshot_sha256": hashlib.sha256(
            scenario.snapshot.model_dump_json().encode()
        ).hexdigest(),
        "graph_version": scenario.graph.version,
    }


if __name__ == "__main__":
    if sys.argv[1] == "child":
        print(
            json.dumps(child(sys.argv[2], sys.argv[3] == "1", "--profile" in sys.argv))
        )
    else:
        output = Path(sys.argv[1])
        output.parent.mkdir(parents=True, exist_ok=True)
        runs = []
        for traffic in (True, False):
            for name in ("east", "southeast", "south_central", "all"):
                for repeat in range(3):
                    result = subprocess.run(
                        [sys.executable, __file__, "child", name, str(int(traffic))],
                        cwd=ROOT,
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                    row = json.loads(result.stdout)
                    row["repeat"] = repeat + 1
                    runs.append(row)
                    output.write_text(
                        json.dumps(
                            {
                                "commit": subprocess.check_output(
                                    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
                                ).strip(),
                                "runs": runs,
                            },
                            indent=2,
                        ),
                        encoding="utf-8",
                    )
                    print(
                        json.dumps(
                            {
                                k: row[k]
                                for k in (
                                    "scenario",
                                    "traffic",
                                    "repeat",
                                    "elapsed_sec",
                                    "plan_sha256",
                                )
                            }
                        ),
                        flush=True,
                    )
