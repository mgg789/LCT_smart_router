"""Single-coordinator latest-wins Runtime with process-isolated solver work."""

import copy
import json
import threading
import time
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from pydantic import ValidationError

from core.contracts import (
    Diagnostic,
    Policy,
    PolicyComparison,
    PolicyComparisonRow,
    RouterResult,
    RouterTaskSnapshot,
    RouterTechnicalSettings,
)
from core.engine import (
    EngineMemory,
    EngineOutput,
    SearchSettings,
    apply_system_policy,
    official_roster,
    solve,
)
from core.evidence import build_plan_evidence
from core.geo import GraphTravel, RoadGraph, configure_travel, content_hash
from core.osrm import OSRMTravel, attach_live_roads
from core.policy import POLICY_CATALOG_VERSION, compile_policy
from core.route_search import improve_routes
from core.schedule import baseline, score, validate_plan
from core.settings import StoredTechnicalSettingsOperation, TechnicalSettingsStore

MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
COMPARISON_POLICY_IDS = ("fast", "compact", "sla", "balanced", "eco")


@dataclass(frozen=True)
class SnapshotPublication:
    """Immutable special-sector row; metadata stays outside the hashed payload."""

    publication_id: str
    publication_seq: int
    payload: bytes
    declared_sha256: str
    published_at: int

    def __post_init__(self) -> None:
        """Verify identity, size and exact-byte SHA-256 before parsing JSON."""
        if not self.publication_id or self.publication_seq < 0 or self.published_at < 0:
            raise ValueError("SNAPSHOT_PUBLICATION_INVALID")
        if len(self.payload) > MAX_SNAPSHOT_BYTES:
            raise ValueError("SNAPSHOT_TOO_LARGE")
        if self.declared_sha256 != content_hash(self.payload):
            raise ValueError("SNAPSHOT_HASH_MISMATCH")


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

    def read(self) -> SnapshotPublication:
        """Read and verify one exact immutable publication."""
        ...


class FileSnapshotReader:
    """Standalone adapter; publishers must replace the file atomically."""

    def __init__(self, path: Path):
        """Keep only the path; every poll reads a fresh publication."""
        self.path = path

    def read(self) -> SnapshotPublication:
        """Read one complete file and derive standalone publication metadata."""
        raw = self.path.read_bytes()
        stat = self.path.stat()
        digest = content_hash(raw)
        return SnapshotPublication(
            publication_id=f"file:{digest}",
            publication_seq=stat.st_mtime_ns,
            payload=raw,
            declared_sha256=digest,
            published_at=int(stat.st_mtime),
        )


class PostgresSnapshotReader:
    """Read-only adapter to the sys-owned ``router_active_snapshot`` view.

    Sys implements this view using its immutable snapshots and active pointer. No
    migrations or writes are performed here; the role must only have SELECT on it.
    """

    def __init__(self, dsn: str):
        """Keep credentials in memory; never include them in diagnostics."""
        self._dsn = dsn

    def read(self) -> SnapshotPublication:
        """Fetch exactly one row in a short, server-enforced read-only transaction."""
        import psycopg

        with psycopg.connect(
            self._dsn,
            connect_timeout=3,
            options="-c default_transaction_read_only=on -c statement_timeout=3000",
        ) as connection:
            rows = connection.execute(
                "SELECT publication_id, publication_seq, payload_utf8, payload_sha256, "
                "published_at_epoch FROM router_active_snapshot"
            ).fetchmany(2)
        if len(rows) != 1:
            raise ValueError("SNAPSHOT_VIEW_INVALID: expected exactly one publication")
        publication_id, publication_seq, payload, digest, published_at = rows[0]
        if not isinstance(payload, str):
            raise ValueError("SNAPSHOT_VIEW_INVALID: payload_utf8 must be text")
        return SnapshotPublication(
            publication_id=str(publication_id),
            publication_seq=int(publication_seq),
            payload=payload.encode("utf-8"),
            declared_sha256=str(digest),
            published_at=int(published_at),
        )


