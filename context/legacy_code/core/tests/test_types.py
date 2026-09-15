"""Round-trip and validation tests for the JSON contract layer."""

import pytest

from core.types import (
    Assignment,
    Metrics,
    PlanSolution,
    Unassigned,
    format_hhmm,
    parse_hhmm,
    solution_to_dict,
    solver_input_from_dict,
)


def test_parse_format_hhmm_roundtrip():
    assert parse_hhmm("09:00") == 540
    assert parse_hhmm("0:00") == 0
    assert format_hhmm(540) == "09:00"
    assert format_hhmm(680) == "11:20"
    assert format_hhmm(1445) == "00:05"  # past-midnight overflow truncates


def test_parse_hhmm_rejects_garbage():
    with pytest.raises(ValueError):
        parse_hhmm("9am")
    with pytest.raises(ValueError):
        parse_hhmm("24:00")
    with pytest.raises(ValueError):
        parse_hhmm("10:60")


SAMPLE_INPUT = {
    "date": "2026-09-14",
    "engineers": [
        {
            "id": "eng_01",
            "start": {"lat": 55.75, "lon": 37.61},
            "end": None,
            "shift": ["09:00", "18:00"],
            "skills": ["fiber", "video"],
            "vehicle_class": "van",
            "equipment": ["onr", "splice_kit"],
        }
    ],
    "requests": [
        {
            "id": "req_101",
            "lat": 55.79,
            "lon": 37.54,
            "window": ["10:00", "12:00"],
            "window_strict": True,
            "service_min": 60,
            "required_skills": ["video"],
            "required_equipment": {"thermal_camera": 1},
            "allowed_vehicle_classes": ["any"],
            "priority": "vip",
        }
    ],
    "travel_matrix": {"src": "haversine", "resolution": "min", "hour_coeff": {"9": 1.3}},
    "weights": {"sla": 100000, "balance": 500, "travel": 1},
    "fix": {"req_101": {"engineer": "eng_01", "seq_before": 3}},
}


def test_solver_input_from_dict():
    inp = solver_input_from_dict(SAMPLE_INPUT)
    assert inp.date == "2026-09-14"
    assert inp.engineers[0].shift_start_min == 540
    assert inp.engineers[0].end_point.lat == 55.75  # end None → returns to start
    req = inp.requests[0]
    assert req.window_open_min == 600 and req.window_close_min == 720
    assert req.hard_window is True  # strict and vip
    assert inp.travel_matrix.hour_coeff == {9: 1.3}
    assert inp.fix["req_101"].engineer == "eng_01"


def test_soft_window_priority_std():
    data = dict(SAMPLE_INPUT)
    req = dict(SAMPLE_INPUT["requests"][0], window_strict=False, priority="std")
    data["requests"] = [req]
    assert solver_input_from_dict(data).requests[0].hard_window is False


def test_solution_to_dict_shape():
    solution = PlanSolution(
        assignments=[
            Assignment(
                request="req_101",
                engineer="eng_01",
                seq=1,
                eta_min=680,
                done_by_min=740,
                travel_from_prev_min=8,
                wait_min=0,
            )
        ],
        unassigned=[Unassigned(request="req_77", why="no_candidate: test")],
        metrics=Metrics(
            requests_total=2,
            assigned=1,
            unassigned=1,
            sla_ok_pct=50.0,
            sla_at_risk=0,
            late_total_min=0,
            travel_min_total=16,
            travel_min_mean_per_eng=16.0,
            workload_min={"eng_01": 80},
            balance_std_min=0.0,
            makespan_min=80,
            wait_min_total=0,
        ),
        solve_ms=812,
        reasons={"req_101": {"assignment": {"chosen": "eng_01"}, "sequence": []}},
    )
    raw = solution_to_dict(solution)
    assert raw["assignments"][0]["eta"] == "11:20"
    assert raw["assignments"][0]["done_by"] == "12:20"
    assert raw["unassigned"][0]["request"] == "req_77"
    assert raw["metrics"]["assigned"] == 1
    assert raw["solve_ms"] == 812
    assert raw["reasons"]["req_101"]["assignment"]["chosen"] == "eng_01"
