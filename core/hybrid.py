"""Hybrid planning: fast baseline solve, then /route3 verify→re-solve rounds.

The hybrid mode keeps planning latency dominated by the cheap prepared costs
(haversine fallbacks or the regional graph) and spends the route-engine3
budget where it changes decisions:

1. solve the snapshot with the fast provider as configured by planning_travel;
2. verify every chosen leg against /route3 — traffic-factored car times,
   foot-graph pedestrian routes with metro composites;
3. re-solve with those verified pairs, so the published geometry and
   durations are the engine's, not the fast graph's. A re-solve may pick legs
   nobody verified yet, so steps 2–3 repeat on the new plan's unverified legs
   until none are left (``MAX_VERIFY_ROUNDS`` caps it). A window breach is
   what the report calls out; it is not what decides whether pairs apply.

The verification layer sits under the same technical stack (profile policy,
forecast traffic, metro, weather) as the baseline: the corrected travel is
re-wrapped by configure_travel, so weather and band factors apply to verified
durations exactly as they do to fast ones.

Env: ``ROUTER_HYBRID=1`` enables the mode in runtime; without ``ROUTE3_URL``
hybrid_plan degrades to a single fast solve and returns no report.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, replace

from core.contracts import RouterTaskSnapshot
from core.engine import EngineMemory, EngineOutput, SearchSettings, solve
from core.geo import TravelSource, configure_travel
from core.route3 import Route3Client, VerifiedRoute3, verify_plan_with_route3

MAX_VERIFY_ROUNDS = 4
"""Re-solves after the fast one; each round only adds pairs the new plan introduced."""


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
    """Run the fast→verify→re-solve pipeline for one snapshot.

    Any verification failure (engine down, malformed body) degrades to the
    fast plan with no report: hybrid verification must never turn a working
    planner into an error.
    """
    log = logging.getLogger(__name__)
    output = solve(snapshot, provider, settings, memory, context_version)
    if client is None:
        return HybridRun(output, provider, None)
    chosen, chosen_provider, report = output, provider, None
    corrections: dict = {}
    for round_index in range(MAX_VERIFY_ROUNDS + 1):
        try:
            verification = verify_plan_with_route3(
                client,
                chosen.memory.snapshot,
                chosen.main,
                metro=settings.technical().metro_enabled,
                known=corrections,
            )
        except Exception as exc:  # noqa: BLE001 — any engine outage must degrade, not fail
            log.warning(
                "ROUTE3_VERIFICATION_UNAVAILABLE code=%s; keeping the last plan", type(exc).__name__
            )
            return HybridRun(chosen, chosen_provider, report)
        report = verification
        if not verification["new_legs"]:
            # Every leg of the chosen plan is already a verified pair.
            return HybridRun(chosen, chosen_provider, report)
        if round_index == MAX_VERIFY_ROUNDS:
            break
        corrections = verification["corrections"]
        corrected_provider = configure_travel(
            VerifiedRoute3(_unwrap_technical(provider), corrections),
            settings.technical(),
            snapshot.planning_as_of,
        )
        try:
            verify_settings = replace(settings, time_limit_ms=settings.resolved_verify_ms())
            chosen = solve(snapshot, corrected_provider, verify_settings, memory, context_version)
        except Exception as exc:  # noqa: BLE001 — a bad verified quote must not discard the plan
            log.warning("ROUTE3_RESOLVE_FAILED code=%s; keeping the last plan", type(exc).__name__)
            return HybridRun(chosen, chosen_provider, report)
        chosen_provider = corrected_provider
    log.warning("ROUTE3_VERIFY_ROUNDS_EXHAUSTED; unverified legs keep fallback geometry")
    return HybridRun(chosen, chosen_provider, report)
