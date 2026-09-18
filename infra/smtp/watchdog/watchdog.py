#!/usr/bin/env python3
"""Watchdog for the Navix SMTP host.

Hysteria 2 on this host is a one-way proxy: the MGG client can reach us, we cannot
dial back through the tunnel. The operational equivalent of context/35 section 11
is therefore a beat that travels MGG → SMTP through the tunnel. Missed beats open
the public submission port; recovered beats close it again.

This process never claims that a message reached a mailbox.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

LISTEN_HOST = os.environ.get("WATCHDOG_LISTEN", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("WATCHDOG_PORT", "8587"))
TOKEN = os.environ.get("WATCHDOG_TOKEN", "")
INTERVAL_SEC = int(os.environ.get("WATCHDOG_INTERVAL_SEC", "15"))
FAIL_THRESHOLD = int(os.environ.get("WATCHDOG_FAIL_THRESHOLD", "3"))
SUCCESS_THRESHOLD = int(os.environ.get("WATCHDOG_SUCCESS_THRESHOLD", "3"))
BEAT_STALE_SEC = int(os.environ.get("WATCHDOG_BEAT_STALE_SEC", "45"))
STATE_PATH = Path(os.environ.get("WATCHDOG_STATE_PATH", "/var/lib/navix-smtp/watchdog-state.json"))

VPN_ONLY = "VPN_ONLY"
VPN_PLUS_DIRECT_TLS = "VPN_PLUS_DIRECT_TLS"

_lock = threading.Lock()
_last_beat = 0.0
_mode = VPN_ONLY
_fail_streak = 0
_success_streak = 0
_last_errors: list[str] = []


def now() -> int:
    return int(time.time())


def remember_error(message: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with _lock:
        _last_errors.append(f"{stamp} {message}")
        del _last_errors[:-8]


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=False, capture_output=True, text=True)


def postfix_running() -> bool:
    return run(["systemctl", "is-active", "--quiet", "postfix"]).returncode == 0


def queue_depth() -> int:
    result = run(["mailq"])
    text = result.stdout
    if "Mail queue is empty" in text:
        return 0
    return sum(1 for line in text.splitlines() if line.startswith((" ", "\t")) is False and line[:10].strip().isalnum() and len(line.split()[0]) >= 8)


def ensure_chain() -> None:
    if run(["iptables", "-nL", "NAVIX_SMTP"]).returncode != 0:
        run(["iptables", "-N", "NAVIX_SMTP"])
    listed = run(["iptables", "-nL", "INPUT", "--line-numbers"])
    if "NAVIX_SMTP" not in listed.stdout:
        run(["iptables", "-I", "INPUT", "1", "-p", "tcp", "--dport", "587", "-j", "NAVIX_SMTP"])


def apply_mode(mode: str) -> None:
    ensure_chain()
    run(["iptables", "-F", "NAVIX_SMTP"])
    run(["iptables", "-A", "NAVIX_SMTP", "-i", "lo", "-j", "ACCEPT"])
    run(["iptables", "-A", "NAVIX_SMTP", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"])
    if mode == VPN_PLUS_DIRECT_TLS:
        run(["iptables", "-A", "NAVIX_SMTP", "-p", "tcp", "--dport", "587", "-j", "ACCEPT"])
    else:
        run(["iptables", "-A", "NAVIX_SMTP", "-j", "DROP"])


def persist() -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "mode": _mode,
        "last_beat": int(_last_beat),
        "updated_at": now(),
    }
    STATE_PATH.write_text(json.dumps(payload), encoding="utf-8")


def evaluate() -> None:
    global _mode, _fail_streak, _success_streak
    with _lock:
        last = _last_beat
        mode = _mode
    vpn_up = last > 0 and (time.time() - last) <= BEAT_STALE_SEC
    if vpn_up:
        _success_streak += 1
        _fail_streak = 0
        if mode != VPN_ONLY and _success_streak >= SUCCESS_THRESHOLD:
            _mode = VPN_ONLY
            apply_mode(VPN_ONLY)
            persist()
    else:
        _fail_streak += 1
        _success_streak = 0
        if mode != VPN_PLUS_DIRECT_TLS and _fail_streak >= FAIL_THRESHOLD:
            _mode = VPN_PLUS_DIRECT_TLS
            apply_mode(VPN_PLUS_DIRECT_TLS)
            persist()


def health() -> dict[str, Any]:
    with _lock:
        last = _last_beat
        mode = _mode
        errors = list(_last_errors)
    accept_ready = postfix_running()
    return {
        "status": "ok" if accept_ready else "down",
        "postfix": "up" if accept_ready else "down",
        "accepts_mail": accept_ready,
        "queue_depth": queue_depth() if accept_ready else None,
        "access_mode": mode,
        "last_beat_at": int(last) if last else None,
        "checked_at": now(),
        "last_errors": errors,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "navix-smtp-watchdog/1"

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or "0")
        return self.rfile.read(length) if length else b""

    def _authorized(self) -> bool:
        if not TOKEN:
            return False
        header = self.headers.get("Authorization", "")
        return header == f"Bearer {TOKEN}"

    def _send(self, code: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/health":
            self._send(404, {"error": "not_found"})
            return
        self._send(200, health())

    def do_POST(self) -> None:  # noqa: N802
        self._read_body()
        if self.path.split("?", 1)[0] != "/beat":
            self._send(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        global _last_beat
        with _lock:
            _last_beat = time.time()
        persist()
        self._send(204, {})


def loop() -> None:
    while True:
        try:
            evaluate()
        except Exception as exc:  # noqa: BLE001 — daemon must keep running
            remember_error(str(exc))
        time.sleep(INTERVAL_SEC)


def main() -> None:
    if not TOKEN:
        raise SystemExit("WATCHDOG_TOKEN is required")
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    apply_mode(VPN_ONLY)
    persist()
    threading.Thread(target=loop, name="watchdog-eval", daemon=True).start()
    httpd = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
