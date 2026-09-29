"""Guard benchmark conclusions against fallback, cache failure and changed output."""

import pytest
from infra.benchmark_redis_route3 import IDENTITY_FIELDS, validate_quality, validate_trial


def trial(budget=1000):
    """Build the minimal public evidence required by the benchmark validators."""
    return {
        "label": "test", "settings": {"time_limit_ms": budget},
        "cache": {"enabled": True, "hits": 1, "writes": 0, "errors": 0},
        "route3": {"verified_legs": 2},
        **{field: "same" for field in IDENTITY_FIELDS},
    }


def test_cache_hit_requires_live_hybrid_evidence():
    evidence = trial()
    validate_trial(evidence, "hit")
    evidence["route3"]["verified_legs"] = 0
    with pytest.raises(RuntimeError, match="Unexpected behavior"):
        validate_trial(evidence, "hit")


def test_miss_is_not_reported_as_hit():
    evidence = trial()
    evidence["cache"]["hits"] = 0
    with pytest.raises(RuntimeError, match="Unexpected behavior"):
        validate_trial(evidence, "hit")


def test_quality_retains_full_plan_and_groups_only_equal_budgets():
    first, second = trial(), trial(8000)
    second["catalog_plans_digest"] = "different-budget-plan"
    validate_quality([first, second])
    second["settings"]["time_limit_ms"] = 1000
    with pytest.raises(RuntimeError, match="catalog_plans_digest"):
        validate_quality([first, second])
