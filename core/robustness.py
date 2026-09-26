"""Monte-Carlo situation predictions for one fixed applied plan; no routing decisions.

The simulator replays every engineer's fixed visit order under sampled execution
noise (day regime, leg and service dispersion, cancellations) around the same
point quotes the plan was built on, and reports dry probabilities.  It never
re-optimizes or mutates anything: with zero dispersion and zero cancellations
the outcomes reproduce the deterministic schedule exactly.  A request window
constrains completion like ``RouteEvaluator`` (finish by window end, terminal
allowances included), and a visit counts as breached only when it overruns the
window beyond the same tolerance the plan itself accepts — so "late" here means
the same thing as in the published plan.
"""

from __future__ import annotations

import hashlib
import json
import math
import random

from core.contracts import GeoPoint, RouterTaskSnapshot
from core.predict_calibration import PredictCalibration, factory_calibration
from core.route_search import RouteEvaluator
from core.schedule import TERMINAL_WINDOW_LATENESS_TOLERANCE_SEC

_QUOTE_BUCKET_SEC = 600


def _leg_cv(distance_m: float, calibration: PredictCalibration) -> float:
    """Short city legs are noisy; long legs average out (ml-lab calibration)."""
    km = distance_m / 1000
    if km >= 25:
        return calibration.leg_cv_long
    share = min(1.0, km / 25)
    return round(calibration.leg_cv_short + (calibration.leg_cv_long - calibration.leg_cv_short) * math.sqrt(share), 4)


def _master_seed(*parts: object) -> str:
    return hashlib.sha256(
        "|".join(str(p) for p in parts).encode("utf-8")
    ).hexdigest()


def _point(point: GeoPoint) -> tuple[float, float]:
    return (round(point.lat, 6), round(point.lon, 6))


def _validate_routes(evaluator: RouteEvaluator, routes: dict[str, list[str]]) -> None:
    """Mirror manual-evaluation refusals: unknown, duplicate or foreign orders fail."""
    engineers = {e.engineer_id for e in evaluator.engineers}
    if set(routes) - engineers:
        raise ValueError("UNKNOWN_MANUAL_ENGINEER")
    jobs = [job for order in routes.values() for job in order]
    if len(jobs) != len(set(jobs)) or set(jobs) - set(evaluator.requests):
        raise ValueError("INVALID_MANUAL_REQUESTS")
    if not jobs:
        raise ValueError("EMPTY_PREDICT_PLAN")


def _validate_completed(evaluator: RouteEvaluator, routes: dict, completed: dict) -> None:
    """Completed visits must be a route prefix: predictions continue, not rewrite."""
    for engineer_id, done in completed.items():
        order = routes.get(engineer_id, [])
        if len(done) > len(order) or order[: len(done)] != list(done):
            raise ValueError("COMPLETED_NOT_A_PREFIX")


