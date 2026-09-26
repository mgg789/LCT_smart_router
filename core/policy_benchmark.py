"""Reproduce offline policy comparisons on all official regions and their union."""

import argparse
import hashlib
import json
import platform
import subprocess
from pathlib import Path

import ortools

from core.engine import SearchSettings
from core.official import combine_official_scenarios, load_official_region
from core.runtime import calculate_policy_comparison


def main() -> None:
    """Write measured rows and exact input identities; never edit source datasets."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--budget-ms", type=int, default=2000)
    parser.add_argument("--access-buffer-sec", type=int, default=600)
    parser.add_argument("--no-traffic", action="store_true")
    parser.add_argument("--lateness-minutes", type=int, choices=(0, 5, 10, 15, 20), default=0)
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    settings = SearchSettings(
        time_limit_ms=args.budget_ms,
        solution_limit=64,
        access_buffer_sec=args.access_buffer_sec,
        traffic_enabled=not args.no_traffic,
        window_lateness_tolerance_sec=args.lateness_minutes * 60,
    )
    names = ("east", "southeast", "south_central")
    regions = [load_official_region(Path("data/dataset/anonymized"), r) for r in names]
    report = {
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "working_tree": bool(subprocess.check_output(["git", "status", "--porcelain"], text=True)),
        "python": platform.python_version(),
        "ortools": ortools.__version__,
        "settings": settings.technical().model_dump(),
        "search_budget_ms": args.budget_ms,
        "repeat": args.repeat,
        "scenarios": [],
    }
    for name, scenario in zip((*names, "all"), [*regions, combine_official_scenarios(regions)]):
        raw = scenario.snapshot.model_dump_json().encode()
        runs = [
            calculate_policy_comparison(
                raw,
                name,
                scenario.graph,
                settings,
                "offline-benchmark",
                args.budget_ms,
                offline=True,
            )
            for _ in range(args.repeat)
        ]
        comparable = [
            [(row.strategy_id, row.summary.model_dump()) for row in run.rows] for run in runs
        ]
        if any(rows != comparable[0] for rows in comparable[1:]):
            raise RuntimeError(f"Non-deterministic metrics for {name}")
        report["scenarios"].append(
            {
                "name": name,
                "input_sha256": hashlib.sha256(raw).hexdigest(),
                "graph_version": scenario.graph.version,
                "comparison": runs[0].model_dump(),
                "repeat_metrics_identical": len(runs) > 1,
            }
        )
        print(
            name,
            [(row.strategy_id, row.summary.assigned_count) for row in runs[0].rows],
            flush=True,
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
