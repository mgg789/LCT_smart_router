"""Opt-in, payload-free telemetry for the private Router HTTP boundary."""

import hmac
import logging
import math
import os
import re
import time
import traceback
from contextlib import nullcontext
from pathlib import Path

from fastapi import FastAPI, Request, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

LOGGER = logging.getLogger(__name__)
METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})


def enabled(name: str) -> bool:
    """Require explicit opt-in; arbitrary non-empty values never enable exporters."""
    return os.getenv(name, "").strip().lower() == "true"


class RouterObservability:
    """Own isolated registries/clients, with no global instrumentation or request contents."""

    def __init__(self, app: FastAPI):
        self.provider = None
        self.tracer = None
        self.sentry = None
        self.requests = None
        self.duration = None
        if enabled("ROUTER_METRICS_ENABLED"):
            try:
                token = os.getenv("ROUTER_METRICS_TOKEN", "")
                if not 32 <= len(token) <= 512 or not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", token):
                    raise ValueError("invalid metrics token")
                from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest
                from prometheus_client.exposition import CONTENT_TYPE_LATEST

                registry = CollectorRegistry()
                labels = ["method", "route", "status"]
                self.requests = Counter(
                    "router_http_requests_total", "Router HTTP requests", labels, registry=registry
                )
                self.duration = Histogram(
                    "router_http_request_duration_seconds",
                    "Router HTTP latency",
                    labels,
                    registry=registry,
                )

                @app.get("/metrics", include_in_schema=False)
                def metrics(request: Request) -> Response:
                    """Require one exact scraper credential after routing has normalized the path."""
                    headers = request.headers.getlist("authorization")
                    match = (
                        re.fullmatch(r"(?i:Bearer) ([A-Za-z0-9._~+/-]+=*)", headers[0])
                        if len(headers) == 1 and len(headers[0]) <= 519
                        else None
                    )
                    if match is None or not hmac.compare_digest(match[1], token):
                        return Response(status_code=401, headers={"WWW-Authenticate": "Bearer"})
                    return Response(
                        generate_latest(registry), headers={"Content-Type": CONTENT_TYPE_LATEST}
                    )
            except Exception:
                LOGGER.warning("Router metrics unavailable; serving without metrics")
        app.add_middleware(TelemetryMiddleware, telemetry=self)

    def start(self) -> None:
        """Initialize each enabled sink independently; configuration failures do not stop routing."""
        if enabled("ROUTER_OTEL_ENABLED"):
            try:
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
                from opentelemetry.sdk.resources import Resource
                from opentelemetry.sdk.trace import TracerProvider
                from opentelemetry.sdk.trace.export import BatchSpanProcessor
                from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

                endpoint = os.getenv(
                    "ROUTER_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                    "http://otel-collector:4318/v1/traces",
                ).strip()
                if not endpoint:
                    raise ValueError("missing endpoint")
                ratio = float(os.getenv("ROUTER_OTEL_TRACE_SAMPLE_RATIO", "0.1"))
                if not math.isfinite(ratio) or not 0 <= ratio <= 1:
                    raise ValueError("invalid sample ratio")
                self.provider = TracerProvider(
                    resource=Resource({"service.name": "lct-router"}),
                    shutdown_on_exit=False,
                    sampler=ParentBased(TraceIdRatioBased(ratio)),
                )
                self.provider.add_span_processor(
                    BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, timeout=2))
                )
                self.tracer = self.provider.get_tracer("lct.router.http")
            except Exception:
                LOGGER.warning("Router tracing unavailable; serving without tracing")
        if enabled("ROUTER_SENTRY_ENABLED"):
            try:
                from sentry_sdk import Client

                dsn = os.getenv("ROUTER_SENTRY_DSN", "").strip()
                if not dsn:
                    raise ValueError("missing dsn")
                self.sentry = Client(
                    dsn=dsn,
                    environment=os.getenv("ROUTER_SENTRY_ENVIRONMENT", "development"),
                    release=os.getenv("ROUTER_SENTRY_RELEASE") or None,
                    default_integrations=False,
                    auto_enabling_integrations=False,
                    send_default_pii=False,
                    include_local_variables=False,
                    include_source_context=False,
                    server_name="lct-router",
                    max_breadcrumbs=0,
                    traces_sample_rate=0,
                    shutdown_timeout=2,
                )
            except Exception:
                LOGGER.warning(
                    "Router error reporting unavailable; serving without error reporting"
                )

    def close(self) -> None:
        """Flush bounded exporter queues and release their worker threads at app shutdown."""
        if self.provider is not None:
            try:
                self.provider.shutdown()
            except Exception:
                LOGGER.warning("Router telemetry shutdown failed")
        if self.sentry is not None:
            try:
                self.sentry.close(timeout=2)
            except Exception:
                LOGGER.warning("Router telemetry shutdown failed")
        self.provider = self.tracer = self.sentry = None

    def exception(self, error: Exception) -> None:
        """Report exception type/location only: messages, locals, request and source text are omitted."""
        if self.sentry is None:
            return
        frames = [
            {"filename": Path(frame.filename).name, "function": frame.name, "lineno": frame.lineno}
            for frame in traceback.extract_tb(error.__traceback__)
        ]
        self.sentry.capture_event(
            {
                "level": "error",
                "exception": {
                    "values": [
                        {
                            "type": type(error).__name__,
                            "value": "Router request failed",
                            "stacktrace": {"frames": frames},
                        }
                    ]
                },
            }
        )


class TelemetryMiddleware:
    """Observe completed HTTP requests with route templates rather than addresses or IDs."""

    def __init__(self, app: ASGIApp, telemetry: RouterObservability):
        self.app = app
        self.telemetry = telemetry

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("path") == "/metrics":
            await self.app(scope, receive, send)
            return
        telemetry = self.telemetry
        method = scope.get("method", "OTHER")
        method = method if method in METHODS else "OTHER"
        status = 500
        started = time.perf_counter()
        context = nullcontext(None)
        if telemetry.tracer:
            from opentelemetry.trace import SpanKind
            from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

            carrier = {
                key.decode("latin1"): value.decode("latin1")
                for key, value in scope.get("headers", [])
                if key.lower() in (b"traceparent", b"tracestate")
            }
            parent = TraceContextTextMapPropagator().extract(carrier)
            context = telemetry.tracer.start_as_current_span(
                "HTTP",
                context=parent,
                kind=SpanKind.SERVER,
                record_exception=False,
                set_status_on_exception=False,
            )

        async def observe_send(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        with context as span:
            try:
                await self.app(scope, receive, observe_send)
            except Exception as error:
                try:
                    telemetry.exception(error)
                except Exception:
                    LOGGER.warning("Router error report could not be queued")
                raise
            finally:
                route = getattr(scope.get("route"), "path", "unmatched")
                if telemetry.requests is not None and telemetry.duration is not None:
                    telemetry.requests.labels(method, route, str(status)).inc()
                    telemetry.duration.labels(method, route, str(status)).observe(
                        time.perf_counter() - started
                    )
                if span is not None:
                    from opentelemetry.trace import StatusCode

                    span.update_name(f"{method} {route}")
                    span.set_attributes(
                        {
                            "http.request.method": method,
                            "http.route": route,
                            "http.response.status_code": status,
                        }
                    )
                    if status >= 500:
                        span.set_status(StatusCode.ERROR)