def calculate(
    raw: bytes,
    graph: RoadGraph | OSRMTravel,
    settings: SearchSettings,
    context_version: str,
    memory: EngineMemory | None = None,
    publication_id: str | None = None,
) -> tuple[RouterResult, EngineOutput | None]:
    """Worker entry point: one immutable input/context pair yields both plans."""
    if len(raw) > MAX_SNAPSHOT_BYTES:
        return RouterResult(
            status="error",
            input_publication_id=publication_id,
            input_hash=content_hash(raw),
            router_context_version=context_version,
            errors=[Diagnostic(code="INPUT_TOO_LARGE", message="Snapshot exceeds size limit.")],
        ), None
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
            input_publication_id=publication_id,
            input_hash=content_hash(raw),
            router_context_version=context_version,
            errors=errors,
        ), None
    except (ValueError, UnicodeError) as exc:
        return RouterResult(
            status="error",
            input_publication_id=publication_id,
            input_hash=content_hash(raw),
            router_context_version=context_version,
            errors=[Diagnostic(code="INPUT_INVALID", message=str(exc))],
        ), None
    provider = GraphTravel(graph) if isinstance(graph, RoadGraph) else graph
    provider = attach_live_roads(provider)
    provider = configure_travel(provider, settings.technical(), snapshot.planning_as_of)
    try:
        output = solve(snapshot, provider, settings, memory, context_version)
        effective_snapshot = output.memory.snapshot
        main_evidence = build_plan_evidence(effective_snapshot, output.main, provider)
        baseline_evidence = build_plan_evidence(effective_snapshot, output.baseline, provider)
    except Exception as exc:
        return RouterResult(
            status="error",
            input_publication_id=publication_id,
            input_hash=content_hash(raw),
            planning_as_of=snapshot.planning_as_of,
            computed_at=int(time.time()),
            router_context_version=context_version,
            policy_id=snapshot.policy.policy_id,
            technical_settings=settings.technical(),
            errors=[Diagnostic(code="CALCULATION_FAILED", message=type(exc).__name__)],
        ), None
    result = RouterResult(
        status="ready",
        result_id=str(uuid4()),
        input_publication_id=publication_id,
        input_hash=content_hash(raw),
        planning_as_of=snapshot.planning_as_of,
        computed_at=int(time.time()),
        router_context_version=context_version,
        policy_id=effective_snapshot.policy.policy_id,
        technical_settings=settings.technical(),
        search_path=output.path,
        policy_criteria=list(compile_policy(effective_snapshot.policy).ordered_criteria),
        main=output.main,
        baseline=output.baseline,
        main_evidence=main_evidence,
        baseline_evidence=baseline_evidence,
    )
    return result, output


