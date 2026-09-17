"""Durable Router-owned technical settings with atomic local persistence."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from core.contracts import RouterTechnicalSettings


@dataclass(frozen=True)
class StoredTechnicalSettingsOperation:
    """One durable idempotency receipt for a settings replacement."""

    requested: RouterTechnicalSettings
    expected_context_version: str
    response: dict[str, Any]


class TechnicalSettingsStore(Protocol):
    """Persistence boundary for settings that must survive Router restarts."""

    def load(self) -> RouterTechnicalSettings | None:
        """Return the saved settings or ``None`` before the first save."""
        ...

    def save(self, settings: RouterTechnicalSettings) -> None:
        """Durably replace the complete settings document."""
        ...

    def load_operations(self) -> dict[str, StoredTechnicalSettingsOperation]:
        """Return durable operation receipts keyed by caller-supplied id."""
        ...

    def save_operation(
        self,
        settings: RouterTechnicalSettings,
        operation_id: str,
        operation: StoredTechnicalSettingsOperation,
    ) -> None:
        """Atomically persist settings and their idempotency receipt."""
        ...


class _StoredOperation(BaseModel):
    """Strict on-disk representation of one operation receipt."""

    model_config = ConfigDict(extra="forbid")

    operation_id: str = Field(min_length=1, max_length=128)
    requested: RouterTechnicalSettings
    expected_context_version: str = Field(min_length=1)
    response: dict[str, Any]


class _SettingsDocument(BaseModel):
    """Versioned Router-private state written as one atomic document."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0"] = "1.0"
    settings: RouterTechnicalSettings
    operations: list[_StoredOperation] = Field(default_factory=list)


class FileTechnicalSettingsStore:
    """Store one strict UTF-8 JSON document using atomic same-directory replace."""

    def __init__(self, path: Path):
        """Keep a caller-selected Router-private path; no directory is guessed."""
        self.path = path

    def load(self) -> RouterTechnicalSettings | None:
        """Validate the complete saved document and reject malformed state."""
        if not self.path.exists():
            return None
        return self._read().settings

    def save(self, settings: RouterTechnicalSettings) -> None:
        """Flush a temporary file before replacing the active settings document."""
        operations = self._read().operations if self.path.exists() else []
        self._write(_SettingsDocument(settings=settings, operations=operations))

    def load_operations(self) -> dict[str, StoredTechnicalSettingsOperation]:
        """Load exact receipts so a restart cannot lose operation attribution."""
        if not self.path.exists():
            return {}
        return {
            item.operation_id: StoredTechnicalSettingsOperation(
                requested=item.requested,
                expected_context_version=item.expected_context_version,
                response=dict(item.response),
            )
            for item in self._read().operations
        }

    def save_operation(
        self,
        settings: RouterTechnicalSettings,
        operation_id: str,
        operation: StoredTechnicalSettingsOperation,
    ) -> None:
        """Replace settings and append one unique receipt in the same atomic write."""
        document = self._read() if self.path.exists() else _SettingsDocument(settings=settings)
        operations = {item.operation_id: item for item in document.operations}
        operations[operation_id] = _StoredOperation(
            operation_id=operation_id,
            requested=operation.requested,
            expected_context_version=operation.expected_context_version,
            response=operation.response,
        )
        self._write(
            _SettingsDocument(
                settings=settings,
                operations=[operations[key] for key in sorted(operations)],
            )
        )

    def _read(self) -> _SettingsDocument:
        raw = self.path.read_bytes()
        try:
            return _SettingsDocument.model_validate_json(raw)
        except Exception as document_error:
            try:
                legacy = RouterTechnicalSettings.model_validate_json(raw)
            except Exception:
                raise document_error
            return _SettingsDocument(settings=legacy)

    def _write(self, document: _SettingsDocument) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write((document.model_dump_json(indent=2) + "\n").encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(self.path)
        finally:
            if temporary.exists():
                temporary.unlink()
