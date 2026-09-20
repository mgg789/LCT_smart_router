"""Private Router result/context API; business actions and authentication belong to sys."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import Field

from core.contracts import PolicyComparison, Record, RouterResult, RouterTechnicalSettings
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


class TechnicalSettingsRequest(RouterTechnicalSettings):
    """Complete idempotent replacement of Router-owned technical controls."""

    operation_id: str = Field(min_length=1, max_length=128)
    expected_context_version: str = Field(min_length=1)


def create_app(runtime: RouterRuntime) -> FastAPI:
    """Create the single-worker internal API; bind to loopback/private service network."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime.start()
        yield
        runtime.close()

    app = FastAPI(title="LCT Router Core", version="2.0", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict:
        """Liveness is separate from availability of a usable calculated plan."""
        return {"service": "router", **runtime.state()}

    @app.get("/v1/context")
    def context() -> dict:
        """Return the active resource context for sys acceptance checks."""
        return runtime.state()

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

    return app
