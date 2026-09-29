"""One fresh-process Redis-beta trial against the real private HTTP API.

Run in a fresh Linux container per trial for isolated cgroup CPU/peak-memory
accounting. Redis is managed separately; this command never clears its keys.
"""

import argparse
import hashlib
import json
import platform
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict
from pathlib import Path

import uvicorn

from core.api import create_app
from core.catalog_cache import code_version
from core.engine import SearchSettings
from core.geo import content_hash
from core.official import load_official_region
from core.runtime import RouterRuntime, SnapshotPublication


def semantic(value):
    """Remove timing/instance metadata only; retain every route, constraint and quality field."""
    if isinstance(value, dict):
        return {
            key: semantic(item)
            for key, item in value.items()
            if key not in {"computed_at", "calculation_ms", "result_id"}
        }
    if isinstance(value, list):
        return [semantic(item) for item in value]
    return value


def digest(value) -> str:
    """Hash canonical complete semantic output for comparison between fresh processes."""
    return hashlib.sha256(
        json.dumps(semantic(value), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def route3_evidence(result: dict, required: bool) -> dict:
    """Reject a silent hybrid fallback when a trial claims to use route-engine3."""
    report = result.get("verification") or {}
    legs = report.get("verified_legs", 0)
    if required and (not isinstance(legs, int) or legs <= 0):
        raise RuntimeError("BENCHMARK_ROUTE3_VERIFICATION_MISSING")
    return {
        "required": required,
        "verified_legs": legs,
        "report_digest": digest(report),
        "routes": report.get("routes", []),
    }


class FixedReader:
    """Keep the exact official input publication identical across processes and beta modes."""

    def __init__(self, raw: bytes):
        self.publication = SnapshotPublication(
            "redis-benchmark-east-v1", 1, raw, content_hash(raw), 1
        )

    def read(self) -> SnapshotPublication:
        """Return immutable bytes; benchmark reads never advance the simulated clock."""
        return self.publication


def cgroup() -> dict:
    """Read aggregate process-tree resource counters, or label them unavailable."""
    root = Path("/sys/fs/cgroup")
    try:
        if not (root / "cpu.stat").exists():
            return {
                "cpu_usec": int((root / "cpuacct/cpuacct.usage").read_text()) // 1000,
                "memory_current_bytes": int((root / "memory/memory.usage_in_bytes").read_text()),
                "memory_peak_bytes": int((root / "memory/memory.max_usage_in_bytes").read_text()),
            }
        cpu = dict(line.split() for line in (root / "cpu.stat").read_text().splitlines())
        return {
            "cpu_usec": int(cpu["usage_usec"]),
            "memory_current_bytes": int((root / "memory.current").read_text()),
            "memory_peak_bytes": int((root / "memory.peak").read_text()),
        }
    except (OSError, ValueError, KeyError):
        return {"unavailable": True}


def main() -> None:
    """Measure startup, first/warm catalog HTTP calls, ordinary reads and quality digests."""
    started = time.perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--budget-ms", type=int, default=1000)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--require-route3", action="store_true")
    args = parser.parse_args()
    before_resources = cgroup()
    if before_resources.get("unavailable"):
        raise RuntimeError("BENCHMARK_REQUIRES_CGROUP_RESOURCE_COUNTERS")
    scenario = load_official_region(Path("data/dataset/anonymized"), "east")
    raw = scenario.snapshot.model_dump_json().encode()
    settings = SearchSettings(time_limit_ms=args.budget_ms)
    runtime = RouterRuntime(FixedReader(raw), scenario.graph, settings, poll_sec=0.02)
    # Binding port zero avoids a race with another process reserving a fixed port.
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(runtime), log_level="error"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path):
        with http.open(f"http://127.0.0.1:{port}{path}", timeout=180) as response:
            return json.load(response)

    def measured(path):
        start = time.perf_counter()
        result = request(path)
        return result, round((time.perf_counter() - start) * 1000, 3)

    try:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                initial = request("/v1/result")
                if initial["status"] == "ready":
                    break
                if initial["status"] == "error":
                    raise RuntimeError("BENCHMARK_INITIAL_PLAN_FAILED")
            except urllib.error.URLError:
                pass
            time.sleep(0.02)
        else:
            raise RuntimeError("BENCHMARK_READY_TIMEOUT")
        ready_ms = (time.perf_counter() - started) * 1000
        ready_resources = cgroup()
        verification = route3_evidence(initial, args.require_route3)
        comparison, first_ms = measured("/v1/policy-comparison")
        first_resources = cgroup()
        warm_ms = []
        for _ in range(5):
            warm, elapsed = measured("/v1/policy-comparison")
            assert comparison == warm
            warm_ms.append(elapsed)
        status_ms = [measured("/v1/result-status")[1] for _ in range(20)]
        result_ms = [measured("/v1/result")[1] for _ in range(10)]
        final = request("/v1/result")
        assert initial == final, "Reading the catalog changed the active plan"
        plans = next(iter(runtime._comparison_plans.values()))
        output = {
            "label": args.label,
            "python": platform.python_version(),
            "code_version": code_version(),
            "input_hash": content_hash(raw),
            "graph_hash": content_hash(scenario.graph.model_dump_json().encode()),
            "settings": asdict(settings),
            "requests": len(scenario.snapshot.requests),
            "route3": verification,
            "active_summary": initial["main"]["summary"],
            "ready_ms": round(ready_ms, 3),
            "first_catalog_ms": first_ms,
            "warm_catalog_ms": warm_ms,
            "status_ms": status_ms,
            "result_ms": result_ms,
            "active_plan_digest": digest(initial),
            "comparison_digest": digest(comparison),
            "catalog_plans_digest": digest(
                {key: plan.model_dump(mode="json") for key, plan in plans.items()}
            ),
            "rows": [
                {"strategy_id": row["strategy_id"], "summary": row["summary"]}
                for row in comparison["rows"]
            ],
            "cache": runtime.catalog_cache_stats(),
            "resources_before": before_resources,
            "resources_ready": ready_resources,
            "resources_first_catalog": first_resources,
        }
    finally:
        server.should_exit = True
        thread.join(timeout=180)
        listener.close()
        if thread.is_alive():
            raise RuntimeError("BENCHMARK_SERVER_SHUTDOWN_TIMEOUT")
    output["resources_final"] = cgroup()
    output["total_ms"] = round((time.perf_counter() - started) * 1000, 3)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                key: output[key]
                for key in ("label", "ready_ms", "first_catalog_ms", "cache", "comparison_digest")
            }
        )
    )


if __name__ == "__main__":
    main()
