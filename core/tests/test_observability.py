"""Opt-in telemetry isolation, privacy and lifecycle regressions."""

import builtins
from unittest.mock import Mock

import pytest
from core.observability import RouterObservability
from fastapi import FastAPI
from fastapi.testclient import TestClient

METRICS_TOKEN = "metrics-test-" * 4
METRICS_HEADERS = {"Authorization": f"Bearer {METRICS_TOKEN}"}


def make_app():
    """Small real ASGI boundary; no routing solver/network fixtures needed."""
    app = FastAPI()
    telemetry = RouterObservability(app)

    @app.get("/requests/{request_id}")
    def request(request_id: str):
        return {"ok": True}

    @app.get("/failure")
    def failure():
        raise ValueError("private customer address and token")

    return app, telemetry


def test_disabled_does_not_import_or_initialize_sdks(monkeypatch):
    for flag in ("ROUTER_METRICS_ENABLED", "ROUTER_OTEL_ENABLED", "ROUTER_SENTRY_ENABLED"):
        monkeypatch.setenv(flag, "false")
    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        assert not name.startswith(("prometheus_client", "opentelemetry", "sentry_sdk"))
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    app, telemetry = make_app()
    telemetry.start()
    with TestClient(app) as client:
        assert client.get("/requests/id").status_code == 200
        assert client.get("/metrics").status_code == 404
    telemetry.close()


@pytest.mark.parametrize(
    "token", [None, "", "short", METRICS_TOKEN + " ", METRICS_TOKEN + "\n", "ю" * 40, "a" * 513]
)
def test_invalid_metrics_token_disables_only_the_optional_endpoint(monkeypatch, token, caplog):
    monkeypatch.setenv("ROUTER_METRICS_ENABLED", "true")
    if token is None:
        monkeypatch.delenv("ROUTER_METRICS_TOKEN", raising=False)
    else:
        monkeypatch.setenv("ROUTER_METRICS_TOKEN", token)
    app, telemetry = make_app()
    with TestClient(app) as client:
        assert client.get("/metrics").status_code == 404
        assert client.get("/requests/id").status_code == 200
    assert METRICS_TOKEN not in caplog.text
    telemetry.close()


def test_metrics_require_one_exact_bearer_and_protect_decoded_paths(monkeypatch):
    monkeypatch.setenv("ROUTER_METRICS_ENABLED", "true")
    monkeypatch.setenv("ROUTER_METRICS_TOKEN", METRICS_TOKEN)
    app, telemetry = make_app()
    with TestClient(app) as client:
        for value in [
            None,
            "Basic invalid",
            "Bearer wrong",
            f"Bearer {METRICS_TOKEN} extra",
            f"Bearer {METRICS_TOKEN}, Bearer wrong",
        ]:
            response = client.get(
                "/metrics", headers={} if value is None else {"Authorization": value}
            )
            assert response.status_code == 401
            assert "router_http_requests" not in response.text
        assert (
            client.get(
                f"/metrics?token={METRICS_TOKEN}", headers={"Cookie": f"token={METRICS_TOKEN}"}
            ).status_code
            == 401
        )
        for values in [
            (f"Bearer {METRICS_TOKEN}", "Bearer wrong"),
            ("Bearer wrong", f"Bearer {METRICS_TOKEN}"),
        ]:
            assert (
                client.get(
                    "/metrics", headers=[("Authorization", value) for value in values]
                ).status_code
                == 401
            )
        for path in ["/metrics", "/metrics/", "/%6detrics", "/metrics%2f"]:
            assert client.get(path).status_code == 401
            assert client.get(path, headers=METRICS_HEADERS).status_code == 200
        assert (
            client.get("/metrics", headers={"Authorization": f"bearer {METRICS_TOKEN}"}).status_code
            == 200
        )
        assert client.get("/Metrics").status_code == 404
        assert client.get("/requests/id").status_code == 200
    telemetry.close()


