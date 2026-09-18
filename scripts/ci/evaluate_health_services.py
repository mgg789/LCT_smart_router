#!/usr/bin/env python3
"""Decide whether a post-deploy health payload is acceptable.

`/health/live` and `/health/ready` must be ok. `/health/services` must show
`database`, `router`, and `smtp` as `ok`. `ai` stays out of scope and is ignored.
SMTP is never a readiness gate for the process (context/43 §11.3), but a CD
that just deployed the mail contour must still fail if that contour is down.
"""

from __future__ import annotations

import json
import sys
from typing import Mapping

MUST_BE_OK = ("database", "router", "smtp")


def evaluate_live(payload: Mapping[str, object]) -> list[str]:
    """Return errors if the liveness body is not `{status: ok}`."""
    status = payload.get("status")
    if status != "ok":
        return [f"live: {status!r}"]
    return []


def evaluate_ready(payload: Mapping[str, object]) -> list[str]:
    """Return errors if readiness is not ok (database is the only required check)."""
    status = payload.get("status")
    if status != "ok":
        return [f"ready: {status!r}"]
    return []


def evaluate_services(services: Mapping[str, object]) -> list[str]:
    """Return one error per required service that is missing or not `ok`."""
    if not services:
        return ["services object is empty"]
    errors: list[str] = []
    for name in MUST_BE_OK:
        item = services.get(name)
        if not isinstance(item, Mapping):
            errors.append(f"{name}: missing")
            continue
        status = item.get("status")
        detail = item.get("detail")
        if status != "ok":
            extra = f" ({detail})" if detail else ""
            errors.append(f"{name}: {status}{extra}")
    return errors


def evaluate_bundle(bundle: Mapping[str, object]) -> list[str]:
    """Evaluate live + ready + services from one object. Returns all errors."""
    live = bundle.get("live")
    ready = bundle.get("ready")
    services_wrapper = bundle.get("services")
    errors: list[str] = []
    if not isinstance(live, Mapping):
        errors.append("live: missing")
    else:
        errors.extend(evaluate_live(live))
    if not isinstance(ready, Mapping):
        errors.append("ready: missing")
    else:
        errors.extend(evaluate_ready(ready))
    if not isinstance(services_wrapper, Mapping):
        errors.append("services: missing")
        return errors
    inner = services_wrapper.get("services", services_wrapper)
    if not isinstance(inner, Mapping):
        errors.append("services: missing")
        return errors
    errors.extend(evaluate_services(inner))
    return errors


def _self_test() -> int:
    healthy = {
        "live": {"status": "ok", "uptimeSec": 12},
        "ready": {"status": "ok", "checks": {"database": {"status": "ok"}}},
        "services": {
            "services": {
                "database": {"status": "ok"},
                "router": {"status": "ok"},
                "smtp": {"status": "ok", "detail": "up; VPN_ONLY"},
                "ai": {"status": "not_configured"},
            }
        },
    }
    assert evaluate_bundle(healthy) == []

    smtp_down = {
        "live": {"status": "ok"},
        "ready": {"status": "ok"},
        "services": {
            "services": {
                "database": {"status": "ok"},
                "router": {"status": "ok"},
                "smtp": {"status": "not_configured", "detail": "no host"},
            }
        },
    }
    assert evaluate_bundle(smtp_down) == ["smtp: not_configured (no host)"]

    ready_down = {
        "live": {"status": "ok"},
        "ready": {"status": "down"},
        "services": {
            "services": {
                "database": {"status": "down"},
                "router": {"status": "ok"},
                "smtp": {"status": "ok"},
            }
        },
    }
    assert evaluate_bundle(ready_down) == ["ready: 'down'", "database: down"]
    return 0


def main(argv: list[str]) -> int:
    if argv[1:] == ["--self-test"]:
        return _self_test()
    bundle = json.load(sys.stdin)
    if not isinstance(bundle, Mapping):
        print("health payload must be a JSON object", file=sys.stderr)
        return 2
    errors = evaluate_bundle(bundle)
    if errors:
        print("health services failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        print(json.dumps(bundle, ensure_ascii=False, indent=2))
        return 1
    print("health services OK")
    print(json.dumps(bundle, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