def calculate_policy_comparison(
    raw: bytes,
    publication_id: str,
    graph: RoadGraph | OSRMTravel,
    settings: SearchSettings,
    context_version: str,
    search_budget_ms: int = 8000,
    *,
    offline: bool = False,
) -> PolicyComparison:
    """Calculate all catalog policies and FIFO on one immutable snapshot.

    The function is intentionally independent from Runtime memory: every policy
    gets the same cold-start snapshot and bounded budget, and no candidate can
    affect the active plan or the next replanning anchor.
    """
    if not 1 <= search_budget_ms <= 8000:
        raise ValueError("COMPARISON_BUDGET_INVALID")
    snapshot = apply_system_policy(official_roster(parse_snapshot(raw)), settings)
    provider = GraphTravel(graph) if isinstance(graph, RoadGraph) else graph
    if not offline:
        provider = attach_live_roads(provider)
    provider = configure_travel(provider, settings.technical(), snapshot.planning_as_of)
    comparison_settings = replace(
        settings,
        time_limit_ms=search_budget_ms,
        # A 64-solution cap returns the FIFO seed in tens of milliseconds and
        # makes every preset look identical. Comparison is bounded by time.
        solution_limit=max(settings.solution_limit, 10_000),
    )
    rows: list[PolicyComparisonRow] = []

    started = time.monotonic()
    fifo = baseline(snapshot, provider)
    validate_plan(snapshot, fifo, provider)
    baseline_row = PolicyComparisonRow(
        strategy_id="baseline",
        kind="baseline",
        is_usable=fifo.is_usable,
        calculation_ms=max(0, round((time.monotonic() - started) * 1000)),
        summary=fifo.summary,
    )
    candidates = [fifo]
    for policy_id in COMPARISON_POLICY_IDS:
        candidate_snapshot = snapshot.model_copy(
            update={"policy": Policy(policy_id=policy_id, parameters={})}
        )
        started = time.monotonic()
        output = solve(
            candidate_snapshot,
            provider,
            comparison_settings,
            memory=None,
            context_version=context_version,
        )
        if output.main.is_usable:
            candidates.append(output.main)
        rows.append(
            PolicyComparisonRow(
                strategy_id=policy_id,
                kind="policy",
                is_usable=output.main.is_usable,
                calculation_ms=max(0, round((time.monotonic() - started) * 1000)),
                summary=output.main.summary,
            )
        )
    # Refine each objective from the common coverage frontier, rather than letting
    # independently weaker coverage hide all resource-policy differences.
    shared = list(candidates)
    for policy_id in COMPARISON_POLICY_IDS:
        candidate_snapshot = snapshot.model_copy(
            update={"policy": Policy(policy_id=policy_id, parameters={})}
        )
        started = time.monotonic()
        candidates.extend(
            improve_routes(candidate_snapshot, provider, shared, search_budget_ms, construct=False)
        )
        index = next(i for i, row in enumerate(rows) if row.strategy_id == policy_id)
        rows[index] = rows[index].model_copy(
            update={
                "calculation_ms": rows[index].calculation_ms
                + round((time.monotonic() - started) * 1000)
            }
        )
    # Each strategy selects from the same immutable, validated candidate portfolio.
    # FIFO is never optimized, replaced, or supplied with additional engineers.
    for index, row in enumerate(rows):
        candidate_snapshot = snapshot.model_copy(
            update={"policy": Policy(policy_id=row.strategy_id, parameters={})}
        )
        best = min(candidates, key=lambda plan: score(candidate_snapshot, plan))
        rows[index] = row.model_copy(update={"is_usable": best.is_usable, "summary": best.summary})
    # Expanded-workforce plans must never enter the fixed-roster candidate pool.
    started = time.monotonic()
    covering = solve(
        snapshot.model_copy(update={"policy": Policy(policy_id="covering", parameters={})}),
        provider,
        comparison_settings,
        memory=None,
        context_version=context_version,
    )
    rows.append(
        PolicyComparisonRow(
            strategy_id="covering",
            kind="policy",
            additional_engineers=sum(
                route.engineer_id.startswith("covering-") and route.metrics.assigned_count > 0
                for route in covering.main.routes
            ),
            is_usable=covering.main.is_usable,
            calculation_ms=round((time.monotonic() - started) * 1000),
            summary=covering.main.summary,
        )
    )
    rows.append(baseline_row)
    return PolicyComparison(
        input_publication_id=publication_id,
        input_hash=content_hash(raw),
        router_context_version=context_version,
        computed_at=int(time.time()),
        search_budget_ms=search_budget_ms,
        rows=rows,
    )


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
        settings_store: TechnicalSettingsStore | None = None,
    ):
        """Own immutable resource copies; injectable executor supports race tests."""
        if poll_sec <= 0:
            raise ValueError("poll interval must be positive")
        self.reader = reader
        self._graph = copy.deepcopy(graph)
        self._settings_store = settings_store
        self.settings = settings or SearchSettings()
        saved = settings_store.load() if settings_store is not None else None
        if saved is not None:
            self.settings = replace(
                self.settings,
                lunches_enabled=saved.lunches_enabled,
                traffic_enabled=saved.traffic_enabled,
                equipment_enabled=saved.equipment_enabled,
                window_lateness_tolerance_sec=saved.window_lateness_tolerance_sec,
                departure_lateness_tolerance_sec=saved.departure_lateness_tolerance_sec,
                task_start_lateness_tolerance_sec=saved.task_start_lateness_tolerance_sec,
                travel_time_mode=saved.travel_time_mode,
                access_buffer_sec=saved.access_buffer_sec,
                fixed_travel_time_sec=saved.fixed_travel_time_sec,
                early_finish_replan_threshold_sec=saved.early_finish_replan_threshold_sec,
                task_overrun_tolerance_sec=saved.task_overrun_tolerance_sec,
            )
        self.poll_sec = poll_sec
        self._lock = threading.RLock()
        self._executor = executor or ProcessPoolExecutor(max_workers=1)
        self._future: Future | None = None
        self._active_generation = -1
        self._generation = 0
        self._key = None
        self._pending: bytes | None = None
        self._pending_publication_id: str | None = None
        self._last_publication_seq = -1
        self._memory: EngineMemory | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._operations = settings_store.load_operations() if settings_store is not None else {}
        self._comparison_cache: dict[tuple[str, str], PolicyComparison] = {}
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
        data = [
            "router-v2",
            POLICY_CATALOG_VERSION,
            resource,
            {
                "time_limit_ms": self.settings.time_limit_ms,
                "solution_limit": self.settings.solution_limit,
                "technical_settings": self.settings.technical().model_dump(),
            },
        ]
        return content_hash(json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8"))

    def read_result(self) -> RouterResult:
        """Return an isolated copy so callers cannot mutate published plans."""
        with self._lock:
            return self.result.model_copy(deep=True)

    def evaluate_manual(self, input_hash: str, context_version: str, routes: dict) -> dict:
        """Evaluate fixed orders against the current automatic result, without solving.

        Publication and context are checked before and after calculation so sys cannot
        attach an evaluation to another manual revision or changed resource set.
        """
        from core.manual_evaluation import evaluate_manual

        publication = self.reader.read()
        raw = publication if isinstance(publication, bytes) else publication.payload
        with self._lock:
            active = self.result.model_copy(deep=True)
            if (
                content_hash(raw) != input_hash
                or active.input_hash != input_hash
                or self.context_version != context_version
                or active.router_context_version != context_version
                or active.status != "ready"
                or active.main is None
                or not active.main.is_usable
            ):
                raise ValueError("PUBLICATION_CHANGED")
            graph, settings = copy.deepcopy(self._graph), copy.deepcopy(self.settings)
        snapshot = apply_system_policy(parse_snapshot(raw), settings)
        provider = GraphTravel(graph) if isinstance(graph, RoadGraph) else graph
        provider = attach_live_roads(provider)
        provider = configure_travel(provider, settings.technical(), snapshot.planning_as_of)
        result = evaluate_manual(snapshot, provider, active.main, routes)
        latest = self.reader.read()
        latest_raw = latest if isinstance(latest, bytes) else latest.payload
        with self._lock:
            if content_hash(latest_raw) != input_hash or self.context_version != context_version:
                raise ValueError("PUBLICATION_CHANGED")
        return {"input_hash": input_hash, "router_context_version": context_version, **result}

    def propose_window(
        self, snapshot: RouterTaskSnapshot, request_id: str, routes: dict, day_end_at: int
    ) -> dict:
        """Preview on fresh sys facts with current travel resources; never mutate runtime."""
        from core.window_proposal import propose_window

        with self._lock:
            graph, settings = copy.deepcopy(self._graph), copy.deepcopy(self.settings)
            version = self.context_version
        task = apply_system_policy(snapshot, settings)
        provider = GraphTravel(graph) if isinstance(graph, RoadGraph) else graph
        provider = configure_travel(
            attach_live_roads(provider), settings.technical(), task.planning_as_of
        )
        result = propose_window(task, provider, request_id, routes, day_end_at)
        with self._lock:
            if version != self.context_version:
                raise ValueError("CONTEXT_CHANGED")
        return result

    def compare_policies(self, search_budget_ms: int | None = None) -> PolicyComparison:
        """Compare seven strategies on the ready publication without mutating Runtime."""
        if search_budget_ms is not None and not 1 <= search_budget_ms <= 8000:
            raise ValueError("COMPARISON_BUDGET_INVALID")
        try:
            publication = self.reader.read()
        except Exception as exc:
            raise RuntimeError("ACTIVE_PUBLICATION_UNAVAILABLE") from exc
        if isinstance(publication, bytes):
            digest = content_hash(publication)
            publication = SnapshotPublication(
                publication_id=f"legacy:{digest}",
                publication_seq=0,
                payload=publication,
                declared_sha256=digest,
                published_at=int(time.time()),
            )
        digest = content_hash(publication.payload)
        with self._lock:
            active = self.result.model_copy(deep=True)
            context_version = self.context_version
            if (
                active.status != "ready"
                or active.input_publication_id is None
                or active.input_hash is None
            ):
                raise RuntimeError("ACTIVE_PUBLICATION_UNAVAILABLE")
            if (
                active.input_publication_id != publication.publication_id
                or active.input_hash != digest
                or active.router_context_version != context_version
            ):
                raise ValueError("PUBLICATION_CHANGED")
            key = (digest, context_version)
            graph = copy.deepcopy(self._graph)
            settings = copy.deepcopy(self.settings)
            effective_budget_ms = search_budget_ms or min(settings.time_limit_ms, 8000)
            cached = self._comparison_cache.get(key)
            if cached is not None and cached.search_budget_ms == effective_budget_ms:
                return cached.model_copy(deep=True)
        comparison = calculate_policy_comparison(
            publication.payload,
            publication.publication_id,
            graph,
            settings,
            context_version,
            effective_budget_ms,
        )
        try:
            latest = self.reader.read()
        except Exception as exc:
            raise RuntimeError("ACTIVE_PUBLICATION_UNAVAILABLE") from exc
        if isinstance(latest, bytes):
            latest_digest = content_hash(latest)
            latest_id = f"legacy:{latest_digest}"
        else:
            latest_digest = content_hash(latest.payload)
            latest_id = latest.publication_id
        with self._lock:
            active = self.result
            if (
                latest_id != publication.publication_id
                or latest_digest != digest
                or active.status != "ready"
                or active.input_publication_id != publication.publication_id
                or active.input_hash != digest
                or active.router_context_version != context_version
                or self.context_version != context_version
            ):
                raise ValueError("PUBLICATION_CHANGED")
            self._comparison_cache[key] = comparison
            return comparison.model_copy(deep=True)

    def state(self) -> dict:
        """Expose service state separately from an older result's context version."""
        with self._lock:
            return {
                "router_context_version": self.context_version,
                "generation": self._generation,
                "status": self.result.status,
                "active": self._future is not None,
                "engine_path": self.last_path,
                "technical_settings": self.settings.technical().model_dump(),
            }

    def _invalidate(self):
        self._generation += 1
        self._key = None
        self._pending = None
        self._pending_publication_id = None
        self.last_path = None
        self._comparison_cache.clear()
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
        """Keep the v1 operation as an alias for departure-lateness tolerance."""
        current = self.settings.technical()
        return self.set_technical_settings(
            operation_id,
            current.model_copy(update={"departure_lateness_tolerance_sec": tolerance_sec}),
            expected_context_version,
        )

    def set_technical_settings(
        self,
        operation_id: str,
        requested: RouterTechnicalSettings,
        expected_context_version: str,
    ) -> dict:
        """Persist and activate all Router-owned controls with CAS and idempotency."""
        with self._lock:
            previous = self._operations.get(operation_id)
            if previous:
                if (
                    previous.requested != requested
                    or previous.expected_context_version != expected_context_version
                ):
                    raise ValueError("OPERATION_CONFLICT")
                return dict(previous.response)
            if expected_context_version != self.context_version:
                raise ValueError("CONTEXT_CONFLICT")
            if self._settings_store is None:
                raise ValueError("SETTINGS_STORE_UNAVAILABLE")
            updated_settings = replace(
                self.settings,
                lunches_enabled=requested.lunches_enabled,
                traffic_enabled=requested.traffic_enabled,
                equipment_enabled=requested.equipment_enabled,
                window_lateness_tolerance_sec=requested.window_lateness_tolerance_sec,
                departure_lateness_tolerance_sec=requested.departure_lateness_tolerance_sec,
                task_start_lateness_tolerance_sec=requested.task_start_lateness_tolerance_sec,
                travel_time_mode=requested.travel_time_mode,
                access_buffer_sec=requested.access_buffer_sec,
                fixed_travel_time_sec=requested.fixed_travel_time_sec,
                early_finish_replan_threshold_sec=requested.early_finish_replan_threshold_sec,
                task_overrun_tolerance_sec=requested.task_overrun_tolerance_sec,
            )
            previous_settings = self.settings
            self.settings = updated_settings
            response = {
                "operation_id": operation_id,
                "status": "accepted",
                "technical_settings": requested.model_dump(),
                "router_context_version": self.context_version,
            }
            operation = StoredTechnicalSettingsOperation(
                requested=requested,
                expected_context_version=expected_context_version,
                response=response,
            )
            try:
                self._settings_store.save_operation(requested, operation_id, operation)
            except Exception:
                self.settings = previous_settings
                raise
            self._operations[operation_id] = operation
            self._invalidate()
            return dict(response)

    def tick(self) -> None:
        """Poll input, discard superseded completion and submit at most one calculation."""
        try:
            publication = self.reader.read()
            if isinstance(publication, bytes):
                digest = content_hash(publication)
                publication = SnapshotPublication(
                    publication_id=f"legacy:{digest}",
                    publication_seq=self._last_publication_seq + 1,
                    payload=publication,
                    declared_sha256=digest,
                    published_at=int(time.time()),
                )
            raw = publication.payload
        except Exception as exc:
            reported_code = str(exc).split(":", 1)[0]
            if not reported_code.startswith("SNAPSHOT_"):
                reported_code = "SNAPSHOT_READ_FAILED"
            with self._lock:
                self._invalidate()
                self.result = RouterResult(
                    status="error",
                    router_context_version=self.context_version,
                    errors=[
                        Diagnostic(
                            code=reported_code,
                            message="Cannot accept the published snapshot.",
                        )
                    ],
                )
                if self._future is not None and self._future.done():
                    self._future = None
            return
        with self._lock:
            if publication.publication_seq < self._last_publication_seq:
                self._invalidate()
                self.result = RouterResult(
                    status="error",
                    input_publication_id=publication.publication_id,
                    router_context_version=self.context_version,
                    errors=[
                        Diagnostic(
                            code="SNAPSHOT_ROLLBACK",
                            message="Active publication sequence moved backwards.",
                        )
                    ],
                )
                return
            self._last_publication_seq = publication.publication_seq
            key = (content_hash(raw), self.context_version)
            if key != self._key:
                self._generation += 1
                self._key = key
                self._pending = raw
                self._pending_publication_id = publication.publication_id
                self.result = RouterResult(
                    status="pending",
                    input_publication_id=publication.publication_id,
                    input_hash=key[0],
                    router_context_version=key[1],
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
                        calculate,
                        self._pending,
                        self._graph,
                        self.settings,
                        key[1],
                        self._memory,
                        self._pending_publication_id,
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
                self._pending_publication_id = None

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
