"""Durable Router-owned technical settings with atomic local persistence."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from core.contracts import RouterTechnicalSettings


class TechnicalSettingsStore(Protocol):
    """Persistence boundary for settings that must survive Router restarts."""

    def load(self) -> RouterTechnicalSettings | None:
        """Return the saved settings or ``None`` before the first save."""
        ...

    def save(self, settings: RouterTechnicalSettings) -> None:
        """Durably replace the complete settings document."""
        ...


class FileTechnicalSettingsStore:
    """Store one strict UTF-8 JSON document using atomic same-directory replace."""

    def __init__(self, path: Path):
        """Keep a caller-selected Router-private path; no directory is guessed."""
        self.path = path

    def load(self) -> RouterTechnicalSettings | None:
        """Validate the complete saved document and reject malformed state."""
        if not self.path.exists():
            return None
        return RouterTechnicalSettings.model_validate_json(self.path.read_bytes())

    def save(self, settings: RouterTechnicalSettings) -> None:
        """Flush a temporary file before replacing the active settings document."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write((settings.model_dump_json(indent=2) + "\n").encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(self.path)
        finally:
            if temporary.exists():
                temporary.unlink()
