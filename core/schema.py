"""Generate checked Router boundary schemas for parallel sys/data-layer integration."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from core.api import TechnicalSettingsRequest
from core.contracts import (
    RouterResult,
    RouterTaskSnapshot,
    RouterTechnicalSettings,
    SnapshotPublicationEnvelope,
)

_SCHEMAS = {
    "router-task-snapshot-1.0.json": RouterTaskSnapshot,
    "router-result-1.0.json": RouterResult,
    "router-technical-settings-v2.json": RouterTechnicalSettings,
    "router-technical-settings-request-v2.json": TechnicalSettingsRequest,
    "special-sector-publication-v2.json": SnapshotPublicationEnvelope,
}


def write_schemas(output_dir: Path) -> None:
    """Write stable UTF-8 JSON Schemas for every cross-component Router boundary."""
    output_dir.mkdir(parents=True, exist_ok=True)
    for filename, model in _SCHEMAS.items():
        payload = model.model_json_schema(mode="validation")
        (output_dir / filename).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )


def main() -> None:
    """Regenerate schemas in the repository's default contract directory."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("core/schemas"))
    args = parser.parse_args()
    write_schemas(args.output_dir)


if __name__ == "__main__":
    main()
