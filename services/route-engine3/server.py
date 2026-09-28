"""route-engine3: universal multi-graph OSRM routing service.

One container serves every OSRM graph dropped into the graphs root. Each
subdirectory with a ``*.osrm`` base file becomes a supervised osrm-routed
child (see graphs.py); profiles decide which graph answers a query:
``car`` queries go to the graph with profile ``car``, ``walk``/``bike``/
``transit`` queries to the graph with profile ``foot``.

Contracts (all GET, all parameters optional unless stated):

- ``/health``                → ``{"service", "ready", "graphs": {id: bool}}``
- ``/graphs``                → discovered graphs and their runtime status
- ``/route3``                → ``a``, ``b`` (``lat,lon``), ``profile``,
                               ``metro``, ``traffic``, ``departure``
- ``/matrix3``               → ``points`` (``lat,lon;...``), ``profile``,
                               ``traffic``, ``metro``, ``departure``, ``planning``
- ``/metro3``                → ``points`` (``lat,lon;...``), ``max_access_m``
- ``/model``                 → service identity and graph metadata

Walk and bike durations are always flat: road distance divided by the graph's
declared average speed. Traffic forecast engines apply to car queries only
when ``traffic=1``.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from graphs import GraphSupervisor, discover_graphs

SERVICE_VERSION = "route-engine3-v1"

ENGINE3_PORT = int(os.environ.get("ENGINE3_PORT", "8124"))
GRAPHS_DIR = Path(os.environ.get("ENGINE3_GRAPHS_DIR", str(Path(__file__).resolve().parent / "graphs")))
PAGE_DIR = os.environ.get("ENGINE3_PAGE_DIR") or None
OSRM_ROUTED = os.environ.get("ENGINE3_OSRM_ROUTED", "osrm-routed")
OSRM_BASE_PORT = int(os.environ.get("ENGINE3_OSRM_BASE_PORT", "5300"))

MODELS: dict[str, str] = {
    "car": "osrm-mld+moscow-radial-v2",
    "foot": "osrm-mld+flat-speed",
}


def build_supervisor() -> GraphSupervisor:
    """Discover graphs from the environment and return a live supervisor."""
    return GraphSupervisor(
        discover_graphs(GRAPHS_DIR),
        base_port=OSRM_BASE_PORT,
        page_dir=PAGE_DIR,
        osrm_routed=OSRM_ROUTED,
    )


REGISTRY: GraphSupervisor | None = None


def handle_health() -> dict:
    """Aggregate readiness: every discovered graph must answer."""
    graphs = {entry["graph_id"]: entry["healthy"] for entry in REGISTRY.snapshot()}
    return {
        "service": SERVICE_VERSION,
        "ready": bool(graphs) and all(graphs.values()),
        "graphs": graphs,
    }


def handle_graphs() -> dict:
    """Discovered graphs with runtime status."""
    return {"service": SERVICE_VERSION, "graphs": REGISTRY.snapshot()}


def handle_model() -> dict:
    """Service identity, per-profile cost models and graph metadata."""
    return {
        "service": SERVICE_VERSION,
        "models": MODELS,
        "walk_bike_policy": "flat average speed, no traffic engines",
        "graphs": REGISTRY.snapshot(),
    }


def handle_route3(params: dict[str, str]) -> dict:
    """One pair, one profile: road geometry plus flat-speed or traffic durations."""
    raise NotImplementedError("route3 lands with the v3 contracts commit")


def handle_matrix3(params: dict[str, str]) -> dict:
    """All-pairs matrix for one profile from one batched OSRM /table call."""
    raise NotImplementedError("matrix3 lands with the v3 contracts commit")


def handle_metro3(params: dict[str, str]) -> dict:
    """Nearest metro stations per point and fast paths between them."""
    raise NotImplementedError("metro3 lands with the v3 contracts commit")


class Handler(BaseHTTPRequestHandler):
    """Thin HTTP shell: parse query, dispatch to a handler, emit JSON."""

    def _send(self, status: int, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, status: int, body: dict) -> None:
        self._send(status, json.dumps(body, ensure_ascii=False).encode("utf-8"), "application/json")

    def _params(self) -> dict[str, str]:
        query = parse_qs(urlparse(self.path).query)
        return {key: values[0] for key, values in query.items() if values}

    def do_GET(self) -> None:  # noqa: N802 (stdlib handler naming)
        path = urlparse(self.path).path
        try:
            if path == "/health":
                self._json(200, handle_health())
            elif path == "/graphs":
                self._json(200, handle_graphs())
            elif path == "/model":
                self._json(200, handle_model())
            elif path == "/route3":
                self._json(200, handle_route3(self._params()))
            elif path == "/matrix3":
                self._json(200, handle_matrix3(self._params()))
            elif path == "/metro3":
                self._json(200, handle_metro3(self._params()))
            else:
                self._json(404, {"error": "unknown endpoint", "path": path})
        except (ValueError, KeyError) as error:
            self._json(400, {"error": str(error)})
        except (OSError, RuntimeError) as error:
            self._json(502, {"error": str(error)})

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        print(f"[{self.log_date_time_string()}] {format % args}", flush=True)


def main() -> None:
    global REGISTRY
    REGISTRY = build_supervisor()
    REGISTRY.start()
    server = ThreadingHTTPServer(("0.0.0.0", ENGINE3_PORT), Handler)
    graphs = ", ".join(spec.graph_id for spec in discover_graphs(GRAPHS_DIR))
    print(f"route-engine3: http://0.0.0.0:{ENGINE3_PORT} (graphs: {graphs or 'none'})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
