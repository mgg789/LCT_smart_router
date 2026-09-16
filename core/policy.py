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
]
SearchStage = Literal["coverage", "travel_time", "distance", "engineers_used"]


@dataclass(frozen=True)
class PolicySpec:
    """Compiled immutable objective order for one supported dispatcher preset."""

    policy_id: Literal["fast", "compact"]
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
        # Engineer count remains the final candidate tie-break for the v1 fast profile.
        search_stages=("coverage", "travel_time", "distance"),
    ),
    "compact": PolicySpec(
        policy_id="compact",
        definition_version="compact-1",
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
    return {
        "urgent_unassigned": summary.urgent_total - summary.urgent_assigned_count,
        "unassigned": summary.unassigned_count,
        "missed_optional_lunches": missed,
        "travel_time": summary.travel_time_sec,
        "distance": round(summary.distance_km * 1000),
        "engineers_used": summary.engineers_used,
    }


def policy_score(snapshot: RouterTaskSnapshot, plan: Plan) -> tuple[int, ...]:
    """Return the lexicographic score selected by the snapshot's compiled policy."""
    spec = compile_policy(snapshot.policy)
    values = criterion_values(snapshot, plan)
    return tuple(values[criterion] for criterion in spec.ordered_criteria)
