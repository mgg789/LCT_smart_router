"""Graph discovery and osrm-routed supervision for route-engine3.

A graph is one subdirectory of the graphs root containing an OSRM page family
(``*.osrm`` base and/or its ``*.osrm.*`` companion pages) and an optional
``graph.json`` metadata file::

    {
        "graph_id": "car",
        "profile": "car",
        "map_version": "moscow-mkad-v1",
        "max_table_size": 4096,
        "speeds_kmh": {"walk": 5.0, "bike": 15.0}
    }

``graph_id`` defaults to the directory name. ``profile`` defaults to ``foot``
when the id mentions foot/walk/bike, else ``car``; the profile decides which
graph serves a query: car queries go to the first graph with profile ``car``,
walk/bike/transit queries go to the first graph with profile ``foot``.

Dropping a new folder into the graphs root and calling :meth:`GraphSupervisor.reload`
is enough to serve a new graph — no service code changes.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

FOOT_PROFILE_IDS = ("foot", "walk", "bike", "pedestrian")
DEFAULT_SPEEDS_KMH = {"walk": 5.0, "bike": 15.0}


@dataclass(frozen=True)
class GraphSpec:
    """One discovered OSRM graph folder and its declared capabilities.

    base_file is the dataset prefix handed to osrm-routed; the ``.osrm`` base
    file itself may be absent — MLD graphs consist purely of companion pages.
    """

    graph_id: str
    directory: Path
    base_file: Path
    profile: str  # "car" or "foot"
    map_version: str
    max_table_size: int
    speeds_kmh: dict[str, float]


@dataclass
class GraphRuntime:
    """One graph plus its supervised osrm-routed child process."""

    spec: GraphSpec
    port: int
    process: subprocess.Popen | None = None
    healthy: bool = False
    restarts: int = 0
    last_error: str | None = None
    stop_event: threading.Event = field(default_factory=threading.Event)


def discover_graphs(root: Path) -> list[GraphSpec]:
    """Scan the graphs root; one subdirectory with one *.osrm base is one graph.

    Missing or malformed graph.json degrades to directory-name defaults instead
    of failing the whole service: a broken optional meta file must not take the
    engine down.
    """
    specs: list[GraphSpec] = []
    if not root.is_dir():
        return specs
    for directory in sorted(p for p in root.iterdir() if p.is_dir()):
        # osrm-routed takes the dataset PREFIX, not a required base file: an
        # MLD graph directory carries only *.osrm.* companion pages, so derive
        # the prefix from whichever page is present.
        pages = sorted(path for path in directory.glob("*.osrm*") if path.is_file())
        if not pages:
            continue
        first = pages[0].name
        stem = first.split(".osrm.")[0] if ".osrm." in first else first[: -len(".osrm")]
        base_file = directory / f"{stem}.osrm"
        meta: dict = {}
        meta_path = directory / "graph.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if not isinstance(meta, dict):
                    meta = {}
            except (json.JSONDecodeError, OSError):
                meta = {}
        graph_id = str(meta.get("graph_id") or directory.name)
        declared = meta.get("profile")
        if declared in ("car", "foot"):
            profile = declared
        elif any(token in graph_id.lower() for token in FOOT_PROFILE_IDS):
            profile = "foot"
        else:
            profile = "car"
        speeds = meta.get("speeds_kmh")
        speeds_kmh = {
            key: float(speeds[key])
            for key in ("walk", "bike")
            if isinstance(speeds, dict)
            and isinstance(speeds.get(key), (int, float))
            and speeds[key] > 0
        }
        speeds_kmh = {**DEFAULT_SPEEDS_KMH, **speeds_kmh}
        specs.append(
            GraphSpec(
                graph_id=graph_id,
                directory=directory,
                base_file=base_file,
                profile=profile,
                map_version=str(meta.get("map_version") or directory.name),
                max_table_size=int(meta.get("max_table_size") or 4096),
                speeds_kmh=speeds_kmh,
            )
        )
    return specs


def probe_osrm(port: int, timeout: float = 1.0) -> bool:
    """True when an osrm-routed answers on the loopback port.

    The root path answers 404 — any HTTP response at all, error statuses
    included, means the child is alive and serving.
    """
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/", timeout=timeout
        ) as response:
            return response.status < 500
    except urllib.error.HTTPError:
        return True
    except (urllib.error.URLError, OSError):
        return False


class GraphSupervisor:
    """Start one osrm-routed per graph, keep them alive, route by profile.

    The runner and prober are injectable so tests can fake child processes
    without spawning real osrm-routed instances.
    """

    def __init__(
        self,
        specs: list[GraphSpec],
        *,
        base_port: int = 5300,
        page_dir: str | None = None,
        osrm_routed: str = "osrm-routed",
        runner=None,
        prober=probe_osrm,
    ):
        self._specs = specs
        self._base_port = base_port
        self._page_dir = Path(page_dir) if page_dir else None
        self._osrm_routed = osrm_routed
        self._runner = runner or self._spawn
        self._prober = prober
        self.runtimes: dict[str, GraphRuntime] = {}
        self._threads: list[threading.Thread] = []
        self._lock = threading.Lock()

    def graph_for(self, profile: str) -> GraphRuntime | None:
        """Resolve a Transport profile to its graph: car vs walk/bike/transit.

        When several graphs share the profile, the one whose graph_id equals
        the profile name wins (graphs/foot over graphs/foot-alt), then the
        first in discovery order.
        """
        wanted = "car" if profile == "car" else "foot"
        with self._lock:
            for runtime in self.runtimes.values():
                if runtime.spec.profile == wanted and runtime.spec.graph_id == wanted:
                    return runtime
            for runtime in self.runtimes.values():
                if runtime.spec.profile == wanted:
                    return runtime
        return None

    def snapshot(self) -> list[dict]:
        """Public graph status for /graphs and /health."""
        with self._lock:
            return [
                {
                    "graph_id": runtime.spec.graph_id,
                    "profile": runtime.spec.profile,
                    "map_version": runtime.spec.map_version,
                    "max_table_size": runtime.spec.max_table_size,
                    "base_file": runtime.spec.base_file.name,
                    "port": runtime.port,
                    "healthy": runtime.healthy,
                    "restarts": runtime.restarts,
                    "last_error": runtime.last_error,
                }
                for runtime in self.runtimes.values()
            ]

    def start(self) -> None:
        """Page graphs in, spawn children, launch one watchdog thread each."""
        for index, spec in enumerate(self._specs):
            port = self._base_port + index
            runtime = GraphRuntime(spec=spec, port=port)
            self.runtimes[spec.graph_id] = runtime
            thread = threading.Thread(target=self._watch, args=(runtime,), daemon=True)
            self._threads.append(thread)
            thread.start()

    def stop(self) -> None:
        """Terminate every child and stop the watchdogs."""
        with self._lock:
            runtimes = list(self.runtimes.values())
        for runtime in runtimes:
            runtime.stop_event.set()
            self._terminate(runtime)

    def _watch(self, runtime: GraphRuntime) -> None:
        """Restart the child when it dies; refresh health between probes."""
        while not runtime.stop_event.is_set():
            if runtime.process is None or runtime.process.poll() is not None:
                self._terminate(runtime)
                try:
                    runtime.process = self._runner(runtime)
                    runtime.last_error = None
                except (OSError, ValueError) as error:
                    runtime.last_error = str(error)
                    runtime.healthy = False
                    runtime.stop_event.wait(5.0)
                    continue
            runtime.healthy = self._prober(runtime.port)
            runtime.stop_event.wait(2.0 if runtime.healthy else 1.0)

    def _spawn(self, runtime: GraphRuntime) -> subprocess.Popen:
        """Page the graph into tmpfs when configured, then launch osrm-routed."""
        served = runtime.spec.directory
        if self._page_dir:
            paged = self._page_graph(runtime.spec)
            if paged is not None:
                served = paged
        command = [
            self._osrm_routed,
            "--algorithm",
            "mld",
            "--max-table-size",
            str(runtime.spec.max_table_size),
            "--port",
            str(runtime.port),
            str(served / runtime.spec.base_file.name),
        ]
        return subprocess.Popen(
            command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=False
        )

    def _page_graph(self, spec: GraphSpec) -> Path | None:
        """Copy graph pages into the fast directory; None when that fails."""
        target = self._page_dir / spec.graph_id
        try:
            if not (target / spec.base_file.name).exists():
                target.mkdir(parents=True, exist_ok=True)
                for page in spec.directory.glob(f"{spec.base_file.name}*"):
                    shutil.copy2(page, target / page.name)
            return target
        except OSError:
            return None

    def _terminate(self, runtime: GraphRuntime) -> None:
        process = runtime.process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                process.kill()
            runtime.restarts += 1
        runtime.process = None
