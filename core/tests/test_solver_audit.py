"""Independent score and small-instance checks for the DRO-102 routing audit."""

import json
from itertools import permutations
from random import Random
from types import SimpleNamespace

import pytest
from core.contracts import EquipmentStock, GeoPoint, LunchInput, Policy, RouterTaskSnapshot
from core.engine import SearchSettings, apply_system_policy, solve
from core.geo import GraphTravel, TravelQuote, configure_travel
from core.policy import policy_score
from core.route_search import RouteEvaluator
from core.schedule import assemble_plan, fixed_order, validate_plan


def terminal_only_case(snapshot, graph):
    """One engineer can only serve a final recovery visit after ordinary release ends."""
    now = snapshot.planning_as_of
    base = snapshot.engineers[0]
    late = base.model_copy(
        update={
            "engineer_id": "a-late",
            "input_order": 0,
            "shift_end_at": now + 600,
            "available_from": now + 601,
        }
    )
    regular = base.model_copy(
        update={
            "engineer_id": "z-regular",
            "input_order": 1,
            "shift_end_at": now + 3600,
        }
    )
    request = snapshot.requests[0].model_copy(
        update={
            "request_id": "job",
            "location": base.start_location,
            "service_duration_sec": 300,
            "window_end_at": now + 3600,
        }
    )
    task = snapshot.model_copy(
        update={
            "engineers": [late, regular],
            "requests": [request],
            "policy": Policy(policy_id="balanced", parameters={}),
        }
    )
    travel = configure_travel(
        GraphTravel(graph), SearchSettings(traffic_enabled=False).technical(), now
    )
    routes = [fixed_order(task, late, ["job"], travel), fixed_order(task, regular, [], travel)]
    assert all(route is not None for route in routes)
    plan = assemble_plan(task, routes)
    validate_plan(task, plan, travel)
    return task, travel, plan


def test_terminal_recovery_work_counts_in_workload_metrics(snapshot, graph):
    """A completed recovery visit is real work even if ordinary release is unavailable."""
    _, _, plan = terminal_only_case(snapshot, graph)
    assert plan.summary.work_time_sec == 300
    assert plan.summary.max_workload_sec == 300
    assert plan.summary.workload_spread_sec == 300


def test_balanced_search_score_matches_public_score_for_terminal_release(snapshot, graph):
    """A post-shift engineer must not look idle/cheaper than an available engineer."""
    task, travel, plan = terminal_only_case(snapshot, graph)
    evaluator = RouteEvaluator(task, travel)
    states = [evaluator.from_route(route) for route in plan.routes]
    internal = evaluator.score(states, "balanced")
    public = policy_score(task, plan)
    # Search counts omit the two fixed input totals; all remaining objectives must match.
    normalized = (
        internal[0] + plan.summary.urgent_total,
        internal[1] + len(task.requests),
        *internal[2:],
    )
    assert normalized == public


def test_unavailable_optional_lunch_has_the_same_score_in_seeds_and_new_candidates(snapshot, graph):
    """The same empty route must not gain/lose a penalty depending on its construction path."""
    now = snapshot.planning_as_of
    engineer = snapshot.engineers[0].model_copy(
        update={
            "availability": "offline",
            "available_from": None,
            "expected_online_at": None,
            "lunch": LunchInput(
                enabled=True,
                required=False,
                duration_sec=300,
                window_start_at=now + 1000,
                window_end_at=now + 2000,
            ),
        }
    )
    task = snapshot.model_copy(update={"engineers": [engineer]})
    travel = GraphTravel(graph)
    evaluator = RouteEvaluator(task, travel)
    canonical = fixed_order(task, engineer, [], travel)
    assert canonical is not None
    assert evaluator.evaluate(0, ()) == evaluator.from_route(canonical)


