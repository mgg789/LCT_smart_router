"""Validity tests for the seeded dataset generator (context/14 §6 subset)."""

import pytest

from core.gen import WORK_TYPES, generate
from core.types import solver_input_from_dict


def test_generation_is_deterministic():
    assert generate("mini", 42) == generate("mini", 42)
    assert generate("full", 7) == generate("full", 7)


def test_unknown_scenario_rejected():
    with pytest.raises(ValueError):
        generate("huge", 1)


def test_mini_scenario_shape():
    data = generate("mini", 42)
    assert len(data["engineers"]) == 5
    assert len(data["requests"]) == 10
    inp = solver_input_from_dict(data)
    ids = [r.id for r in inp.requests]
    assert len(ids) == len(set(ids))
    assert all(r.window_open_min < r.window_close_min for r in inp.requests)


def test_full_scenario_shape_and_demographics():
    data = generate("full", 42)
    assert len(data["engineers"]) == 10
    assert len(data["requests"]) == 80
    vips = [r for r in data["requests"] if r["priority"] == "vip"]
    assert len(vips) == 6
    assert all(r["window_strict"] for r in vips)
    cctv = [r for r in data["requests"] if r["required_skills"] == ["video"] and r["service_min"] >= 96]
    assert len(cctv) == 3  # scarcity: one van + video + thermal engineer only
    vans = [e for e in data["engineers"] if e["vehicle_class"] == "van"]
    assert len(vans) == 3
    assert sum(1 for e in data["engineers"] if "thermal_camera" in e["equipment"]) == 2


def test_every_skill_is_covered_by_some_engineer():
    for scenario in ("mini", "full"):
        data = generate(scenario, 42)
        engineer_skills = {s for e in data["engineers"] for s in e["skills"]}
        for req in data["requests"]:
            assert set(req["required_skills"]) <= engineer_skills


def test_durations_within_20pct_of_work_type_base():
    data = generate("full", 42)
    for req in data["requests"]:
        # match by (skills, equipment, vehicle classes) signature; several
        # work types may share one signature (e.g. audit_node vs b2b), so
        # accept any plausible base
        candidates = [
            wt
            for wt in WORK_TYPES.values()
            if set(wt.required_skills) == set(req["required_skills"])
            and wt.required_equipment == req["required_equipment"]
            and set(wt.allowed_vehicle_classes) == set(req["allowed_vehicle_classes"])
        ]
        assert candidates, req["id"]
        assert any(c.base_duration_min * 0.79 <= req["service_min"] <= c.base_duration_min * 1.21 for c in candidates)


def test_windows_inside_working_day():
    data = generate("full", 42)
    for req in data["requests"]:
        open_h, close_h = req["window"]
        assert "09:00" <= open_h and close_h <= "18:00"
