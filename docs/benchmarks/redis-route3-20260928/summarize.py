"""Recalculate summary.json from untouched trial JSON and manifest in this folder."""

import json
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def p95(values: list[float]) -> float:
    """Return nearest-rank p95 over the pooled requests, without interpolation."""
    return sorted(values)[math.ceil(0.95 * len(values)) - 1]


def main() -> None:
    """Validate sample identity and summarize all modes independently for each budget."""
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    groups = {}
    for budget in manifest["budgets_ms"]:
        groups[str(budget)] = {}
        identities = {}
        for mode in ("off", "miss", "hit", "outage"):
            entries = [entry for entry in manifest["trials"] if entry["mode"] == mode and entry["label"].startswith(f"{budget}-")]
            trials = [json.loads((ROOT / f"{entry['label']}.json").read_text(encoding="utf-8")) for entry in entries]
            assert len(trials) == (1 if mode == "outage" else manifest["repeats"])
            for field in ("code_version", "input_hash", "graph_hash", "active_plan_digest", "comparison_digest", "catalog_plans_digest"):
                for trial in trials:
                    assert identities.setdefault(field, trial[field]) == trial[field], (budget, mode, field)
            median = statistics.median
            result = {
                "count": len(trials),
                "ready_ms_median": median([trial["ready_ms"] for trial in trials]),
                "first_catalog_ms_median": median([trial["first_catalog_ms"] for trial in trials]),
                "first_catalog_ms_min": min(trial["first_catalog_ms"] for trial in trials),
                "first_catalog_ms_max": max(trial["first_catalog_ms"] for trial in trials),
                "warm_catalog_ms_median": median([value for trial in trials for value in trial["warm_catalog_ms"]]),
                "catalog_cpu_sec_median": median([(trial["resources_first_catalog"]["cpu_usec"] - trial["resources_ready"]["cpu_usec"]) / 1e6 for trial in trials]),
                "router_trial_cpu_sec_median": median([(trial["resources_final"]["cpu_usec"] - trial["resources_before"]["cpu_usec"]) / 1e6 for trial in trials]),
                "router_peak_mib_median": median([trial["resources_final"]["memory_peak_bytes"] / 2**20 for trial in trials]),
                "redis_rss_mib_median": median([entry["redis_after"]["used_memory_rss_bytes"] / 2**20 for entry in entries]),
                "redis_cpu_sec_median": median([entry["redis_after"]["used_cpu_sec"] - entry["redis_before"]["used_cpu_sec"] for entry in entries]),
                "route3_cpu_sec_median": median([(entry["route3_after"]["cpu_usec"] - entry["route3_before"]["cpu_usec"]) / 1e6 for entry in entries]),
                "route3_current_mib_median": median([entry["route3_after"]["memory_current_bytes"] / 2**20 for entry in entries]),
                "route3_cumulative_peak_mib_median": median([entry["route3_after"]["memory_peak_bytes"] / 2**20 for entry in entries]),
                "status_ms_p95": p95([value for trial in trials for value in trial["status_ms"]]),
                "result_ms_p95": p95([value for trial in trials for value in trial["result_ms"]]),
                "route3_http_200_each": [entry["route3_http_200"] for entry in entries],
                "cache_each": [trial["cache"] for trial in trials],
            }
            groups[str(budget)][mode] = result
        groups[str(budget)]["identity"] = identities
        groups[str(budget)]["speedup_catalog_http_off_over_hit"] = groups[str(budget)]["off"]["first_catalog_ms_median"] / groups[str(budget)]["hit"]["first_catalog_ms_median"]
        groups[str(budget)]["speedup_catalog_cpu_off_over_hit"] = groups[str(budget)]["off"]["catalog_cpu_sec_median"] / groups[str(budget)]["hit"]["catalog_cpu_sec_median"]
    summary = {
        "source_commit": manifest["source_commit"],
        "method": "Median over trials; local warm reads pooled; p95 nearest rank pooled. Router CPU is cgroup delta; Redis CPU is INFO delta. Route3 peak is cumulative across the service lifetime, not per trial. Units are in keys.",
        "groups": groups,
    }
    (ROOT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