@pytest.mark.parametrize("traffic", [False, True])
@pytest.mark.parametrize("policy", ["fast", "compact", "sla", "balanced", "eco"])
@pytest.mark.parametrize("job_count", [3, 4, 5, 6])
def test_small_exact_oracle_agrees_on_coverage_and_cost(snapshot, policy, traffic, job_count):
    """Enumerate every subset/order independently of the production route scheduler."""
    now = snapshot.planning_as_of
    points = [GeoPoint(lat=55.0, lon=37.0 + i / 100) for i in range(7)]
    matrix = [
        [0, 30, 90, 55, 110, 170, 210],
        [45, 0, 30, 75, 80, 120, 160],
        [95, 35, 0, 40, 60, 90, 130],
        [65, 85, 50, 0, 25, 65, 105],
        [120, 90, 70, 30, 0, 30, 60],
        [180, 130, 100, 70, 35, 0, 30],
        [220, 170, 140, 110, 65, 35, 0],
    ]

    class Roads:
        version = "exact-audit-matrix"

        def quote(self, origin, destination, profile):
            duration = matrix[points.index(origin)][points.index(destination)]
            # Authoritative traffic provenance prevents a second synthetic multiplier.
            return TravelQuote(duration, duration * 10, (origin, destination), "traffic_api")

    engineer = snapshot.engineers[0].model_copy(
        update={
            "start_location": points[0],
            "shift_end_at": now + 500,
        }
    )
    windows = [(0, 140), (60, 250), (100, 360), (200, 460), (280, 570), (360, 700)][:job_count]
    requests = [
        snapshot.requests[0].model_copy(
            update={
                "request_id": f"audit-{i}",
                "arrival_order": job_count - 1 - i,
                "location": points[i + 1],
                "service_duration_sec": 60,
                "window_start_at": now + lower,
                "window_end_at": now + upper,
                "priority": "urgent" if i == 2 else "normal",
            }
        )
        for i, (lower, upper) in enumerate(windows)
    ]
    task = snapshot.model_copy(
        update={
            "requests": requests,
            "engineers": [engineer],
            "policy": Policy(policy_id=policy, parameters={}),
            "horizon_end_at": now + 500,
        }
    )
    expected = []
    for count in range(job_count + 1):
        for order in permutations(range(job_count), count):
            clock, previous, total_travel, lateness = 0, 0, 0, 0
            slacks = []
            for position, job in enumerate(order):
                drive = matrix[previous][job + 1]
                clock = max(clock + drive, windows[job][0]) + 60
                terminal_grace = 1200 if position == count - 1 else 0
                if clock > windows[job][1] + terminal_grace or clock > 500 + terminal_grace:
                    break
                total_travel += drive
                slacks.append(windows[job][1] - clock)
                lateness += max(0, clock - windows[job][1])
                previous = job + 1
            else:
                prefix = (int(2 not in order), job_count - count, 0, lateness)
                distance, used = total_travel * 10, int(bool(order))
                if policy == "fast":
                    tail = (total_travel, distance, used)
                elif policy == "compact":
                    tail = (used, distance, total_travel)
                elif policy == "eco":
                    tail = (distance, used, total_travel)
                elif policy == "sla":
                    tail = (-min(slacks) if slacks else 0, total_travel, distance, used)
                else:
                    tail = (
                        (clock * 10000 + 499) // 500 if order else 0,
                        0,
                        total_travel,
                        distance,
                        used,
                    )
                expected.append(prefix + tail)
    result = solve(
        task,
        Roads(),
        SearchSettings(
            time_limit_ms=300,
            traffic_enabled=traffic,
            access_buffer_sec=0,
            window_lateness_tolerance_sec=0,
        ),
    )
    assert policy_score(task, result.main) == min(expected)


def test_static_quote_cache_keeps_direction_profile_and_graph_version(graph):
    """Caching must not confuse opposite roads, other transport or an updated resource."""
    travel = GraphTravel(graph)
    start, end = graph.nodes[0].location, graph.nodes[1].location
    car = travel.quote(start, end, "car")
    walk = travel.quote(start, end, "walk")
    assert car is not None and walk is not None and car.duration_sec != walk.duration_sec
    reverse = travel.quote(end, start, "car")
    assert reverse is not None and reverse.points[0] == end
    changed = graph.model_copy(
        update={
            "edges": [
                edge.model_copy(
                    update={"duration_sec": {k: v * 2 for k, v in edge.duration_sec.items()}}
                )
                for edge in graph.edges
            ]
        }
    )
    updated = GraphTravel(changed).quote(start, end, "car")
    assert updated is not None and updated.duration_sec == car.duration_sec * 2
    assert travel.quote(start, end, "car") == car


