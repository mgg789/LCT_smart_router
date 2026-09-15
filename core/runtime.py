"""Single-coordinator latest-wins Runtime with process-isolated solver work."""

import copy
import json
import threading
import time
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import asdict, replace
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from pydantic import ValidationError

from core.contracts import Diagnostic, RouterResult, RouterTaskSnapshot
from core.engine import EngineMemory, EngineOutput, SearchSettings, solve
from core.geo import GraphTravel, RoadGraph, content_hash
from core.osrm import OSRMTravel


def parse_snapshot(raw: bytes) -> RouterTaskSnapshot:
    """Validate UTF-8 and reject ambiguous duplicate JSON keys before Pydantic."""

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    return RouterTaskSnapshot.model_validate(
        json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    )


class SnapshotReader(Protocol):
    """Adapter for an atomically published byte document, not live business rows."""

    def read(self) -> bytes:
        """Read the exact persisted UTF-8 JSON bytes."""
        ...


class FileSnapshotReader:
    """Standalone adapter; publishers must replace the file atomically."""

    def __init__(self, path: Path):
        """Keep only the path; every poll reads a fresh publication."""
        self.path = path

    def read(self) -> bytes:
        """Read one complete file; malformed partial publications remain errors."""
        return self.path.read_bytes()


class PostgresSnapshotReader:
    """Read-only adapter to a sys-owned view: router_active_snapshot(payload_utf8 text).

    Sys implements this view using its immutable snapshots and active pointer. No
    migrations or writes are performed here; the role must only have SELECT on it.
    """

    def __init__(self, dsn: str):
        """Keep credentials in memory; never include them in diagnostics."""
        self._dsn = dsn

    def read(self) -> bytes:
        """Fetch exactly one row in a short, server-enforced read-only transaction."""
        import psycopg

        with psycopg.connect(
            self._dsn,
            connect_timeout=3,
            options="-c default_transaction_read_only=on -c statement_timeout=3000",
        ) as connection:
            rows = connection.execute("SELECT payload_utf8 FROM router_active_snapshot").fetchmany(
                2
            )
        if len(rows) != 1 or not isinstance(rows[0][0], str):
            raise ValueError("SNAPSHOT_VIEW_INVALID: expected exactly one text payload")
        return rows[0][0].encode("utf-8")


def calculate(
    raw: bytes,
    graph: RoadGraph | OSRMTravel,
    settings: SearchSettings,
    context_version: str,
    memory: EngineMemory | None = None,
) -> tuple[RouterResult, EngineOutput | None]:
    """Worker entry point: one immutable input/context pair yields both plans."""
    try:
        snapshot = parse_snapshot(raw)
    except ValidationError as exc:
        errors = [
            Diagnostic(
                code="INPUT_INVALID",
                message=item["msg"],
                field_path=".".join(str(x) for x in item["loc"]),
            )
            for item in exc.errors(include_input=False, include_url=False)
        ]
        return RouterResult(
            status="error",
            input_hash=content_hash(raw),
            router_context_version=context_version,
            errors=errors,
        ), None
    except (ValueError, UnicodeError) as exc:
        return RouterResult(
            status="error",
            input_hash=content_hash(raw),
            router_context_version=context_version,
            errors=[Diagnostic(code="INPUT_INVALID", message=str(exc))],
        ), None
    provider = GraphTravel(graph) if isinstance(graph, RoadGraph) else graph
    output = solve(snapshot, provider, settings, memory, context_version)
    result = RouterResult(
        status="ready",
        result_id=str(uuid4()),
        input_hash=content_hash(raw),
        planning_as_of=snapshot.planning_as_of,
        computed_at=int(time.time()),
        router_context_version=context_version,
        main=output.main,
        baseline=output.baseline,
    )
    return result, output


