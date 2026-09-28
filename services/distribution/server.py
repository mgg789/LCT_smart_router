"""Private attachment distribution service; configuration and secrets come only from env."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import json
import os
import re
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

MAX_BODY = 1024


class App:
    """Private configuration and persistent pseudonymous request ledger."""

    def __init__(self) -> None:
        self.pin_hash = os.environ["NAVIX_PIN_SHA256"].lower()
        self.ip_key = os.environ["NAVIX_IP_HMAC_KEY"].encode()
        if not re.fullmatch(r"[0-9a-f]{64}", self.pin_hash) or len(self.ip_key) < 16:
            raise ValueError("Configure a PIN hash and at least 16 bytes of HMAC key")
        self.payload = Path(os.environ["NAVIX_PAYLOAD_PATH"])
        if self.payload.is_file() and self.payload.stat().st_size > 262144:
            raise ValueError("Distribution payload exceeds 256 KiB")
        self.db = os.environ.get("NAVIX_STATS_DB", "/var/lib/navix-distribution/stats.sqlite3")
        self.open = os.environ.get("NAVIX_DISTRIBUTION_OPEN", "false").lower() == "true"
        try:
            self.release = configured_release()
        except ValueError:
            # Invalid public metadata must not disable an existing PIN distribution.
            self.release = None
        self.limit = int(os.environ.get("NAVIX_FAILURE_LIMIT", "5"))
        self.window = int(os.environ.get("NAVIX_FAILURE_WINDOW_SEC", "900"))
        if self.limit < 1 or self.window < 1:
            raise ValueError("Rate limit and window must be positive")
        Path(self.db).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as con:
            con.execute(
                "create table if not exists events (at integer not null, ip text not null, outcome text not null)"
            )
            con.execute("create index if not exists events_ip_at on events(ip,at)")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        """Commit/rollback one transaction and always close its connection."""
        connection = sqlite3.connect(self.db, timeout=5)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def ip(self, address: str) -> str:
        """Pseudonymize a network address with the installation HMAC secret."""
        return hmac.new(self.ip_key, address.encode(), hashlib.sha256).hexdigest()

    def record(self, ip: str, outcome: str) -> None:
        """Persist only pseudonymous request metadata, never body or credentials."""
        with self.connect() as con:
            con.execute("insert into events values (?,?,?)", (int(time.time()), ip, outcome))

    def reserve_attempt(self, ip: str) -> bool:
        """Atomically reserve a PIN attempt before reading or validating its body."""
        now = int(time.time())
        with self.connect() as con:
            con.execute("begin immediate")
            count = con.execute(
                "select count(*) from events where ip=? and outcome='attempt' and at>=?",
                (ip, now - self.window),
            ).fetchone()[0]
            if count >= self.limit:
                return False
            con.execute("insert into events values (?,?,?)", (now, ip, "attempt"))
            return True


class Handler(BaseHTTPRequestHandler):
    """Bounded HTTP endpoints; never log credentials, bodies or payload contents."""

    server_version = "navix-distribution/1"

    def log_message(self, *_):
        pass

    @property
    def app(self):
        return self.server.app

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def client_ip(self):
        peer = self.client_address[0]
        if os.environ.get("NAVIX_TRUST_PROXY", "false").lower() != "true":
            return peer
        try:
            return str(ipaddress.ip_address(self.headers.get("X-Real-IP", "")))
        except ValueError:
            return peer

    def send_json(self, status, data):
        raw = json.dumps(data, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/navix/version":
            if self.app.release is None:
                return self.send_json(503, {"error": "release_not_configured"})
            return self.send_json(200, self.app.release)
        if self.path != "/navix/status":
            return self.send_json(404, {"error": "not_found"})
        self.app.record(self.app.ip(self.client_ip()), "status")
        self.send_json(
            200,
            {
                "open": self.app.open,
                "mode": "open" if self.app.open else "closed",
                "pin_required": True,
            },
        )

    def do_POST(self):
        if self.path != "/navix/data":
            return self.send_json(404, {"error": "not_found"})
        ip = self.app.ip(self.client_ip())
        if not self.app.open:
            self.app.record(ip, "closed")
            return self.send_json(403, {"error": "closed"})
        if not self.app.reserve_attempt(ip):
            self.app.record(ip, "rate_limited")
            return self.send_json(429, {"error": "rate_limited"})
        length = self.headers.get("Content-Length")
        if not length or not length.isdigit() or int(length) > MAX_BODY:
            return self.send_json(400, {"error": "invalid_request"})
        try:
            body = json.loads(self.rfile.read(int(length)))
            pin = body.get("pin") if isinstance(body, dict) else None
        except (ValueError, UnicodeDecodeError, TimeoutError):
            pin = None
        valid = (
            isinstance(pin, str)
            and re.fullmatch(r"[0-9]{6}", pin) is not None
            and hmac.compare_digest(hashlib.sha256(pin.encode()).hexdigest(), self.app.pin_hash)
        )
        if not valid:
            self.app.record(ip, "failed")
            return self.send_json(401, {"error": "invalid_pin"})
        if not self.app.payload.is_file() or self.app.payload.stat().st_size > 262144:
            return self.send_json(503, {"error": "unavailable"})
        self.app.record(ip, "success")
        data = self.app.payload.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", 'attachment; filename="navix.env"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def configured_release() -> dict | None:
    """Read public release metadata; PIN availability and private attachments are independent."""
    version = os.environ.get("NAVIX_LATEST_VERSION", "").strip()
    url = os.environ.get("NAVIX_DOWNLOAD_URL", "").strip()
    if not version and not url:
        return None
    if not re.fullmatch(
        r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?",
        version,
    ):
        raise ValueError("Configure NAVIX_LATEST_VERSION as a release version")
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or any(ord(c) < 33 for c in url)
    ):
        raise ValueError("Configure NAVIX_DOWNLOAD_URL as a public HTTPS release link")
    return {"schema_version": 1, "version": version, "download_url": url}


def main() -> None:
    """Start the HTTP service or print aggregate operator-only statistics."""
    p = argparse.ArgumentParser()
    p.add_argument("--stats", action="store_true")
    a = p.parse_args()
    app = App()
    if a.stats:
        with app.connect() as con:
            for row in con.execute(
                "select outcome,count(*) from events group by outcome order by outcome"
            ):
                print(f"{row[0]}={row[1]}")
        return
    create_server(app).serve_forever()


def create_server(app: App, bind: tuple[str, int] | None = None) -> ThreadingHTTPServer:
    """Creates a testable HTTP server with the application attached to handlers."""
    server = ThreadingHTTPServer(
        bind
        or (
            os.environ.get("NAVIX_BIND", "127.0.0.1"),
            int(os.environ.get("PORT", "18891")),
        ),
        Handler,
    )
    server.app = app
    return server


if __name__ == "__main__":
    main()
