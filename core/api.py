"""Private Router result/context API; business actions and authentication belong to sys."""

import asyncio
import base64
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from pydantic import Field

from core.contracts import (
    PolicyComparison,
    Record,
    RouterResult,
    RouterTaskSnapshot,
    RouterTechnicalSettings,
)
from core.predict_calibration import PredictCalibration
from core.roadimport import RoadGraphStore, RoadImportError, import_into_runtime
from core.runtime import RouterRuntime


class ToleranceRequest(Record):
    """Idempotent context-checked technical operation, not a routing instruction."""

    operation_id: str = Field(min_length=1, max_length=128)
    tolerance_sec: int = Field(ge=0, le=86400)
    expected_context_version: str = Field(min_length=1)


class ManualEvaluationRequest(Record):
    """Explicit orders and immutable context, never a request for a new plan."""

    input_hash: str = Field(min_length=64, max_length=64)
    router_context_version: str = Field(min_length=1)
    routes: dict[str, list[str]] = Field(max_length=1000)


class SituationPredictRequest(Record):
    """Dry Monte-Carlo outlook for one fixed plan and execution situation."""

    input_hash: str = Field(min_length=64, max_length=64)
    router_context_version: str = Field(min_length=1)
    routes: dict[str, list[str]] = Field(max_length=1000)
    simulations: int = Field(default=300, ge=100, le=2000)
    as_of: int | None = Field(default=None, gt=0)
    completed: dict[str, list[str]] = Field(default_factory=dict, max_length=1000)
    cancel_rate: float | None = Field(default=None, ge=0.0, le=1.0)
    calibration_override: PredictCalibration | None = None
    scenario_seed: str | None = Field(default=None, min_length=1, max_length=128)
    working_set_generation: int | None = Field(default=None, ge=1)


class TechnicalSettingsRequest(RouterTechnicalSettings):
    """Complete idempotent replacement of Router-owned technical controls."""

    operation_id: str = Field(min_length=1, max_length=128)
    expected_context_version: str = Field(min_length=1)


class PredictCalibrationRequest(Record):
    """Complete replacement of the plan-assessment simulator calibration."""

    operation_id: str = Field(min_length=1, max_length=128)
    expected_version: str | None = None
    calibration: PredictCalibration


class WindowProposalRequest(Record):
    """Fresh sys-owned projection; this preview never becomes the published task."""

    snapshot: RouterTaskSnapshot
    request_id: str = Field(min_length=1, max_length=128)
    routes: dict[str, list[str]] = Field(max_length=100)
    day_end_at: int = Field(gt=0)


