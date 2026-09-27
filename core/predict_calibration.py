"""Learnable calibration of the plan-assessment simulator; factory defaults first.

Every dispersion parameter the Monte-Carlo replay uses lives here, so execution
facts can replace the initial lab assumptions without touching the algorithm.
The document is versioned by its own content: identical inputs produce the same
version, and a changed version legitimately changes prediction reports.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import Field

from core.contracts import Record, Transport


class CalibrationRegime(Record):
    """One correlated day regime: a probability and a travel multiplier."""

    name: str = Field(min_length=1, max_length=32)
    probability: float = Field(ge=0.0, le=1.0)
    travel_multiplier: float = Field(ge=0.5, le=3.0)


class LearnedFrom(Record):
    """Provenance of a learned calibration: what the numbers were fit on."""

    service_samples: int = Field(ge=0)
    leg_samples: int = Field(ge=0)
    cancel_requests: int = Field(ge=0)
    execution_days: int = Field(ge=0)


class WeatherMultiplierCalibration(Record):
    """Validated, region- and transport-specific weather factor for predictions."""

    region: str = Field(min_length=1, max_length=128)
    transport_type: Transport
    kind: Literal["rain", "snow", "storm"]
    multiplier: float = Field(ge=0.5, le=3.0)
    source: Literal["learned"]
    observations: int = Field(ge=0)
    days: int = Field(ge=0)
    baseline_travel_error: float = Field(ge=0)
    candidate_travel_error: float = Field(ge=0)
    baseline_brier: float = Field(ge=0, le=1)
    candidate_brier: float = Field(ge=0, le=1)
    validation_version: str = Field(min_length=1, max_length=64)


class PredictCalibration(Record):
    """Complete simulator calibration; ``factory`` source means lab assumptions."""

    service_cv: float = Field(ge=0.0, le=1.0)
    leg_cv_short: float = Field(ge=0.0, le=1.0)
    leg_cv_long: float = Field(ge=0.0, le=1.0)
    cancel_rate: float = Field(ge=0.0, le=1.0)
    regimes: list[CalibrationRegime] = Field(min_length=1, max_length=8)
    weather_multipliers: list[WeatherMultiplierCalibration] = Field(default_factory=list, max_length=512)
    working_set_generation: int = Field(default=1, ge=1)
    source: Literal["factory", "learned"] = "factory"
    learned_from: LearnedFrom | None = None

    def content_version(self) -> str:
        """Stable identity of the parameter set; changes whenever numbers change."""
        payload = json.dumps(
            self.model_dump(exclude={"learned_from"}), sort_keys=True, separators=(",", ":")
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def factory_calibration() -> PredictCalibration:
    """Lab-calibrated assumptions (ml-lab 2026-09-23, validated on control days)."""
    return PredictCalibration(
        service_cv=0.30,
        leg_cv_short=0.30,
        leg_cv_long=0.10,
        cancel_rate=0.10,
        regimes=[
            CalibrationRegime(name="normal", probability=0.65, travel_multiplier=1.00),
            CalibrationRegime(name="rain", probability=0.30, travel_multiplier=1.12),
            CalibrationRegime(name="heavy", probability=0.05, travel_multiplier=1.25),
        ],
        weather_multipliers=[],
        source="factory",
    )


class PredictCalibrationStore:
    """Store one strict UTF-8 JSON calibration using atomic same-directory replace."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> PredictCalibration:
        """Return the saved document, or the factory set when nothing was saved."""
        if not self.path.exists():
            return factory_calibration()
        try:
            return PredictCalibration.model_validate_json(self.path.read_bytes())
        except Exception:
            return factory_calibration()

    def save(self, calibration: PredictCalibration) -> None:
        """Flush a temporary file before replacing the active calibration."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_bytes(calibration.model_dump_json().encode("utf-8"))
        tmp.replace(self.path)