@pytest.mark.parametrize(
    "extra_args,expected_limit", [([], 10000), (["--solution-limit", "1234"], 1234)]
)
def test_policy_benchmark_exposes_the_search_settings_it_actually_uses(
    snapshot, graph, tmp_path, monkeypatch, extra_args, expected_limit
):
    """A benchmark must not hide a 64-solution cap while the live solver uses 10000."""
    from core import policy_benchmark

    seen = []
    scenario = SimpleNamespace(snapshot=snapshot, graph=graph)
    monkeypatch.setattr(policy_benchmark, "load_official_region", lambda *_: scenario)
    monkeypatch.setattr(policy_benchmark, "combine_official_scenarios", lambda *_: scenario)

    def compare(_raw, _name, _graph, settings, *_args, **_kwargs):
        seen.append(settings)
        return SimpleNamespace(rows=[], model_dump=lambda: {"rows": []})

    monkeypatch.setattr(policy_benchmark, "calculate_policy_comparison", compare)
    output = tmp_path / "benchmark.json"
    monkeypatch.setattr("sys.argv", ["policy_benchmark", "--output", str(output), *extra_args])
    policy_benchmark.main()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["search_settings"]["solution_limit"] == expected_limit
    assert all(settings.solution_limit == expected_limit for settings in seen)


def test_fast_evaluator_matches_canonical_under_seeded_constraints(snapshot, graph):
    """Exercise 2000 combinations of windows, shifts, lunch, stock, transport and availability."""
    source = snapshot
    roads = GraphTravel(graph)
    rng = Random(20260921)
    now = source.planning_as_of
    feasible = 0
    checked = 0
    for case in range(2000):
        enabled = rng.choice([False, True])
        lunch = LunchInput(
            enabled=enabled,
            duration_sec=300 if enabled else None,
            window_start_at=now + 600 if enabled else None,
            window_end_at=now + 3000 if enabled else None,
            required=enabled and rng.choice([False, True]),
        )
        shift = rng.choice([1200, 2400, 3600, 6000])
        engineer = source.engineers[0].model_copy(
            update={
                "shift_end_at": now + shift,
                "available_from": rng.choice([None, now, now + 600, now + shift + 100]),
                "transport_type": rng.choice(["car", "walk", "bike", "transit"]),
                "availability": rng.choice(["online", "offline"]),
                "expected_online_at": rng.choice([None, now + 300, now + 1800]),
                "lunch": lunch,
                "lunch_taken": False,
                "equipment_stock": EquipmentStock(
                    router=rng.randrange(3), set_top_box=0, smart_speaker=0
                ),
            }
        )
        requests = []
        for i in range(6):
            start = rng.randrange(0, 2400)
            requests.append(
                source.requests[0].model_copy(
                    update={
                        "request_id": f"r{i}",
                        "arrival_order": i,
                        "location": rng.choice(graph.nodes).location,
                        "window_start_at": now + start,
                        "window_end_at": now + start + rng.randrange(60, 2400),
                        "service_duration_sec": rng.choice([60, 300, 900]),
                        "priority": rng.choice(["normal", "urgent"]),
                        "required_transport": rng.choice([None, None, "car"]),
                        "required_equipment": rng.choice([None, None, "router"]),
                    }
                )
            )
        task = source.model_copy(update={"engineers": [engineer], "requests": requests})
        task = RouterTaskSnapshot.model_validate(task.model_dump())
        settings = SearchSettings(
            lunches_enabled=enabled,
            traffic_enabled=rng.choice([False, True]),
            window_lateness_tolerance_sec=rng.choice([0, 600, 1200]),
        )
        task = apply_system_policy(task, settings)
        travel = configure_travel(roads, settings.technical(), now)
        jobs = tuple(rng.sample([r.request_id for r in requests], rng.randrange(7)))
        evaluator = RouteEvaluator(task, travel)
        fast = evaluator.evaluate(0, jobs)
        canonical = fixed_order(task, task.engineers[0], list(jobs), travel)
        checked += 1
        assert (fast is None) == (canonical is None), f"feasibility mismatch in case {case}: {jobs}"
        if fast is not None:
            assert fast == evaluator.from_route(canonical), f"score mismatch in case {case}: {jobs}"
        feasible += fast is not None
    assert checked == 2000
    assert feasible > 100
