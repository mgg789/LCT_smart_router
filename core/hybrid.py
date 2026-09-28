"""Hybrid planning: fast baseline solve, /route3 verification, one re-solve.

The hybrid mode keeps planning latency dominated by the cheap prepared costs
(haversine fallbacks or the regional graph) and spends the route-engine3
budget where it changes decisions:

1. solve the snapshot with the fast provider as configured by planning_travel;
2. verify every chosen leg against /route3 — traffic-factored car times,
   foot-graph pedestrian routes with metro composites;
3. when the corrected schedule breaks any job window, re-solve once with the
   verified pairs overriding the baseline costs; otherwise keep the fast plan
   and report the drift.

The verification layer sits under the same technical stack (profile policy,
forecast traffic, metro, weather) as the baseline: the corrected travel is
re-wrapped by configure_travel, so weather and band factors apply to verified
durations exactly as they do to fast ones.

Env: ``ROUTER_HYBRID=1`` enables the mode in runtime; without ``ROUTE3_URL``
hybrid_plan degrades to a single fast solve and returns no report.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from core.contracts import RouterTaskSnapshot
from core.engine import EngineMemory, EngineOutput, SearchSettings, solve
from core.geo import TravelSource, configure_travel
from core.route3 import Route3Client, VerifiedRoute3, verify_plan_with_route3


def hybrid_enabled() -> bool:
    """True when the runtime should plan through the hybrid pipeline."""
    return os.environ.get("ROUTER_HYBRID", "").lower() in {"1", "true", "yes"}


def _unwrap_technical(travel) -> TravelSource:
    """Peel the technical wrappers down to the raw source the layers were built on."""
    from core.geo import ForecastTrafficTravel, ProfilePolicyTravel, TechnicalTravel
    from core.metro import MetroTravel
    from core.weather import WeatherTravel

    while isinstance(
        travel, (TechnicalTravel, ForecastTrafficTravel, MetroTravel, ProfilePolicyTravel, WeatherTravel)
    ):
        travel = travel.travel
    return travel


@dataclass(frozen=True)
class HybridRun:
    """The chosen output, the provider evidence must be built with, the report."""

    output: EngineOutput
    provider: TravelSource
    verification: dict | None


def hybrid_plan(
    snapshot: RouterTaskSnapshot,
    provider,
    settings: SearchSettings,
    memory: EngineMemory | None,
    context_version: str | None,
    *,
    client: Route3Client | None = None,
) -> HybridRun:
    """Run the fast→verify→(maybe)re-solve pipeline for one snapshot.

    Any verification failure (engine down, malformed body) degrades to the
    fast plan with no report: hybrid verification must never turn a working
    planner into an error.
    """
    output = solve(snapshot, provider, settings, memory, context_version)
    if client is None:
        return HybridRun(output, provider, None)
    try:
        verification = verify_plan_with_route3(client, output.memory.snapshot, output.main)
    except Exception as exc:  # noqa: BLE001 — any engine outage must degrade, not fail
        import logging

        logging.getLogger(__name__).warning(
            "ROUTE3_VERIFICATION_UNAVAILABLE code=%s; keeping the fast plan", type(exc).__name__
        )
        return HybridRun(output, provider, None)
    breaches = [row["window_breach"] for row in verification["routes"] if row["window_breach"]]
    if not breaches or not verification["corrections"]:
        return HybridRun(output, provider, verification)
    corrected_base = VerifiedRoute3(_unwrap_technical(provider), verification["corrections"])
    corrected_provider = configure_travel(
        corrected_base, settings.technical(), snapshot.planning_as_of
    )
    corrected_output = solve(snapshot, corrected_provider, settings, memory, context_version)
    return HybridRun(corrected_output, corrected_provider, verification)
