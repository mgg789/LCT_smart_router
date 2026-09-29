"""Hybrid pipeline: fast solve, verification, corrected re-solve on breaches."""

import pytest
from core.engine import SearchSettings
from core.geo import TravelQuote
from core.hybrid import hybrid_enabled, hybrid_plan
from core.route3 import VerifiedRoute3

A = (55.75, 37.60)
B = (55.78, 37.66)


class FakePlan:
    def __init__(self):
        self.assignments = []


class FakeMemory:
    def __init__(self):
        self.snapshot = "effective-snapshot"


class FakeOutput:
    def __init__(self):
        self.main = FakePlan()
        self.memory = FakeMemory()


class FakeTechnical:
    metro_enabled = True


class FakeSettings:
    def technical(self):
        return FakeTechnical()


def test_hybrid_enabled(monkeypatch):
    monkeypatch.delenv("ROUTER_HYBRID", raising=False)
    assert hybrid_enabled() is False
    monkeypatch.setenv("ROUTER_HYBRID", "1")
    assert hybrid_enabled() is True


def _patch_verification(monkeypatch, hybrid, report):
    """The re-solved plan reuses the same pairs, so the second round adds none."""

    def verify(client, snapshot, plan, *, known=None, **_kwargs):
        return {**report, "new_legs": 0 if known else len(report["corrections"])}

    monkeypatch.setattr(hybrid, "verify_plan_with_route3", verify)


def test_hybrid_degrades_without_client(monkeypatch):
    with pytest.raises(RuntimeError, match="ROUTE3_VERIFICATION_REQUIRED"):
        hybrid_plan("snapshot", "provider", FakeSettings(), None, "ctx", client=None)


def test_hybrid_applies_verified_pairs_without_a_window_breach(monkeypatch):
    from core import hybrid

    class FakeSnapshot:
        planning_as_of = 0

    report = {
        "verified_legs": 3,
        "corrections": {(A[0], A[1], B[0], B[1], "car"): TravelQuote(600, 5000, (), "traffic_api")},
        "routes": [{"engineer_id": "eng-1", "window_breach": None}],
    }
    _patch_verification(monkeypatch, hybrid, report)
    providers = []

    def fake_solve(snapshot, provider, settings, memory, context_version):
        providers.append(provider)
        return FakeOutput()

    monkeypatch.setattr(hybrid, "solve", fake_solve)
    run = hybrid_plan(FakeSnapshot(), FakeBase(), SearchSettings(), None, "ctx", client="client")
    assert len(providers) == 2
    corrected = hybrid._unwrap_technical(providers[1])
    assert isinstance(corrected, VerifiedRoute3)
    assert corrected.corrections is report["corrections"]
    assert run.verification["corrections"] is report["corrections"]
    assert run.provider is providers[1]


def test_hybrid_verifies_legs_the_re_solve_introduced(monkeypatch):
    from core import hybrid

    class FakeSnapshot:
        planning_as_of = 0

    first = (A[0], A[1], B[0], B[1], "car")
    second = (B[0], B[1], A[0], A[1], "car")
    rounds = [{first}, {first, second}, {first, second}]
    calls = []

    def verify(client, snapshot, plan, *, known=None, **_kwargs):
        pairs = rounds[len(calls)]
        corrections = {**(known or {}), **{key: TravelQuote(600, 5000, (), "traffic_api") for key in pairs}}
        calls.append(dict(known or {}))
        return {"corrections": corrections, "new_legs": len(corrections) - len(known or {}), "routes": []}

    monkeypatch.setattr(hybrid, "verify_plan_with_route3", verify)
    providers = []
    monkeypatch.setattr(hybrid, "solve", lambda s, p, *a: providers.append(p) or FakeOutput())
    run = hybrid_plan(FakeSnapshot(), FakeBase(), SearchSettings(), None, "ctx", client="client")
    # fast solve, re-solve on the first pair, re-solve on the pair it introduced
    assert len(providers) == 3 and len(calls) == 3
    assert set(calls[1]) == {first}  # earlier pairs are passed on, not re-requested
    assert set(hybrid._unwrap_technical(run.provider).corrections) == {first, second}


class FakeBase:
    """Minimal TravelSource stand-in for the corrected-wrapper assertions."""

    version = "fake-base-v1"
    provenance = "approximate"

    def quote(self, origin, destination, profile):
        return None

    def quote_at(self, origin, destination, profile, departure_at):
        return None


def test_hybrid_resolves_on_window_breach(monkeypatch):
    from core import hybrid

    class FakeSnapshot:
        planning_as_of = 0

    report = {
        "verified_legs": 2,
        "corrections": {(A[0], A[1], B[0], B[1], "car"): TravelQuote(1800, 5000, (), "traffic_api")},
        "routes": [{"engineer_id": "eng-1", "window_breach": {"request_id": "job-1"}}],
    }
    _patch_verification(monkeypatch, hybrid, report)
    providers = []

    def fake_solve(snapshot, provider, settings, memory, context_version):
        providers.append(provider)
        return FakeOutput()

    monkeypatch.setattr(hybrid, "solve", fake_solve)
    settings = SearchSettings()  # the real technical stack rebuilds around corrections
    run = hybrid_plan(FakeSnapshot(), FakeBase(), settings, None, "ctx", client="client")
    assert len(providers) == 2
    corrected = hybrid._unwrap_technical(providers[1])
    assert isinstance(corrected, VerifiedRoute3)
    assert corrected.corrections is report["corrections"]
    assert run.provider is providers[1]  # evidence must be built with corrected costs
    assert run.output is not None


def test_hybrid_degrades_on_verification_failure(monkeypatch):
    from core import hybrid

    def broken(client, snapshot, plan, **_kwargs):
        raise ConnectionError("engine down")

    monkeypatch.setattr(hybrid, "verify_plan_with_route3", broken)
    calls = []
    monkeypatch.setattr(hybrid, "solve", lambda *a, **k: calls.append(a) or FakeOutput())
    with pytest.raises(RuntimeError, match="ROUTE3_VERIFICATION_FAILED"):
        hybrid_plan("snapshot", "provider", FakeSettings(), None, "ctx", client="client")
    assert len(calls) == 1
