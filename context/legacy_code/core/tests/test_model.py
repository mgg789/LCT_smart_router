"""Model-level tests: prefilter, hard constraints, unassigned reasons."""

from core.model import prefilter, solve
from core.solve import solve_task
from core.types import solver_input_from_dict

# Two engineers 600 m apart in central Moscow; one holds video skills, the
# other splice — so skill matching pins specific requests to specific cars.
INPUT = {
    "date": "2026-09-14",
    "engineers": [
        {
            "id": "eng_a",
            "start": {"lat": 55.7520, "lon": 37.6150},
            "end": None,
            "shift": ["09:00", "18:00"],
            "skills": ["fiber", "video"],
            "vehicle_class": "van",
            "equipment": ["onr", "router_wifi6", "stb"],
        },
        {
            "id": "eng_b",
            "start": {"lat": 55.7480, "lon": 37.6220},
            "end": None,
            "shift": ["09:00", "18:00"],
            "skills": ["fiber", "network", "splice"],
            "vehicle_class": "sedan",
            "equipment": ["onr", "router_wifi6", "splice_kit"],
        },
    ],
    "requests": [
        {
            "id": "req_01",
            "lat": 55.7500,
            "lon": 37.6170,
            "window": ["10:00", "12:00"],
            "window_strict": False,
            "service_min": 30,
            "required_skills": ["video"],
            "required_equipment": {},
            "allowed_vehicle_classes": ["any"],
            "priority": "std",
        },
        {
            "id": "req_02",
            "lat": 55.7460,
            "lon": 37.6100,
            "window": ["11:00", "14:00"],
            "window_strict": False,
            "service_min": 60,
            "required_skills": ["splice"],
            "required_equipment": {"splice_kit": 1},
            "allowed_vehicle_classes": ["any"],
            "priority": "std",
        },
        {
            "id": "req_03",
            "lat": 55.7540,
            "lon": 37.6200,
            "window": ["10:30", "11:30"],
            "window_strict": True,
            "service_min": 30,
            "required_skills": [],
            "required_equipment": {},
            "allowed_vehicle_classes": ["any"],
            "priority": "vip",
        },
        {
            "id": "req_04",
            "lat": 55.7510,
            "lon": 37.6180,
            "window": ["12:00", "16:00"],
            "window_strict": False,
            "service_min": 30,
            "required_skills": ["teleport"],
            "required_equipment": {},
            "allowed_vehicle_classes": ["any"],
            "priority": "std",
        },
    ],
    "travel_matrix": {"src": "haversine", "resolution": "min", "hour_coeff": {}},
    "weights": {"sla": 100000, "balance": 500, "travel": 1},
    "fix": {},
}


def test_prefilter_candidate_lists():
    candidates = prefilter(solver_input_from_dict(INPUT))
    assert candidates["req_01"].feasible == ("eng_a",)
    assert candidates["req_01"].blocked == {"eng_b": "skill_missing"}
    assert candidates["req_02"].feasible == ("eng_b",)
    assert candidates["req_03"].feasible == ("eng_a", "eng_b")
    assert candidates["req_04"].feasible == ()
    assert set(candidates["req_04"].blocked.values()) == {"skill_missing"}


def test_solve_respects_hard_constraints():
    input_data = solver_input_from_dict(INPUT)
    output = solve(input_data, time_limit_ms=500, solution_limit=50)

    requests = {r.id: r for r in input_data.requests}
    assigned_ids = {a.request for a in output.assignments}
    assert assigned_ids == {"req_01", "req_02", "req_03"}
    assert set(output.unassigned_ids) == {"req_04"}

    for visit in output.assignments:
        request = requests[visit.request]
        if request.hard_window:
            assert request.window_open_min <= visit.eta_min <= request.window_close_min
        else:
            assert request.window_open_min <= visit.eta_min
        assert visit.done_by_min <= 18 * 60  # within shift
        assert visit.wait_min >= 0 and visit.travel_from_prev_min >= 0

    engineer_of = {a.request: a.engineer for a in output.assignments}
    assert engineer_of["req_01"] == "eng_a"
    assert engineer_of["req_02"] == "eng_b"


def test_solve_task_full_pipeline():
    solution = solve_task(solver_input_from_dict(INPUT), time_limit_ms=500, solution_limit=50)
    assert solution.metrics.assigned == 3
    # Unassigned requests are not OK by definition (metrics.py docstring):
    # 3 of 4 assigned and on time → 75%.
    assert solution.metrics.sla_ok_pct == 75.0
    assert set(solution.reasons) == {r.id for r in solver_input_from_dict(INPUT).requests}
    req_01 = solution.reasons["req_01"]["assignment"]
    assert req_01["chosen"] == "eng_a"
    codes = [f["code"] for f in req_01["factors"]]
    assert codes == ["skill_match", "equipment_ok", "sla_margin", "window_tight", "travel_delta", "load_balance"]
    unassigned_block = solution.reasons["req_04"]["unassigned"]
    assert unassigned_block["why"].startswith("no_candidate:")


def test_everybody_blocked_drops_for_free():
    # A request nobody can serve must not distort the objective: it is
    # dropped without consuming the unassigned penalty, so a feasible
    # request (req_05) is still served.
    data = dict(INPUT)
    extra = dict(INPUT["requests"][0])
    extra.update({"id": "req_05", "window": ["09:00", "10:00"], "window_strict": True})
    data["requests"] = INPUT["requests"] + [extra]
    solution = solve_task(solver_input_from_dict(data), time_limit_ms=500, solution_limit=50)
    assert {u.request for u in solution.unassigned} == {"req_04"}
    assert "req_05" in {a.request for a in solution.assignments}
    assert solution.metrics.assigned == 4