def predict_situation(
    snapshot: RouterTaskSnapshot,
    travel,
    routes: dict[str, list[str]],
    simulations: int = 300,
    as_of: int | None = None,
    completed: dict[str, list[str]] | None = None,
    cancel_rate: float | None = None,
    dispersion_scale: float = 1.0,
    calibration: PredictCalibration | None = None,
) -> dict:
    """Return dry per-request and plan-level probabilities for one fixed plan.

    ``as_of`` with ``completed`` continues the day from the execution state, so
    probabilities are conditional on what already happened.  Deterministic for
    identical inputs: the seed derives from the plan, the active calibration and
    the situation, never from wall-clock time.
    """
    calibration = calibration or factory_calibration()
    evaluator = RouteEvaluator(snapshot, travel)
    _validate_routes(evaluator, routes)
    completed = completed or {}
    _validate_completed(evaluator, routes, completed)
    cancels = calibration.cancel_rate if cancel_rate is None else cancel_rate
    regimes = calibration.regimes
    names = [r.name for r in regimes]
    weights = [r.probability for r in regimes]
    multipliers = {r.name: r.travel_multiplier for r in regimes}
    seed = _master_seed(
        snapshot.input_hash if hasattr(snapshot, "input_hash") else "",
        json.dumps(routes, sort_keys=True),
        json.dumps(completed, sort_keys=True),
        simulations,
        as_of,
        cancels,
        round(dispersion_scale, 6),
        calibration.content_version(),
    )
    engineers = {e.engineer_id: e for e in evaluator.engineers}
    indexes = {e.engineer_id: i for i, e in enumerate(evaluator.engineers)}

    quotes: dict[tuple, object] = {}

    def quote(origin: GeoPoint, dest: GeoPoint, profile: str, clock: float):
        key = (_point(origin), _point(dest), profile, int(clock // _QUOTE_BUCKET_SEC))
        if key not in quotes:
            from core.geo import quote_at

            quotes[key] = quote_at(travel, origin, dest, profile, int(clock))
        return quotes[key]

    stats: dict[str, dict] = {}
    for order in routes.values():
        for request_id in order:
            stats[request_id] = {"reached": 0, "late": 0, "late_sum": 0.0, "lates": []}
    overrun = {engineer_id: 0 for engineer_id in routes}
    zero_late_days = 0
    late_per_day: list[int] = []
    max_late_per_day: list[float] = []
    cancelled_total = 0
    visited_per_day = 0

    for sim in range(simulations):
        rng = random.Random(f"{seed}:{sim}")
        regime = rng.choices(names, weights=weights)[0]
        regime_mult = multipliers[regime] if dispersion_scale > 0 else 1.0
        day_late = 0
        day_max_late = 0.0
        day_cancelled = 0
        for engineer_id, order in routes.items():
            engineer = engineers[engineer_id]
            index = indexes[engineer_id]
            done = completed.get(engineer_id, [])
            if done:
                point = evaluator.requests[done[-1]].location
            else:
                point = engineer.start_location
            clock = float(max(evaluator.releases[index], as_of or 0))
            lunch = engineer.lunch
            lunch_pending = lunch.enabled and not engineer.lunch_taken
            for position, request_id in enumerate(order):
                request = evaluator.requests[request_id]
                if request_id in done:
                    continue
                if rng.random() < cancels:
                    day_cancelled += 1
                    continue
                if lunch_pending and clock >= lunch.window_start_at:
                    clock = max(clock, float(lunch.window_start_at)) + lunch.duration_sec
                    lunch_pending = False
                road = quote(point, request.location, engineer.transport_type, clock)
                duration = float(road.duration_sec) * regime_mult
                if dispersion_scale > 0:
                    duration *= rng.lognormvariate(
                        0.0, _leg_cv(road.distance_m, calibration) * dispersion_scale
                    )
                arrive = clock + duration
                start = max(arrive, float(request.window_start_at))
                service = float(request.service_duration_sec)
                if dispersion_scale > 0:
                    service *= rng.lognormvariate(0.0, calibration.service_cv * dispersion_scale)
                finish = start + service
                terminal = position == len(order) - 1
                tolerance = evaluator.tolerance
                if terminal:
                    tolerance = max(tolerance, TERMINAL_WINDOW_LATENESS_TOLERANCE_SEC)
                # Solver-consistent breach: the same overrun the plan itself treats as
                # infeasible. A finish inside the window grace is the plan's accepted
                # slack, not a failed visit.
                visited_per_day += 1
                late_sec = max(0.0, finish - request.window_end_at)
                breach = finish > request.window_end_at + tolerance
                entry = stats[request_id]
                entry["reached"] += 1
                if breach:
                    entry["late"] += 1
                    day_late += 1
                if late_sec > 0:
                    entry["late_sum"] += late_sec
                    entry["lates"].append(late_sec)
                    day_max_late = max(day_max_late, late_sec)
                clock = finish
                point = request.location
            if clock > evaluator.ends[index]:
                overrun[engineer_id] += 1
        if day_late == 0:
            zero_late_days += 1
        late_per_day.append(day_late)
        max_late_per_day.append(day_max_late)
        cancelled_total += day_cancelled

    late_per_day.sort()
    max_late_per_day.sort()
    requests = {}
    for request_id, entry in stats.items():
        reached = entry["reached"]
        lates = sorted(entry["lates"])
        requests[request_id] = {
            "breach_prob": round(entry["late"] / reached, 4) if reached else None,
            "expected_late_sec": round(entry["late_sum"] / simulations),
            "p90_late_sec": round(lates[min(len(lates) - 1, int(0.9 * len(lates)))]) if lates else 0,
            "cancel_rate_sim": round(1 - reached / simulations, 4),
        }
    visits_total = visited_per_day // simulations
    return {
        "calibration_version": f"{calibration.source}:{calibration.content_version()[:12]}",
        "simulations": simulations,
        "assumptions": {
            "source": calibration.source,
            "cancel_rate": cancels,
            "service_cv": calibration.service_cv,
            "leg_cv": {"short": calibration.leg_cv_short, "long": calibration.leg_cv_long},
            "regimes": {r.name: {"prob": r.probability, "mult": r.travel_multiplier} for r in regimes},
            "note": "synthetic-dispersion model; re-calibrated on real execution facts",
        },
        "plan": {
            "robustness": round(zero_late_days / simulations, 4),
            "visits_total": visits_total,
            "expected_late": round(sum(late_per_day) / simulations, 2),
            "expected_late_share": round(
                sum(late_per_day) / visited_per_day, 4
            ) if visited_per_day else 0.0,
            "p95_late_count": late_per_day[min(simulations - 1, int(0.95 * simulations))],
            "p95_max_late_sec": round(max_late_per_day[min(simulations - 1, int(0.95 * simulations))]),
            "expected_cancellations": round(cancelled_total / simulations, 2),
        },
        "requests": requests,
        "engineers": {
            engineer_id: {"overrun_prob": round(count / simulations, 4)}
            for engineer_id, count in overrun.items()
        },
    }
