"""Run isolated Redis trials with real route-engine3; requires Docker and built images.

Only containers and the internal network created by this invocation are removed.
No host ports, existing installations, volumes or production services are used.
The secret is passed through the child environment and never written to evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import secrets
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REDIS_IMAGE = "redis:8.2-alpine@sha256:b51665e66f00759be7c3152ad5ac3c66fb2f619c13ef62dea7cc1f9914524635"
IDENTITY_FIELDS = (
    "code_version", "input_hash", "graph_hash", "active_plan_digest",
    "comparison_digest", "catalog_plans_digest",
)
COUNTERS = """
import json
from pathlib import Path
p = Path('/sys/fs/cgroup')
if (p / 'cpu.stat').exists():
    cpu = dict(line.split() for line in (p / 'cpu.stat').read_text().splitlines())
    values = [int(cpu['usage_usec']), int((p / 'memory.current').read_text()),
              int((p / 'memory.peak').read_text())]
else:
    values = [int((p / 'cpuacct/cpuacct.usage').read_text()) // 1000,
              int((p / 'memory/memory.usage_in_bytes').read_text()),
              int((p / 'memory/memory.max_usage_in_bytes').read_text())]
print(json.dumps(dict(zip(['cpu_usec', 'memory_current_bytes', 'memory_peak_bytes'], values))))
"""


def docker(*args: str, env: dict | None = None, timeout: int = 300, check: bool = True) -> str:
    """Run Docker without a shell; keep private child environment out of errors."""
    result = subprocess.run(
        ["docker", *args], capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=timeout, env=env, check=False,
    )
    if check and result.returncode:
        raise RuntimeError(f"Docker {args[0]} failed: {result.stderr[-2000:]}")
    return result.stdout.strip()


def save(path: Path, value: object) -> None:
    """Persist public JSON evidence after each completed step."""
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def file_hash(path: Path) -> str:
    """Hash vendored resources incrementally without loading complete graphs into memory."""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_trial(trial: dict, mode: str) -> None:
    """Require actual cache behavior and populated live route verification."""
    cache = trial["cache"]
    expected = {
        "off": not cache["enabled"],
        "miss": cache.get("writes") == 1 and cache.get("hits") == 0 and cache.get("errors") == 0,
        "hit": cache.get("hits") == 1 and cache.get("writes") == 0 and cache.get("errors") == 0,
        "outage": cache.get("errors") == 2 and cache.get("hits") == 0,
    }
    if not expected[mode] or trial["route3"]["verified_legs"] <= 0:
        raise RuntimeError(f"Unexpected behavior in {trial['label']}")


def validate_quality(trials: list[dict]) -> None:
    """Compare full semantic outputs only within the same search budget."""
    for budget in {trial["settings"]["time_limit_ms"] for trial in trials}:
        group = [trial for trial in trials if trial["settings"]["time_limit_ms"] == budget]
        for field in IDENTITY_FIELDS:
            if len({trial[field] for trial in group}) != 1:
                raise RuntimeError(f"Quality mismatch: budget={budget}, field={field}")


def redis_stats(container: str) -> dict:
    """Read Redis's own CPU, resident memory and key counters without printing credentials."""
    raw = docker("exec", container, "sh", "-c", 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw INFO')
    rows = dict(line.split(":", 1) for line in raw.splitlines() if ":" in line and not line.startswith("#"))
    return {
        "used_memory_bytes": int(rows["used_memory"]),
        "used_memory_rss_bytes": int(rows["used_memory_rss"]),
        "used_cpu_sec": float(rows["used_cpu_sys"]) + float(rows["used_cpu_user"]),
        "keyspace_hits": int(rows["keyspace_hits"]), "keyspace_misses": int(rows["keyspace_misses"]),
        "keyspace": rows.get("db0", ""),
    }


def route_stats(container: str) -> dict:
    """Measure the whole route-engine3 cgroup, including both OSRM child processes."""
    return json.loads(docker("exec", container, "python3", "-c", COUNTERS))


def main() -> None:
    """Create isolated services, run fresh-process paired trials, validate and clean up."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--budgets", type=int, nargs="+", default=[1000, 8000])
    parser.add_argument("--router-image", default="navix-redis-bench-router:route3")
    parser.add_argument("--route3-image", default="navix-redis-bench-route3:current")
    args = parser.parse_args()
    if args.repeats < 1 or any(not 1 <= value <= 8000 for value in args.budgets):
        parser.error("Positive repeats and budgets in 1..8000 are required")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error("Output directory must be empty")
    prefix = "navix-r3-bench-" + secrets.token_hex(6)
    redis_name, route_name = prefix + "-redis", prefix + "-route3"
    private = {**os.environ, "REDIS_PASSWORD": secrets.token_hex(24)}
    private["ROUTER_REDIS_URL"] = f"redis://:{private['REDIS_PASSWORD']}@redis:6379/0"
    created: list[str] = []
    trials: list[dict] = []
    network_created = False
    worker_name = prefix + "-worker"
    engine_info = json.loads(docker("info", "--format", "{{json .}}"))
    manifest = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_status": subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip(),
        "host": platform.platform(), "docker": engine_info["ServerVersion"],
        "docker_cpus": engine_info["NCPU"], "docker_memory_bytes": engine_info["MemTotal"],
        "repeats": args.repeats, "budgets_ms": args.budgets,
        "limits": {"router": {"cpus": 2, "memory_mib": 1536}, "route3": {"cpus": 2, "memory_mib": 2048}, "redis": {"cpus": 1, "memory_mib": 192}},
        "images": {key: json.loads(docker("image", "inspect", image))[0]["Id"] for key, image in
                   (("router", args.router_image), ("route3", args.route3_image), ("redis", REDIS_IMAGE))},
        "graph_files_sha256": {str(path.relative_to(ROOT)).replace("\\", "/"): file_hash(path)
                               for path in sorted((ROOT / "services/route-engine3/graphs").rglob("*")) if path.is_file()},
        "metro_data_sha256": file_hash(ROOT / "core/resources/metro/moscow.json"),
        "background_containers": docker("ps", "--format", "{{.Names}} {{.Image}}").splitlines(),
        "methodology": "Fresh router per trial, fixed East66 publication; off/miss alternate; hit reuses the preceding miss namespace. Five local warm reads. One paused-Redis outage per budget. Route3 and Redis stay resident throughout. Route3 counters include small exec/probe overhead. Host background load is uncontrolled. No public network or host ports during trials.",
        "trials": [],
    }
    save(output / "manifest.json", manifest)
    try:
        docker("network", "create", "--internal", prefix)
        network_created = True
        common = ["--network", prefix, "--label", "navix.benchmark=redis-route3", "--label", f"com.docker.compose.project={prefix}"]
        created.append(docker("run", "-d", "--name", redis_name, *common, "--network-alias", "redis",
                              "--cpus", "1", "--memory", "192m", "--read-only", "--tmpfs", "/data:size=16m", "--user", "redis",
                              "--env", "REDIS_PASSWORD", REDIS_IMAGE, "sh", "-c",
                              'exec redis-server --requirepass "$REDIS_PASSWORD" --save "" --appendonly no --maxmemory 128mb --maxmemory-policy allkeys-lru', env=private))
        route_started = time.perf_counter()
        created.append(docker("run", "-d", "--name", route_name, *common, "--network-alias", "route3",
                              "--cpus", "2", "--memory", "2048m", "--tmpfs", "/graph-pages:size=1024m",
                              "--env", "METRO_DATA_PATH=/srv/metro/moscow.json", "--env", "PYTHONUNBUFFERED=1",
                              "--mount", f"type=bind,source={ROOT / 'services/route-engine3/graphs'},target=/srv/graphs,readonly",
                              "--mount", f"type=bind,source={ROOT / 'core/resources/metro'},target=/srv/metro,readonly", args.route3_image))
        health_script = "import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8124/health',timeout=5))))"
        for _ in range(90):
            raw = docker("exec", route_name, "python3", "-c", health_script, check=False, timeout=15)
            if raw and json.loads(raw).get("ready"):
                manifest["route3_health"] = json.loads(raw)
                break
            time.sleep(2)
        else:
            raise RuntimeError("route-engine3 did not become ready")
        manifest["route3_startup_ms"] = round((time.perf_counter() - route_started) * 1000, 3)
        manifest["route3_ready_resources"] = route_stats(route_name)
        for budget in args.budgets:
            sequence = [(repeat, mode) for repeat in range(1, args.repeats + 1)
                        for mode in (["off", "miss", "hit"] if repeat % 2 else ["miss", "off", "hit"])]
            sequence.append((args.repeats + 1, "outage"))
            for repeat, mode in sequence:
                label = f"{budget}-{repeat}-{mode}"
                print(f"Starting {label}", flush=True)
                before_redis, before_route = redis_stats(redis_name), route_stats(route_name)
                before_log = docker("logs", route_name)
                paused = False
                try:
                    if mode == "outage":
                        docker("pause", redis_name)
                        paused = True
                    docker("run", "--rm", "--name", worker_name, *common, "--cpus", "2", "--memory", "1536m",
                           "--env", "ROUTER_REDIS_URL", "--env", f"ROUTER_REDIS_BETA={'false' if mode == 'off' else 'true'}",
                           "--env", f"ROUTER_REDIS_NAMESPACE={prefix}-{budget}-{repeat}", "--env", "ROUTER_REDIS_TTL_SEC=600",
                           "--env", "ROUTER_HYBRID=1", "--env", "ROUTE3_URL=http://route3:8124", "--env", "ROUTE3_CACHE=/tmp/route3-cache",
                           "--env", "ROUTER_OTEL_ENABLED=false", "--env", "ROUTER_SENTRY_ENABLED=false", "--env", "PYTHONDONTWRITEBYTECODE=1",
                           "--mount", f"type=bind,source={ROOT},target=/work,readonly", "--mount", f"type=bind,source={output},target=/results",
                           "--workdir", "/work", "--entrypoint", "python", args.router_image, "-m", "core.redis_benchmark",
                           "--require-route3", "--budget-ms", str(budget), "--label", label, "--output", f"/results/{label}.json", env=private, timeout=600)
                finally:
                    if paused:
                        docker("unpause", redis_name)
                after_route, after_redis = route_stats(route_name), redis_stats(redis_name)
                route_logs = docker("logs", route_name)[len(before_log):]
                calls = sum('"GET /route3?' in line and ' 200 ' in line for line in route_logs.splitlines())
                trial = json.loads((output / f"{label}.json").read_text(encoding="utf-8"))
                validate_trial(trial, mode)
                if calls < trial["route3"]["verified_legs"]:
                    raise RuntimeError(f"Missing live route3 HTTP calls for {label}: {calls}")
                trials.append(trial)
                manifest["trials"].append({"label": label, "mode": mode, "redis_before": before_redis, "redis_after": after_redis,
                                            "route3_before": before_route, "route3_after": after_route, "route3_http_200": calls})
                save(output / "manifest.json", manifest)
                print(f"Finished {label}: catalog={trial['first_catalog_ms']}ms; route3 calls={calls}; cache={trial['cache']}", flush=True)
        validate_quality(trials)
        manifest["semantic_equality_by_budget"] = True
        manifest["redis_restored"] = redis_stats(redis_name)
        print(f"Verified all {len(trials)} trials; semantic digests match within each budget.", flush=True)
    finally:
        docker("rm", "-f", worker_name, check=False)
        for container in reversed(created):
            docker("rm", "-f", container, check=False)
        if network_created:
            docker("network", "rm", prefix, check=False)
        manifest["cleanup_complete"] = (
            not docker("ps", "-aq", "--filter", f"label=com.docker.compose.project={prefix}")
            and not docker("network", "ls", "-q", "--filter", f"name=^{prefix}$")
        )
        save(output / "manifest.json", manifest)


if __name__ == "__main__":
    main()