def test_metrics_use_template_and_bounded_unknown_routes(monkeypatch):
    monkeypatch.setenv("ROUTER_METRICS_ENABLED", "true")
    monkeypatch.setenv("ROUTER_METRICS_TOKEN", METRICS_TOKEN)
    app, telemetry = make_app()
    with TestClient(app, raise_server_exceptions=False) as client:
        client.get("/requests/private-id?secret=hidden")
        client.get("/unknown-secret")
        client.get("/failure")
        body = client.get("/metrics", headers=METRICS_HEADERS).text
    assert 'route="/requests/{request_id}"' in body
    assert 'route="unmatched"' in body
    assert 'status="500"' in body
    assert all(value not in body for value in ("private-id", "unknown-secret", "hidden"))
    telemetry.close()


def test_traces_keep_parent_without_capturing_request_or_exception_text(monkeypatch):
    from opentelemetry.exporter.otlp.proto.http import trace_exporter
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    monkeypatch.setattr(trace_exporter, "OTLPSpanExporter", lambda **kwargs: exporter)
    monkeypatch.setenv("ROUTER_OTEL_ENABLED", "true")
    monkeypatch.setenv(
        "ROUTER_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://collector:4318/v1/traces"
    )
    monkeypatch.setenv("ROUTER_OTEL_TRACE_SAMPLE_RATIO", "1")
    app, telemetry = make_app()
    telemetry.start()
    with TestClient(app, raise_server_exceptions=False) as client:
        client.get(
            "/requests/private-id?secret=hidden",
            headers={"traceparent": "00-12345678901234567890123456789012-1234567890123456-01"},
        )
        client.get("/failure")
    telemetry.provider.force_flush()
    spans = exporter.get_finished_spans()
    assert spans[0].name == "GET /requests/{request_id}"
    assert spans[0].parent.span_id == int("1234567890123456", 16)
    assert spans[1].status.status_code.name == "ERROR"
    assert not spans[1].events
    assert "private" not in str([dict(span.attributes) for span in spans])
    telemetry.close()
    assert telemetry.provider is None


def test_sentry_reports_sanitized_exception_and_closes(monkeypatch):
    import sentry_sdk

    sink = Mock()
    factory = Mock(return_value=sink)
    monkeypatch.setattr(sentry_sdk, "Client", factory)
    monkeypatch.setenv("ROUTER_SENTRY_ENABLED", "true")
    monkeypatch.setenv("ROUTER_SENTRY_DSN", "https://public@example.invalid/1")
    app, telemetry = make_app()
    telemetry.start()
    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.get("/failure").status_code == 500
    payload = sink.capture_event.call_args.args[0]
    assert payload["exception"]["values"][0]["type"] == "ValueError"
    assert all(value not in str(payload) for value in ("private customer", "locals", "vars"))
    assert factory.call_args.kwargs["default_integrations"] is False
    telemetry.close()
    sink.close.assert_called_once_with(timeout=2)


def test_bad_trace_config_does_not_disable_metrics(monkeypatch):
    monkeypatch.setenv("ROUTER_METRICS_ENABLED", "true")
    monkeypatch.setenv("ROUTER_METRICS_TOKEN", METRICS_TOKEN)
    monkeypatch.setenv("ROUTER_OTEL_ENABLED", "true")
    monkeypatch.setenv("ROUTER_OTEL_TRACE_SAMPLE_RATIO", "nan")
    app, telemetry = make_app()
    telemetry.start()
    with TestClient(app) as client:
        assert client.get("/requests/id").status_code == 200
        assert client.get("/metrics", headers=METRICS_HEADERS).status_code == 200
    telemetry.close()


def test_real_app_closes_telemetry_even_when_runtime_shutdown_fails(monkeypatch):
    import pytest
    from core.api import create_app

    runtime = Mock()
    runtime.state.return_value = {"status": "ready"}
    runtime.close.side_effect = RuntimeError("shutdown failure")
    store = Mock()
    store.load.return_value = None
    start = Mock()
    close = Mock()
    monkeypatch.setattr(RouterObservability, "start", start)
    monkeypatch.setattr(RouterObservability, "close", close)
    with pytest.raises(RuntimeError, match="shutdown failure"):
        with TestClient(create_app(runtime, store)) as client:
            assert client.get("/health").status_code == 200
    runtime.start.assert_called_once()
    start.assert_called_once()
    close.assert_called_once()
