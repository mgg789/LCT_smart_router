"""Prepare or migrate the public NAVIX environment file safely."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


def _upsert_key(text: str, key: str, value: str) -> str:
    """Set KEY=value, replacing an existing assignment of the same key."""
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    line = f"{key}={value}"
    if pattern.search(text):
        return pattern.sub(line, text)
    if text and not text.endswith("\n"):
        text += "\n"
    return f"{text}{line}\n"


def prepare_env(
    path: Path,
    *,
    postgres_password: str | None = None,
    router_password: str | None = None,
    dispatcher_password: str | None = None,
) -> None:
    """Apply public-contour defaults and migrate legacy host-bound port values."""
    text = path.read_text(encoding="utf-8")
    if postgres_password is not None:
        text = text.replace("lct_dev_password", postgres_password)
    if router_password is not None:
        text = text.replace("router_dev_password", router_password)
    if dispatcher_password is not None:
        text = text.replace("change-me-before-deploying", dispatcher_password)
    text = text.replace("NODE_ENV=development", "NODE_ENV=production")
    text = text.replace("AUTH_DEV_EXPOSE_CODES=true", "AUTH_DEV_EXPOSE_CODES=false")
    text = text.replace("API_PORT=127.0.0.1:18080", "API_PORT=18080")
    text = text.replace("API_PORT=8000", "API_PORT=18080")
    text = text.replace("ROUTER_PORT=8100", "ROUTER_PORT=18100")
    text = _upsert_key(text, "DEMO_STAND", "true")
    text = _upsert_key(text, "speed_up_work_stub", "1800")
    path.write_text(text, encoding="utf-8")


def main() -> None:
    """Parse bootstrap arguments and update one environment file."""
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--postgres-password")
    parser.add_argument("--router-password")
    parser.add_argument("--dispatcher-password")
    args = parser.parse_args()
    prepare_env(
        args.path,
        postgres_password=args.postgres_password,
        router_password=args.router_password,
        dispatcher_password=args.dispatcher_password,
    )


if __name__ == "__main__":
    main()