class RouterRuntime:
    """One active worker plus one replaceable pending snapshot; no stale publication.

    Worker shutdown waits for the bounded calculation. Changes coalesce instead of
    building an unbounded queue; CPU work never runs on the HTTP/event-loop thread.
    """

    def __init__(
        self,
        reader: SnapshotReader,
        graph: RoadGraph | OSRMTravel,
        settings: SearchSettings | None = None,
        poll_sec: float = 0.2,
        executor=None,
    ):
        """Own immutable resource copies; injectable executor supports race tests."""
        if poll_sec <= 0:
            raise ValueError("poll interval must be positive")
        self.reader = reader
        self._graph = copy.deepcopy(graph)
        self.settings = settings or SearchSettings()
        self.poll_sec = poll_sec
        self._lock = threading.RLock()
        self._executor = executor or ProcessPoolExecutor(max_workers=1)
        self._future: Future | None = None
        self._active_generation = -1
        self._generation = 0
        self._key = None
        self._pending: bytes | None = None
        self._memory: EngineMemory | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._operations: dict[str, tuple[int, str, dict]] = {}
        self.result = RouterResult(status="pending", router_context_version=self.context_version)
        self.last_path: str | None = None

    @property
    def context_version(self) -> str:
        """Content-derived version covers graph, policy/compiler and all search settings."""
        resource = (
            self._graph.model_dump(mode="json")
            if isinstance(self._graph, RoadGraph)
            else self._graph.version
        )
        data = ["router-v1:fast-1", resource, asdict(self.settings)]
        return content_hash(json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8"))

    def read_result(self) -> RouterResult:
        """Return an isolated copy so callers cannot mutate published plans."""
        with self._lock:
            return self.result.model_copy(deep=True)

    def state(self) -> dict:
        """Expose service state separately from an older result's context version."""
        with self._lock:
            return {
                "router_context_version": self.context_version,
                "generation": self._generation,
                "status": self.result.status,
                "active": self._future is not None,
                "engine_path": self.last_path,
                "tolerance_sec": self.settings.tolerance_sec,
            }

    def _invalidate(self):
        self._generation += 1
        self._key = None
        self._pending = None
        self.result = RouterResult(status="pending", router_context_version=self.context_version)

    def update_graph(self, graph: RoadGraph) -> None:
        """Activate a validated resource atomically; old workers keep their own graph."""
        with self._lock:
            if graph != self._graph:
                self._graph = graph.model_copy(deep=True)
                self._invalidate()

    def set_tolerance(
        self, operation_id: str, tolerance_sec: int, expected_context_version: str
    ) -> dict:
        """CAS and idempotency for the sole mutable technical setting; no route commands.

        V1 operations are process-local: restarts restore configured startup settings and
        new context. Sys must reread /context after reconnecting, never assume persistence.
        """
        with self._lock:
            previous = self._operations.get(operation_id)
            if previous:
                if previous[:2] != (tolerance_sec, expected_context_version):
                    raise ValueError("OPERATION_CONFLICT")
                return dict(previous[2])
            if expected_context_version != self.context_version:
                raise ValueError("CONTEXT_CONFLICT")
            self.settings = replace(self.settings, tolerance_sec=tolerance_sec)
            self._invalidate()
            response = {
                "operation_id": operation_id,
                "status": "accepted",
                "tolerance_sec": tolerance_sec,
                "router_context_version": self.context_version,
            }
            self._operations[operation_id] = (tolerance_sec, expected_context_version, response)
            return dict(response)

    def tick(self) -> None:
        """Poll input, discard superseded completion and submit at most one calculation."""
        try:
            raw = self.reader.read()
        except Exception:
            with self._lock:
                self._invalidate()
                self.result = RouterResult(
                    status="error",
                    router_context_version=self.context_version,
                    errors=[
                        Diagnostic(
                            code="SNAPSHOT_READ_FAILED", message="Cannot read published snapshot."
                        )
                    ],
                )
                if self._future is not None and self._future.done():
                    self._future = None
            return
        with self._lock:
            key = (content_hash(raw), self.context_version)
            if key != self._key:
                self._generation += 1
                self._key = key
                self._pending = raw
                self.result = RouterResult(
                    status="pending", input_hash=key[0], router_context_version=key[1]
                )
            if self._future is not None and self._future.done():
                try:
                    result, output = self._future.result()
                    if self._active_generation == self._generation:
                        self.result = result
                        if output is not None:
                            self._memory, self.last_path = output.memory, output.path
                except Exception as exc:
                    if self._active_generation == self._generation:
                        # Inputs carry no credentials; suppress third-party connection diagnostics.
                        self.result = RouterResult(
                            status="error",
                            input_hash=key[0],
                            router_context_version=key[1],
                            errors=[
                                Diagnostic(code="CALCULATION_FAILED", message=type(exc).__name__)
                            ],
                        )
                finally:
                    self._future = None
            if self._future is None and self._pending is not None:
                self._active_generation = self._generation
                try:
                    self._future = self._executor.submit(
                        calculate, self._pending, self._graph, self.settings, key[1], self._memory
                    )
                except Exception:
                    self.result = RouterResult(
                        status="error",
                        input_hash=key[0],
                        router_context_version=key[1],
                        errors=[
                            Diagnostic(
                                code="WORKER_UNAVAILABLE",
                                message="Cannot start calculation worker.",
                            )
                        ],
                    )
                self._pending = None

    def start(self) -> None:
        """Start exactly one polling thread; repeated calls do not spawn coordinators."""
        with self._lock:
            if self._thread is not None:
                return

            def loop():
                while not self._stop.is_set():
                    self.tick()
                    self._stop.wait(self.poll_sec)

            self._thread = threading.Thread(target=loop, name="router-coordinator", daemon=True)
            self._thread.start()

    def close(self) -> None:
        """Stop polling and join bounded worker jobs, without terminating unrelated processes."""
        self._stop.set()
        if self._thread:
            self._thread.join()
        self._executor.shutdown(wait=True, cancel_futures=True)