def create_app(runtime: RouterRuntime, road_store: RoadGraphStore | None = None) -> FastAPI:
    """Create the single-worker internal API; bind to loopback/private service network."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime.start()
        yield
        runtime.close()

    app = FastAPI(title="LCT Router Core", version="2.0", lifespan=lifespan)

    configured_path = (
        os.environ.get("ROUTER_ROAD_GRAPH_PATH", "").strip() or ".router/road-import.json"
    )
    configured_store = road_store or RoadGraphStore(Path(configured_path))
    persisted_graph = configured_store.load()
    if persisted_graph is not None:
        runtime.update_road_overlay(persisted_graph)

    @app.get("/health")
    def health() -> dict:
        """Liveness is separate from availability of a usable calculated plan."""
        return {"service": "router", **runtime.state()}

    @app.get("/v1/context")
    def context() -> dict:
        """Return the active resource context for sys acceptance checks."""
        return runtime.state()

    @app.get("/v1/result-status")
    def result_status() -> dict:
        """Cheap poll identity. The full plan stays on ``/v1/result``."""
        return runtime.result_status()

    @app.post("/v1/road-import")
    async def road_import(request: Request) -> dict:
        """Accept one authenticated-by-sys operation and activate its offline graph.

        Binary uploads use ``X-Operation-Id`` and optional ``X-Road-Profile``
        headers.  JSON callers may send ``payload_base64`` with the same fields;
        this keeps the private boundary usable by browsers without multipart
        parsing while preserving gzip bytes exactly.
        """
        raw = await request.body()
        operation_id = request.headers.get("x-operation-id", "").strip()
        profile = request.headers.get("x-road-profile")
        source = request.headers.get("x-road-source")
        if request.headers.get("content-type", "").split(";", 1)[0].lower() == "application/json":
            try:
                envelope = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise HTTPException(status_code=422, detail="INVALID_JSON") from exc
            if not isinstance(envelope, dict):
                raise HTTPException(status_code=422, detail="INVALID_DOCUMENT")
            envelope_operation = envelope.get("operation_id", operation_id)
            if not isinstance(envelope_operation, str):
                raise HTTPException(status_code=422, detail="INVALID_OPERATION_ID")
            operation_id = envelope_operation.strip()
            profile = envelope.get("profile", profile)
            source = envelope.get("source", source)
            if source is not None and not isinstance(source, str):
                raise HTTPException(status_code=422, detail="INVALID_SOURCE")
            encoded = envelope.get("payload_base64")
            if not isinstance(encoded, str):
                raise HTTPException(status_code=422, detail="payload_base64 is required")
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as exc:
                raise HTTPException(status_code=422, detail="INVALID_BASE64") from exc
        try:
            result = import_into_runtime(runtime, configured_store, operation_id, raw, profile, source)
        except RoadImportError as exc:
            conflicts = {
                "OPERATION_CONFLICT",
                "DUPLICATE_DIRECTED_EDGE",
                "NODE_COORDINATE_CONFLICT",
                "EDGE_GEOMETRY_CONFLICT",
                "EDGE_DISTANCE_CONFLICT",
            }
            status = 409 if exc.code in conflicts else 413 if exc.code == "IMPORT_TOO_LARGE" else 422
            raise HTTPException(status_code=status, detail=exc.code) from exc
        return result.as_dict()

    @app.get("/v1/result", response_model=RouterResult)
    def result() -> RouterResult:
        """Read the latest atomic pair, preserving result_id on repeated reads."""
        return runtime.read_result()

    @app.get("/v1/policy-comparison", response_model=PolicyComparison)
    def policy_comparison() -> PolicyComparison:
        """Compare the complete policy catalog and FIFO on the active publication."""
        try:
            return runtime.compare_policies()
        except RuntimeError as exc:
            if str(exc) == "ACTIVE_PUBLICATION_UNAVAILABLE":
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            raise
        except ValueError as exc:
            if str(exc) == "PUBLICATION_CHANGED":
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            raise

    @app.post("/v1/manual-evaluation")
    def manual_evaluation(request: ManualEvaluationRequest) -> dict:
        """Return real fixed-order policy evidence without applying or optimizing it."""
        if sum(len(order) for order in request.routes.values()) > 10000:
            raise HTTPException(status_code=422, detail="MANUAL_PLAN_TOO_LARGE")
        try:
            return runtime.evaluate_manual(
                request.input_hash, request.router_context_version, request.routes
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=503, detail="ACTIVE_PUBLICATION_UNAVAILABLE") from exc

    @app.get("/v1/weather")
    def weather() -> dict:
        """Cached Moscow forecast. A failed fetch reports multiplier 1."""
        from dataclasses import asdict

        from core.weather import current_weather

        return asdict(current_weather())

    @app.post("/v1/situation-predict")
    def situation_predict(request: SituationPredictRequest) -> dict:
        """Dry Monte-Carlo probabilities for one fixed plan; never a new plan."""
        if sum(len(order) for order in request.routes.values()) > 10000:
            raise HTTPException(status_code=422, detail="PREDICT_PLAN_TOO_LARGE")
        try:
            return runtime.predict_situation(
                request.input_hash,
                request.router_context_version,
                request.routes,
                simulations=request.simulations,
                as_of=request.as_of,
                completed=request.completed,
                cancel_rate=request.cancel_rate,
                calibration_override=request.calibration_override,
                scenario_seed=request.scenario_seed,
                working_set_generation=request.working_set_generation,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=503, detail="ACTIVE_PUBLICATION_UNAVAILABLE") from exc

    @app.post("/v1/simulate")
    async def simulate(request: Request) -> dict:
        """What-if on the ready publication. The body is a patch, never a free snapshot.

        The handler waits on the simulator queue only. The live worker is a different
        thread and does not take that queue's lock.
        """
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=422, detail="PATCH_INVALID") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail="PATCH_INVALID")
        try:
            return await asyncio.to_thread(runtime.simulate, payload)
        except ValueError as exc:
            code = str(exc)
            status = 422 if code in {
                "PATCH_INVALID",
                "PATCH_MIXED",
                "PATCH_EMPTY",
                "UNKNOWN_REQUEST",
                "UNKNOWN_ENGINEER",
            } else 409
            raise HTTPException(status_code=status, detail=code) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/v1/window-proposal")
    def window_proposal(request: WindowProposalRequest) -> dict:
        """Calculate a bounded same-day insertion without publishing or applying it."""
        if len(request.snapshot.requests) > 500 or sum(map(len, request.routes.values())) > 200:
            raise HTTPException(status_code=422, detail="PREVIEW_TOO_LARGE")
        try:
            return runtime.propose_window(
                request.snapshot, request.request_id, request.routes, request.day_end_at
            )
        except TimeoutError as exc:
            raise HTTPException(status_code=503, detail="WINDOW_SEARCH_TIMEOUT") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.put("/v1/config/tolerance")
    def tolerance(body: ToleranceRequest) -> dict:
        """Set only the technical revalidation tolerance after sys authorization."""
        try:
            return runtime.set_tolerance(
                body.operation_id, body.tolerance_sec, body.expected_context_version
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.put("/v2/config/technical-settings")
    def technical_settings(body: TechnicalSettingsRequest) -> dict:
        """Persist a complete settings revision after a context-version CAS check."""
        try:
            settings = RouterTechnicalSettings.model_validate(
                body.model_dump(exclude={"operation_id", "expected_context_version"})
            )
            return runtime.set_technical_settings(
                body.operation_id, settings, body.expected_context_version
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/v1/config/predict-calibration")
    def get_predict_calibration() -> dict:
        """Active simulator calibration for the plan-assessment contour."""
        return runtime.predict_calibration_state()

    @app.put("/v1/config/predict-calibration")
    def put_predict_calibration(body: PredictCalibrationRequest) -> dict:
        """Replace the calibration after an optimistic version check; idempotent."""
        if body.expected_version and body.expected_version != runtime.predict_calibration_state()["version"]:
            raise HTTPException(status_code=409, detail="CALIBRATION_VERSION_CONFLICT")
        try:
            return runtime.set_predict_calibration(body.calibration, body.operation_id)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    return app
