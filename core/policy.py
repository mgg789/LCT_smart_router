"""Versioned Router policy catalog and candidate comparison."""

import json
from dataclasses import asdict, dataclass
from hashlib import sha256
from typing import Literal

from core.contracts import Plan, Policy, RouterTaskSnapshot

Criterion = Literal[
    "urgent_unassigned",
    "unassigned",
    "missed_optional_lunches",
    "travel_time",
    "distance",
    "engineers_used",
    "window_start_delay",
    "max_jobs_per_engineer",
]
SearchStage = Literal[
    "coverage",
    "travel_time",
    "distance",
    "engineers_used",
    "window_start_delay",
    "max_jobs_per_engineer",
]


@dataclass(frozen=True)
class PolicySpec:
    """Compiled immutable objective order for one supported dispatcher preset."""

    policy_id: Literal["fast", "compact", "sla", "balanced", "eco", "covering"]
    definition_version: str
    ordered_criteria: tuple[Criterion, ...]
    search_stages: tuple[SearchStage, ...]


_COVERAGE: tuple[Criterion, ...] = (
    "urgent_unassigned",
    "unassigned",
    "missed_optional_lunches",
)
_CATALOG: dict[str, PolicySpec] = {
    "fast": PolicySpec(
        policy_id="fast",
        definition_version="fast-1",
        ordered_criteria=_COVERAGE + ("travel_time", "distance", "engineers_used"),
        search_stages=("coverage", "travel_time", "distance", "engineers_used"),
    ),
    "compact": PolicySpec(
        policy_id="compact",
        definition_version="compact-1",
        ordered_criteria=_COVERAGE + ("engineers_used", "distance", "travel_time"),
        search_stages=("coverage", "engineers_used", "distance", "travel_time"),
    ),
    "sla": PolicySpec(
        policy_id="sla",
        definition_version="sla-1",
        ordered_criteria=_COVERAGE
        + ("window_start_delay", "travel_time", "distance", "engineers_used"),
        search_stages=(
            "coverage",
            "window_start_delay",
            "travel_time",
            "distance",
            "engineers_used",
        ),
    ),
    "balanced": PolicySpec(
        policy_id="balanced",
        definition_version="balanced-1",
        ordered_criteria=_COVERAGE
        + ("max_jobs_per_engineer", "travel_time", "distance", "engineers_used"),
        search_stages=(
            "coverage",
            "max_jobs_per_engineer",
            "travel_time",
            "distance",
            "engineers_used",
        ),
    ),
    "eco": PolicySpec(
        policy_id="eco",
        definition_version="eco-1",
        ordered_criteria=_COVERAGE + ("distance", "engineers_used", "travel_time"),
        search_stages=("coverage", "distance", "engineers_used", "travel_time"),
    ),
    "covering": PolicySpec(
        policy_id="covering",
        definition_version="covering-1",
        ordered_criteria=_COVERAGE + ("engineers_used", "distance", "travel_time"),
        search_stages=("coverage", "engineers_used", "distance", "travel_time"),
    ),
}
POLICY_CATALOG_VERSION = sha256(
    json.dumps(
        [asdict(_CATALOG[policy_id]) for policy_id in sorted(_CATALOG)],
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
).hexdigest()


def compile_policy(policy: Policy) -> PolicySpec:
    """Return the exact catalog definition or fail instead of silently falling back."""
    try:
        return _CATALOG[policy.policy_id]
    except KeyError:
        raise ValueError(f"POLICY_UNSUPPORTED: {policy.policy_id}") from None


def criterion_values(snapshot: RouterTaskSnapshot, plan: Plan) -> dict[Criterion, int]:
    """Calculate every supported objective from validated jobs and route intervals."""
    lunches = {route.engineer_id: route.lunch.status for route in plan.routes}
    missed = sum(
        engineer.lunch.enabled
        and not engineer.lunch_taken
        and not engineer.lunch.required
        and lunches.get(engineer.engineer_id) != "scheduled"
        for engineer in snapshot.engineers
    )
    summary = plan.summary
    requests = {request.request_id: request for request in snapshot.requests}
    job_stops = [
        stop
        for route in plan.routes
        for stop in route.stops
        if stop.kind == "job" and stop.request_id is not None
    ]
    return {
        "urgent_unassigned": summary.urgent_total - summary.urgent_assigned_count,
        "unassigned": summary.unassigned_count,
        "missed_optional_lunches": missed,
        "travel_time": summary.travel_time_sec,
        "distance": round(summary.distance_km * 1000),
        "engineers_used": summary.engineers_used,
        "window_start_delay": sum(
            stop.start_at - requests[stop.request_id].window_start_at for stop in job_stops
        ),
        "max_jobs_per_engineer": max(
            (route.metrics.assigned_count for route in plan.routes), default=0
        ),
    }


def policy_score(snapshot: RouterTaskSnapshot, plan: Plan) -> tuple[int, ...]:
    """Return the lexicographic score selected by the snapshot's compiled policy."""
    spec = compile_policy(snapshot.policy)
    values = criterion_values(snapshot, plan)
    return tuple(values[criterion] for criterion in spec.ordered_criteria)
