"""Single-coordinator latest-wins Runtime with process-isolated solver work."""

import copy
import json
import os
import threading
import time
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from pydantic import ValidationError

from core.catalog_cache import configured_catalog_cache
from core.contracts import (
    Diagnostic,
    Plan,
    PlanEvidence,
    Policy,
    PolicyComparison,
    PolicyComparisonRow,
    RegionalProgress,
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
from core.geo import GraphTravel, RoadGraph, TravelSource, content_hash
from core.osrm import OSRMTravel
from core.planning_travel import planning_configuration, planning_travel
from core.policy import POLICY_CATALOG_VERSION, compile_policy
from core.predict_calibration import (
    PredictCalibration,
    PredictCalibrationStore,
    WeatherMultiplierCalibration,
    factory_calibration,
)
from core.roadimport import ImportedRoadOverlay
from core.route_search import RouteEvaluator, improve_routes
from core.schedule import assemble_plan, baseline, score, validate_plan
from core.settings import StoredTechnicalSettingsOperation, TechnicalSettingsStore

MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
COMPARISON_POLICY_IDS = ("fast", "compact", "sla", "balanced", "eco")
GraphInput = RoadGraph | OSRMTravel | ImportedRoadOverlay | TravelSource


def _regional_snapshots(snapshot: RouterTaskSnapshot) -> dict[str, RouterTaskSnapshot]:
    """Partition disconnected regional work; legacy rows remain in one default pool."""
    if snapshot.manual_decisions:
        return {"__manual__": snapshot}
    labels = sorted({item.region or "__default__" for item in [*snapshot.requests, *snapshot.engineers]})
    return {
        label: snapshot.model_copy(update={
            "requests": [request for request in snapshot.requests if (request.region or "__default__") == label],
            "engineers": [engineer for engineer in snapshot.engineers if (engineer.region or "__default__") == label],
            "pending_equipment_handoffs": [handoff for handoff in snapshot.pending_equipment_handoffs if any(
                engineer.engineer_id == handoff.donor_engineer_id and (engineer.region or "__default__") == label for engineer in snapshot.engineers
            )],
        })
        for label in labels
    }


def _regional_payload(snapshot: RouterTaskSnapshot) -> bytes:
    """Produce canonical worker bytes; the publication hash remains the outer contract."""
    return json.dumps(snapshot.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode("utf-8")


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
            options="-c default_transaction_read_only=on -c statement_timeout=10000",
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


_worker_graph = None


def _install_worker_graph(graph: GraphInput) -> None:
    """Keep the road graph in the worker. Resending it on every solve stalled the API."""
    global _worker_graph
    _worker_graph = graph


def calculate_installed(
    raw: bytes,
    settings: SearchSettings,
    context_version: str,
    memory: EngineMemory | None = None,
    publication_id: str | None = None,
    learned_weather: tuple[WeatherMultiplierCalibration, ...] = (),
    learned_weather_enabled: bool = False,
) -> tuple[RouterResult, EngineOutput | None]:
    """Solve with the graph installed at worker start, so the parent stays responsive."""
    if _worker_graph is None:
        raise RuntimeError("WORKER_GRAPH_MISSING")
    return calculate(
        raw, _worker_graph, settings, context_version, memory, publication_id,
        learned_weather, learned_weather_enabled,
    )


def calculate(
    raw: bytes,
    graph: GraphInput,
    settings: SearchSettings,
    context_version: str,
    memory: EngineMemory | None = None,
    publication_id: str | None = None,
    learned_weather: tuple[WeatherMultiplierCalibration, ...] = (),
    learned_weather_enabled: bool = False,
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
    overdue = next(
        (handoff for handoff in snapshot.pending_equipment_handoffs if handoff.meeting_at < snapshot.planning_as_of),
        None,
    )
    if overdue is not None:
        return RouterResult(
            status="error", input_publication_id=publication_id, input_hash=content_hash(raw),
            planning_as_of=snapshot.planning_as_of, computed_at=int(time.time()),
            router_context_version=context_version, policy_id=snapshot.policy.policy_id,
            technical_settings=settings.technical(),
            errors=[Diagnostic(code="WAITING_HANDOFF", message="Confirmed equipment meeting is overdue.", entity_id=overdue.handoff_id)],
        ), None
    try:
        provider = planning_travel(
            graph, settings, snapshot,
            learned_weather=learned_weather,
            learned_weather_enabled=learned_weather_enabled,
        )
        output = solve(snapshot, provider, settings, memory, context_version)
        effective_snapshot = output.memory.snapshot
        main_evidence = build_plan_evidence(effective_snapshot, output.main, provider)
        baseline_evidence = build_plan_evidence(apply_system_policy(snapshot, settings) if snapshot.manual_decisions else effective_snapshot, output.baseline, provider)
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


def calculate_policy_catalog(
    raw: bytes,
    publication_id: str,
    graph: GraphInput,
    settings: SearchSettings,
    context_version: str,
    search_budget_ms: int = 8000,
    *,
    offline: bool = False,
) -> tuple[PolicyComparison, dict[str, Plan]]:
    """Calculate all catalog policies and FIFO on one immutable snapshot.

    The function is intentionally independent from Runtime memory: every policy
    gets the same cold-start snapshot and bounded budget, and no candidate can
    affect the active plan or the next replanning anchor. Rows share the travel
    space the installed graph serves, so their summaries are directly comparable
    with the published plan's metrics. One shared candidate portfolio is scored
    once per policy. The selected plan for each strategy is returned with the
    summary. Nothing here is published.
    """
    if not 1 <= search_budget_ms <= 8000:
        raise ValueError("COMPARISON_BUDGET_INVALID")
    snapshot = apply_system_policy(official_roster(parse_snapshot(raw)), settings)
    provider = planning_travel(graph, settings, snapshot, offline=offline)
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
    # Reuse exact route evaluations, materialized plans and the common construction
    # portfolio, while each policy keeps its independent improvement path.
    seed_snapshot = snapshot.model_copy(update={"policy": Policy(policy_id="compact", parameters={})})
    if not settings.traffic_enabled or any(engineer.lunch.enabled for engineer in snapshot.engineers):
        seeded = solve(seed_snapshot, provider, comparison_settings, memory=None, context_version=context_version)
        if seeded.main.is_usable:
            candidates.append(seeded.main)
    initial = list(candidates)
    constructed_candidates: list[Plan] = []
    evaluator = RouteEvaluator(seed_snapshot, provider)
    for policy_id in COMPARISON_POLICY_IDS:
        candidate_snapshot = snapshot.model_copy(update={"policy": Policy(policy_id=policy_id, parameters={})})
        started = time.monotonic()
        portfolio = improve_routes(candidate_snapshot, provider, initial, search_budget_ms, _evaluator=evaluator)
        best = min(portfolio, key=lambda plan: score(candidate_snapshot, plan))
        candidates.append(best)
        constructed_candidates.extend(portfolio)
        rows.append(PolicyComparisonRow(
            strategy_id=policy_id, kind="policy", is_usable=best.is_usable,
            calculation_ms=max(0, round((time.monotonic() - started) * 1000)), summary=best.summary,
        ))
    # Refine each objective from the common coverage frontier, rather than letting
    # independently weaker coverage hide all resource-policy differences.
    def distinct(plans: list[Plan]) -> list[Plan]:
        by_route = {}
        for plan in plans:
            key = tuple((route.engineer_id, tuple((stop.kind, stop.request_id, stop.start_at, stop.end_at) for stop in route.stops)) for route in plan.routes)
            by_route.setdefault(key, plan)
        return list(by_route.values())

    shared = distinct(candidates)
    for policy_id in COMPARISON_POLICY_IDS:
        candidate_snapshot = snapshot.model_copy(
            update={"policy": Policy(policy_id=policy_id, parameters={})}
        )
        started = time.monotonic()
        candidates.extend(
            improve_routes(candidate_snapshot, provider, shared, search_budget_ms, construct=False, _evaluator=evaluator)
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
    candidates = distinct([*candidates, *constructed_candidates])
    selected: dict[str, Plan] = {"baseline": fifo}
    for index, row in enumerate(rows):
        if row.strategy_id == "baseline":
            continue
        candidate_snapshot = snapshot.model_copy(
            update={"policy": Policy(policy_id=row.strategy_id, parameters={})}
        )
        best = min(candidates, key=lambda plan: score(candidate_snapshot, plan))
        selected[row.strategy_id] = best
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
    selected["covering"] = covering.main
    comparison = PolicyComparison(
        input_publication_id=publication_id,
        input_hash=content_hash(raw),
        router_context_version=context_version,
        computed_at=int(time.time()),
        search_budget_ms=search_budget_ms,
        rows=rows,
    )
    return comparison, selected


def calculate_policy_comparison(
    raw: bytes,
    publication_id: str,
    graph: GraphInput,
    settings: SearchSettings,
    context_version: str,
    search_budget_ms: int = 8000,
    *,
    offline: bool = False,
) -> PolicyComparison:
    """Summary rows only. Routes stay in calculate_policy_catalog for the map store."""
    comparison, _plans = calculate_policy_catalog(
        raw,
        publication_id,
        graph,
        settings,
        context_version,
        search_budget_ms,
        offline=offline,
    )
    return comparison


class RouterRuntime:
    """One active worker plus one replaceable pending snapshot; no stale publication.

    Worker shutdown waits for the bounded calculation. Changes coalesce instead of
    building an unbounded queue; CPU work never runs on the HTTP/event-loop thread.
    """

    def __init__(
        self,
        reader: SnapshotReader,
        graph: GraphInput,
        settings: SearchSettings | None = None,
        poll_sec: float = 0.2,
        executor=None,
        settings_store: TechnicalSettingsStore | None = None,
        predict_calibration_store: "PredictCalibrationStore | None" = None,
    ):
        """Own immutable resource copies; injectable executor supports race tests."""
        if poll_sec <= 0:
            raise ValueError("poll interval must be positive")
        self.reader = reader
        self._graph = copy.deepcopy(graph)
        self._base_graph = copy.deepcopy(graph)
        self._settings_store = settings_store
        self._predict_calibration_store = predict_calibration_store or PredictCalibrationStore(
            Path(".router/predict-calibration.json")
        )
        self._predict_calibration = self._predict_calibration_store.load()
        self._learned_weather_solver_enabled = (
            os.environ.get("ROUTER_LEARNED_WEATHER_SOLVER_ENABLED", "false").strip().lower()
            == "true"
        )
        self.settings = settings or SearchSettings()
        saved = settings_store.load() if settings_store is not None else None
        if saved is not None:
            self.settings = replace(
                self.settings,
                strict_time_windows=saved.strict_time_windows,
                lunches_enabled=saved.lunches_enabled,
                traffic_enabled=saved.traffic_enabled,
                metro_enabled=saved.metro_enabled,
                equipment_transfers_enabled=saved.equipment_transfers_enabled,
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
        self._owns_executor = executor is None
        self._context_cache: str | None = None
        self._executor = executor if executor is not None else self._open_executor()
        self._future: Future | None = None
        self._active_generation = -1
        self._generation = 0
        self._key = None
        self._pending: bytes | None = None
        self._pending_publication_id: str | None = None
        self._regional_queue: list[tuple[str, bytes]] = []
        self._regional_outputs: dict[str, tuple[RouterResult, EngineOutput | None]] = {}
        self._regional_snapshot: RouterTaskSnapshot | None = None
        self._active_region = ""
        self._last_publication_seq = -1
        self._memory: EngineMemory | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._operations = settings_store.load_operations() if settings_store is not None else {}
        self._comparison_cache: dict[tuple[str, str], PolicyComparison] = {}
        self._comparison_plans: dict[tuple[str, str], dict[str, Plan]] = {}
        self._comparison_lock = threading.Lock()
        self._catalog_cache = configured_catalog_cache()
        self._sim_lock = threading.Lock()
        self._simulation_cache: dict[tuple[str, str, str], dict] = {}
        self.result = RouterResult(status="pending", router_context_version=self.context_version)
        self.last_path: str | None = None

    def _open_executor(self) -> ProcessPoolExecutor:
        """One worker that already holds the graph. A solve then sends only the task."""
        return ProcessPoolExecutor(
            max_workers=1,
            initializer=_install_worker_graph,
            initargs=(self._graph,),
        )

    def _rebind_worker(self) -> None:
        """Reload the worker after the graph changes. Tests keep their injected executor."""
        if not self._owns_executor:
            return
        previous = self._executor
        self._executor = self._open_executor()
        previous.shutdown(wait=False, cancel_futures=True)

    @property
    def context_version(self) -> str:
        """Content-derived version covers graph, policy/compiler and all search settings.

        A full road graph is hashed once. Repeating that dump on every status read
        held the router lock until login and the dashboard gave up.
        """
        cached = self._context_cache
        if cached is not None:
            return cached
        resource = self._graph.version
        data = [
            "router-v2",
            POLICY_CATALOG_VERSION,
            resource,
            planning_configuration(),
            {
                "time_limit_ms": self.settings.time_limit_ms,
                "solution_limit": self.settings.solution_limit,
                "technical_settings": self.settings.technical().model_dump(),
            },
            {
                "learned_weather_solver_enabled": self._learned_weather_solver_enabled,
                "weather_calibration": (
                    self._predict_calibration.content_version()
                    if self._learned_weather_solver_enabled else None
                ),
            },
        ]
        digest = content_hash(json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        self._context_cache = digest
        return digest

    def result_status(self) -> dict:
        """Identity of the current result without copying the plan.

        The poll that decides whether anything new arrived runs several times a
        second. Copying road geometry on each of those reads stalled the API.
        """
        with self._lock:
            result = self.result
            return {
                "status": result.status,
                "result_id": result.result_id,
                "input_publication_id": result.input_publication_id,
                "input_hash": result.input_hash,
                "computed_at": result.computed_at,
                "errors": [{"code": item.code, "message": item.message} for item in result.errors],
            }

    def read_result(self) -> RouterResult:
        """Return an isolated copy so callers cannot mutate published plans.

        The copy happens outside the runtime lock. Copying a plan with road
        geometry takes long enough to stall every other request, including the
        poll that publishes the next result.
        """
        with self._lock:
            current = self.result
        return current.model_copy(deep=True)

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
            settings = copy.deepcopy(self.settings)
        snapshot = apply_system_policy(parse_snapshot(raw), settings)
        provider = planning_travel(self._graph, settings, snapshot)
        result = evaluate_manual(snapshot, provider, active.main, routes)
        latest = self.reader.read()
        latest_raw = latest if isinstance(latest, bytes) else latest.payload
        with self._lock:
            if content_hash(latest_raw) != input_hash or self.context_version != context_version:
                raise ValueError("PUBLICATION_CHANGED")
        return {"input_hash": input_hash, "router_context_version": context_version, **result}

    def predict_calibration_state(self) -> dict:
        """Identity and parameters of the active plan-assessment calibration."""
        return {
            "version": self._predict_calibration.content_version(),
            "calibration": self._predict_calibration.model_dump(),
        }

    def set_predict_calibration(self, calibration: PredictCalibration, operation_id: str) -> dict:
        """Replace the simulator calibration atomically; the store survives restarts."""
        if calibration.working_set_generation < self._predict_calibration.working_set_generation:
            raise ValueError("CALIBRATION_GENERATION_STALE")
        self._predict_calibration_store.save(calibration)
        self._predict_calibration = calibration
        if self._learned_weather_solver_enabled:
            self._context_cache = None
        return {
            "operation_id": operation_id,
            "version": calibration.content_version(),
            "calibration": calibration.model_dump(),
        }

    def predict_situation(
        self,
        input_hash: str,
        context_version: str,
        routes: dict,
        simulations: int = 300,
        as_of: int | None = None,
        completed: dict | None = None,
        cancel_rate: float | None = None,
        calibration_override: PredictCalibration | None = None,
        scenario_seed: str | None = None,
        working_set_generation: int | None = None,
    ) -> dict:
        """Dry Monte-Carlo outlook for one fixed plan; never optimizes or applies.

        Same publication and context CAS as manual evaluation, so a prediction can
        never be attached to another manual revision or changed resource set.
        """
        from core.robustness import predict_situation

        self._sync_working_set_generation(working_set_generation, calibration_override)

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
            settings = copy.deepcopy(self.settings)
        snapshot = apply_system_policy(parse_snapshot(raw), settings)
        provider = planning_travel(self._graph, settings, snapshot)
        prediction = predict_situation(
            snapshot,
            provider,
            routes,
            simulations=simulations,
            as_of=as_of,
            completed=completed,
            cancel_rate=cancel_rate,
            calibration=calibration_override or self._predict_calibration,
            scenario_seed=scenario_seed,
        )
        latest = self.reader.read()
        latest_raw = latest if isinstance(latest, bytes) else latest.payload
        with self._lock:
            if content_hash(latest_raw) != input_hash or self.context_version != context_version:
                raise ValueError("PUBLICATION_CHANGED")
        return {
            "input_hash": input_hash,
            "router_context_version": context_version,
            **prediction,
        }

    def _sync_working_set_generation(
        self,
        requested_generation: int | None,
        calibration_override: PredictCalibration | None,
    ) -> None:
        """Adopt reset epochs before predicting and reject any older evidence override."""
        if requested_generation is None:
            return
        with self._lock:
            current_generation = self._predict_calibration.working_set_generation
            if requested_generation < current_generation:
                raise ValueError("CALIBRATION_GENERATION_STALE")
            if calibration_override is not None and (
                calibration_override.working_set_generation < requested_generation
            ):
                raise ValueError("CALIBRATION_GENERATION_STALE")
            if requested_generation > current_generation:
                factory = factory_calibration().model_copy(update={
                    "working_set_generation": requested_generation,
                })
                self._predict_calibration_store.save(factory)
                self._predict_calibration = factory
                self._context_cache = None

    def propose_window(
        self, snapshot: RouterTaskSnapshot, request_id: str, routes: dict, day_end_at: int
    ) -> dict:
        """Preview on fresh sys facts with current travel resources; never mutate runtime."""
        from core.window_proposal import propose_window

        with self._lock:
            settings = copy.deepcopy(self.settings)
            version = self.context_version
        task = apply_system_policy(snapshot, settings)
        provider = planning_travel(self._graph, settings, task)
        result = propose_window(task, provider, request_id, routes, day_end_at)
        with self._lock:
            if version != self.context_version:
                raise ValueError("CONTEXT_CHANGED")
        return result

    def propose_logistics(self, snapshot, request_id: str, receiver_engineer_id: str, routes: dict, depots: list[dict], allow_office_pickup: bool = False, expected_context_version: str | None = None) -> dict:
        """Search frozen route gaps for a one-sided equipment action without publication."""
        from core.logistics_proposal import propose_logistics

        with self._lock:
            settings = copy.deepcopy(self.settings)
            version = self.context_version
        if not settings.equipment_transfers_enabled:
            raise ValueError("EQUIPMENT_TRANSFERS_DISABLED")
        if expected_context_version is not None and expected_context_version != version:
            raise ValueError("CONTEXT_CHANGED")
        task = apply_system_policy(snapshot, settings)
        result = propose_logistics(task, planning_travel(self._graph, settings, task), request_id, receiver_engineer_id, routes, depots, allow_office_pickup=allow_office_pickup)
        with self._lock:
            if version != self.context_version:
                raise ValueError("CONTEXT_CHANGED")
        return {**result, "router_context_version": version}

    def compare_policies(self, search_budget_ms: int | None = None) -> PolicyComparison:
        """Coalesce table/map catalog requests without locking the active worker."""
        with self._comparison_lock:
            return self._compare_policies(search_budget_ms)

    def _compare_policies(self, search_budget_ms: int | None) -> PolicyComparison:
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
            if (cached is not None and cached.search_budget_ms == effective_budget_ms
                    and cached.input_publication_id == publication.publication_id):
                return cached.model_copy(deep=True)
        # A persisted cache must also reject changed graph bytes whose metadata label
        # was accidentally left unchanged. No extra graph serialization in beta-off mode.
        cache_scope = ""
        if self._catalog_cache:
            resource_hash = content_hash(graph.model_dump_json().encode()) if isinstance(graph, RoadGraph) else graph.version
            cache_scope = content_hash(json.dumps([resource_hash, asdict(settings)], sort_keys=True).encode())
        external = self._catalog_cache.get(publication.publication_id, digest, context_version, effective_budget_ms, cache_scope) if self._catalog_cache else None
        if external is None:
            comparison, plans = calculate_policy_catalog(
                publication.payload, publication.publication_id, graph, settings,
                context_version, effective_budget_ms,
            )
        else:
            comparison, plans = external
        if self._catalog_cache and external is None:
            self._catalog_cache.put(comparison, plans, cache_scope)
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
            # Only the current publication can be read, so retaining historical
            # full route catalogs would grow memory without serving a valid read.
            self._comparison_cache.clear()
            self._comparison_plans.clear()
            self._comparison_cache[key] = comparison
            self._comparison_plans[key] = plans
        return comparison.model_copy(deep=True)

    def catalog_cache_stats(self) -> dict:
        """Expose beta cache counters for local verification, without credentials or task data."""
        return {"enabled": self._catalog_cache is not None,
                **(dict(self._catalog_cache.stats) if self._catalog_cache else {})}

    def simulate(self, patch: dict) -> dict:
        """What-if on a byte copy of the ready publication. Does not write the active plan.

        Simulations share one lock so they queue behind each other. The live worker
        uses a different lock and does not wait on this queue.
        """
        from core.simulator import SimulationPatch, catalog_result, patch_hash, simulate_patch

        try:
            parsed = SimulationPatch.model_validate(patch)
        except Exception as exc:
            raise ValueError("PATCH_INVALID") from exc
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
            settings = copy.deepcopy(self.settings)
            if (
                active.status != "ready"
                or active.input_publication_id != publication.publication_id
                or active.input_hash != digest
                or active.router_context_version != context_version
                or active.main is None
            ):
                raise ValueError("PUBLICATION_CHANGED")
            base = active.main.model_copy(deep=True)
        key = (digest, context_version, patch_hash(parsed))
        with self._sim_lock:
            cached = self._simulation_cache.get(key)
            if cached is not None:
                return {**cached, "cached": True}
            if parsed.catalog:
                with self._comparison_lock:
                    comparison = self._compare_policies(None)
                    with self._lock:
                        plans = self._comparison_plans.get((digest, context_version))
                    if plans is None or comparison.input_hash != digest or comparison.router_context_version != context_version:
                        raise ValueError("PUBLICATION_CHANGED")
                    result = catalog_result(digest, publication.publication_id, context_version, parsed, plans, base)
            else:
                result = simulate_patch(
                    publication.payload, settings, context_version, parsed, base,
                    publication_id=publication.publication_id, graph=self._graph,
                )
            try:
                latest = self.reader.read()
            except Exception as exc:
                raise RuntimeError("ACTIVE_PUBLICATION_UNAVAILABLE") from exc
            latest_raw = latest if isinstance(latest, bytes) else latest.payload
            with self._lock:
                if content_hash(latest_raw) != digest or self.context_version != context_version:
                    raise ValueError("PUBLICATION_CHANGED")
            if len(self._simulation_cache) > 32:
                self._simulation_cache.clear()
            stored = {**result, "cached": False}
            self._simulation_cache[key] = stored
            return stored

    def state(self) -> dict:
        """Expose service state separately from an older result's context version."""
        with self._lock:
            return {
                "router_context_version": self.context_version,
                "generation": self._generation,
                "status": self.result.status,
                "active": self._future is not None,
                "engine_path": self.last_path,
                "regional_progress": self.result.regional_progress,
                "technical_settings": self.settings.technical().model_dump(),
            }

    def _publish_regional_cumulative(self, raw: bytes, publication_id: str, context_version: str) -> None:
        """Publish only completed region routes; incomplete regions stay explicitly pending."""
        snapshot = self._regional_snapshot
        if snapshot is None:
            return
        completed = [item for item in self._regional_outputs.values() if item[0].status == "ready"]
        if not completed:
            return
        routes = [route for result, _ in completed for route in (result.main.routes if result.main else [])]
        baseline_routes = [route for result, _ in completed for route in (result.baseline.routes if result.baseline else [])]
        main = assemble_plan(snapshot, routes)
        baseline_plan = assemble_plan(snapshot, baseline_routes)
        progress = []
        for region, part in _regional_snapshots(snapshot).items():
            completed_result = self._regional_outputs.get(region)
            progress.append(RegionalProgress(
                region=region,
                status=(
                    "pending"
                    if completed_result is None or completed_result[0].status == "partial"
                    else completed_result[0].status
                ),
                request_count=len(part.requests),
            ))
        # The comprehension above intentionally keeps a result entry and a pending
        # entry mutually exclusive; sort makes API progress stable.
        status = "ready" if all(item.status == "ready" for item in progress) else "partial"
        if status == "partial":
            ready_regions = {item.region for item in progress if item.status == "ready"}
            def scope(plan):
                assignments = [assignment for assignment in plan.assignments if (next(
                    request for request in snapshot.requests if request.request_id == assignment.request_id
                ).region or "__default__") in ready_regions]
                summary = plan.summary.model_copy(update={
                    "requests_total": len(assignments),
                    "unassigned_count": sum(item.status == "unassigned" for item in assignments),
                    "urgent_total": sum(next(request for request in snapshot.requests if request.request_id == item.request_id).priority == "urgent" for item in assignments),
                    "urgent_assigned_count": sum(item.status == "assigned" and next(request for request in snapshot.requests if request.request_id == item.request_id).priority == "urgent" for item in assignments),
                })
                return plan.model_copy(update={"assignments": assignments, "summary": summary})
            main, baseline_plan = scope(main), scope(baseline_plan)
        # Reuse evidence computed by each worker with its exact road matrix. Rebuilding
        # it here would do road preparation and scheduling under the coordinator lock.
        main_evidence = PlanEvidence(requests=[
            item for result, _ in completed if result.main_evidence is not None
            for item in result.main_evidence.requests
        ])
        baseline_evidence = PlanEvidence(requests=[
            item for result, _ in completed if result.baseline_evidence is not None
            for item in result.baseline_evidence.requests
        ])
        self.result = RouterResult(
            status=status, result_id=str(uuid4()), input_publication_id=publication_id,
            input_hash=content_hash(raw), planning_as_of=snapshot.planning_as_of,
            computed_at=int(time.time()), router_context_version=context_version,
            policy_id=snapshot.policy.policy_id, technical_settings=self.settings.technical(),
            search_path="REGIONAL_SEQUENTIAL", policy_criteria=list(compile_policy(snapshot.policy).ordered_criteria),
            main=main, baseline=baseline_plan,
            main_evidence=main_evidence, baseline_evidence=baseline_evidence,
            regional_progress=progress,
        )

    def _invalidate(self):
        self._context_cache = None
        self._generation += 1
        self._key = None
        self._pending = None
        self._pending_publication_id = None
        self._regional_queue = []
        self._regional_outputs = {}
        self._regional_snapshot = None
        self._active_region = ""
        self.last_path = None
        self._comparison_cache.clear()
        self._comparison_plans.clear()
        self._simulation_cache.clear()
        self.result = RouterResult(status="pending", router_context_version=self.context_version)

    def update_graph(self, graph: RoadGraph) -> None:
        """Activate a validated resource atomically; old workers keep their own graph."""
        with self._lock:
            if graph != self._base_graph:
                self._base_graph = graph.model_copy(deep=True)
                self._graph = graph.model_copy(deep=True)
                self._invalidate()
                self._rebind_worker()

    def update_road_overlay(self, graph: RoadGraph) -> None:
        """Activate persistent imported edges without replacing the configured base provider."""
        base = (
            GraphTravel(self._base_graph)
            if isinstance(self._base_graph, RoadGraph)
            else self._base_graph
        )
        overlay = ImportedRoadOverlay(base, graph)
        with self._lock:
            if overlay.version != getattr(self._graph, "version", None):
                self._graph = overlay
                self._invalidate()
                self._rebind_worker()

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
                strict_time_windows=requested.strict_time_windows,
                lunches_enabled=requested.lunches_enabled,
                traffic_enabled=requested.traffic_enabled,
                equipment_enabled=requested.equipment_enabled,
                equipment_transfers_enabled=requested.equipment_transfers_enabled,
                metro_enabled=requested.metro_enabled,
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
            self._context_cache = None
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
                # A locked database must not abandon a solve still running or a
                # plan already on screen, and it must not bump the generation:
                # that made the next successful read look new and start a second
                # calculation. A solve that finished during the outage is dropped
                # unconfirmed so it cannot be published as the current plan.
                if self._future is not None and self._future.done():
                    self._future = None
                    self._key = None
                    self._pending = None
                    self._pending_publication_id = None
                if self._future is not None or self.result.status == "ready":
                    return
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
                try:
                    self._regional_snapshot = parse_snapshot(raw)
                    regional = [
                        (region, _regional_payload(part))
                        for region, part in _regional_snapshots(self._regional_snapshot).items()
                    ]
                    self._regional_queue = regional if len(regional) > 1 else []
                    self._regional_outputs = {}
                except Exception:
                    self._regional_snapshot = None
                    self._regional_queue = []
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
                        if self._active_region:
                            # Queue head is removed only on submission, so the completed
                            # region is carried by the active worker marker.
                            self._regional_outputs[self._active_region] = (result, output)
                            self._publish_regional_cumulative(raw, publication.publication_id, key[1])
                            self._active_region = ""
                        else:
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
                    if self._regional_queue:
                        self._active_region, regional_raw = self._regional_queue.pop(0)
                        worker_raw = regional_raw
                    else:
                        self._active_region = ""
                        worker_raw = self._pending
                    if self._owns_executor:
                        self._future = self._executor.submit(
                            calculate_installed,
                            worker_raw,
                            self.settings,
                            key[1],
                            self._memory,
                            self._pending_publication_id,
                            tuple(self._predict_calibration.weather_multipliers),
                            self._learned_weather_solver_enabled,
                        )
                    else:
                        self._future = self._executor.submit(
                            calculate,
                            worker_raw,
                            self._graph,
                            self.settings,
                            key[1],
                            self._memory,
                            self._pending_publication_id,
                            tuple(self._predict_calibration.weather_multipliers),
                            self._learned_weather_solver_enabled,
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
                if not self._regional_queue:
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
        if self._catalog_cache:
            self._catalog_cache.close()
