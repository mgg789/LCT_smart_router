"""Data contracts for the solver core (JSON boundary).

Field names follow ``context/14-data-model.md`` §3 (SolverInput / PlanSolution)
and §4 (metrics). Time conventions: JSON carries "HH:MM" strings (local city
time); parsing converts them to integer minutes since midnight, and the model
layer converts further to integer seconds for OR-Tools. No timezone handling
exists anywhere in the core — everything is local to the demo city.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_HHMM_RE = re.compile(r"^(\d{1,2}):(\d{2})$")

DEFAULT_WEIGHTS = {"sla": 100000, "balance": 500, "travel": 1}


def parse_hhmm(value: str) -> int:
    """Parse an "HH:MM" local-time string into integer minutes since midnight.

    Args:
        value: time of day, e.g. "09:00". Hours may be 0-47 (past-midnight
            shifts are not supported; values above 23:59 are rejected).

    Returns:
        Minutes since midnight, 0..1439.

    Raises:
        ValueError: if the string is not a valid HH:MM time.
    """
    match = _HHMM_RE.match(value.strip())
    if not match:
        raise ValueError(f"invalid HH:MM time: {value!r}")
    hours, minutes = int(match.group(1)), int(match.group(2))
    if hours > 23 or minutes > 59:
        raise ValueError(f"time out of range: {value!r}")
    return hours * 60 + minutes


def format_hhmm(minutes: int) -> str:
    """Render minutes since midnight as a zero-padded "HH:MM" string.

    Args:
        minutes: minutes since local-city midnight (may exceed 1439 for
            past-midnight overflow; the day part is truncated modulo 24h).

    Returns:
        Time string, e.g. "11:20".
    """
    minutes = int(minutes) % (24 * 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


@dataclass(frozen=True)
class LatLon:
    """WGS84 point: decimal degrees."""

    lat: float
    lon: float


@dataclass(frozen=True)
class Engineer:
    """Field engineer as consumed by the routing model (context/14 §3).

    Attributes:
        end: return depot; ``None`` means the engineer finishes at ``start``.
        shift_start_min / shift_end_min: local-city minutes since midnight.
    """

    id: str
    start: LatLon
    end: LatLon | None
    shift_start_min: int
    shift_end_min: int
    skills: tuple[str, ...]
    vehicle_class: str
    equipment: tuple[str, ...]

    @property
    def end_point(self) -> LatLon:
        """Coordinates of the end depot (falls back to start when unset)."""
        return self.end if self.end is not None else self.start


@dataclass(frozen=True)
class Request:
    """Work order as consumed by the routing model (context/14 §3).

    A visit is feasible when the service STARTS within the window; the visit
    finish time (``done_by``) may extend past ``window_close_min``.
    ``priority == "vip"`` forces hard-window treatment in the model even when
    ``window_strict`` is false (context/15 §2.2).
    """

    id: str
    lat: float
    lon: float
    window_open_min: int
    window_close_min: int
    window_strict: bool
    service_min: int
    required_skills: tuple[str, ...]
    required_equipment: dict[str, int]
    allowed_vehicle_classes: tuple[str, ...]
    priority: str

    @property
    def hard_window(self) -> bool:
        """True when the upper window bound must not be violated."""
        return self.window_strict or self.priority == "vip"


@dataclass(frozen=True)
class TravelMatrixSpec:
    """``travel_matrix`` block of SolverInput (context/14 §3).

    Only the ``haversine`` backend is live in the core prototype; a declared
    ``src: "osrm"`` falls back to haversine with the hour coefficients applied
    (decision D-7; real OSRM stays a drop-in backend per D-5).
    """

    src: str
    resolution: str
    hour_coeff: dict[int, float] = field(default_factory=dict)


@dataclass(frozen=True)
class FixEntry:
    """Pinned assignment for plan stability (context/07; not applied yet).

    The prototype parses ``fix`` but deliberately ignores it — pinning and
    warm start belong to the replanning iteration.
    """

    engineer: str
    seq_before: int | None = None


@dataclass(frozen=True)
class SolverInput:
    """Full solver input contract (context/14 §3)."""

    date: str
    engineers: tuple[Engineer, ...]
    requests: tuple[Request, ...]
    travel_matrix: TravelMatrixSpec
    weights: dict[str, int] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    fix: dict[str, FixEntry] = field(default_factory=dict)


@dataclass(frozen=True)
class Assignment:
    """One visit in the produced plan (context/14 §3).

    Attributes:
        eta_min: local-city minutes when the engineer arrives (service start).
        done_by_min: ``eta_min + service_min``.
        travel_from_prev_min: travel minutes from the previous stop (or from
            the engineer's start depot for the first visit).
        wait_min: minutes waited before starting service at this stop.
    """

    request: str
    engineer: str
    seq: int
    eta_min: int
    done_by_min: int
    travel_from_prev_min: int
    wait_min: int


@dataclass(frozen=True)
class Unassigned:
    """A request left out of the plan, with a reason code (context/14 §3)."""

    request: str
    why: str


@dataclass(frozen=True)
class Metrics:
    """Plan metrics object (context/14 §4 subset).

    ``travel_min_total`` includes the return leg to each engineer's end depot,
    which assignment rows do not carry. ``workload_min`` counts the whole
    occupied span (travel + wait + service). ``balance_std_min`` is the
    population standard deviation over all engineers, idle ones included.
    ``moves_vs_prev`` compares against the plan being re-planned:
    ``reassigned`` — the engineer changed, ``shifted`` — same engineer but
    the eta moved by at least 5 minutes; zeros when there is no previous plan.
    """

    requests_total: int
    assigned: int
    unassigned: int
    sla_ok_pct: float
    sla_at_risk: int
    late_total_min: int
    travel_min_total: int
    travel_min_mean_per_eng: float
    workload_min: dict[str, int]
    balance_std_min: float
    makespan_min: int
    wait_min_total: int
    moves_vs_prev: dict[str, int] = field(default_factory=lambda: {"reassigned": 0, "shifted": 0})


@dataclass(frozen=True)
class PlanSolution:
    """Solver output contract (context/14 §3) extended with ``reasons``.

    ``reasons`` is the structured explanation block (context/11 §3), keyed by
    request id; the API layer passes it to ``plans.reasons`` JSONB verbatim.
    """

    assignments: tuple[Assignment, ...]
    unassigned: tuple[Unassigned, ...]
    metrics: Metrics
    solve_ms: int
    reasons: dict[str, dict] = field(default_factory=dict)


def _parse_latlon(d: dict) -> LatLon:
    return LatLon(lat=float(d["lat"]), lon=float(d["lon"]))


def _parse_engineer(d: dict) -> Engineer:
    shift = d["shift"]
    if len(shift) != 2:
        raise ValueError(f"engineer {d.get('id')!r}: shift must be [start, end]")
    end = d.get("end")
    return Engineer(
        id=str(d["id"]),
        start=_parse_latlon(d["start"]),
        end=_parse_latlon(end) if end is not None else None,
        shift_start_min=parse_hhmm(shift[0]),
        shift_end_min=parse_hhmm(shift[1]),
        skills=tuple(d.get("skills", ())),
        vehicle_class=str(d.get("vehicle_class", "sedan")),
        equipment=tuple(d.get("equipment", ())),
    )


def _parse_request(d: dict) -> Request:
    window = d["window"]
    if len(window) != 2:
        raise ValueError(f"request {d.get('id')!r}: window must be [start, end]")
    return Request(
        id=str(d["id"]),
        lat=float(d["lat"]),
        lon=float(d["lon"]),
        window_open_min=parse_hhmm(window[0]),
        window_close_min=parse_hhmm(window[1]),
        window_strict=bool(d.get("window_strict", False)),
        service_min=int(d.get("service_min", 60)),
        required_skills=tuple(d.get("required_skills", ())),
        required_equipment={str(k): int(v) for k, v in d.get("required_equipment", {}).items()},
        allowed_vehicle_classes=tuple(d.get("allowed_vehicle_classes", ("any",))),
        priority=str(d.get("priority", "std")),
    )


def solver_input_from_dict(data: dict) -> SolverInput:
    """Build a :class:`SolverInput` from a raw JSON-shaped dict.

    Args:
        data: dict matching the SolverInput contract (context/14 §3).

    Returns:
        Parsed input; requests keep their given order (the model layer sorts
        them by id to guarantee determinism).

    Raises:
        ValueError: on a malformed shift/window/time field.
        KeyError: on a missing required field.
    """
    matrix = data.get("travel_matrix") or {}
    hour_coeff = {int(k): float(v) for k, v in (matrix.get("hour_coeff") or {}).items()}
    fix = {
        str(req): FixEntry(engineer=str(f["engineer"]), seq_before=f.get("seq_before"))
        for req, f in (data.get("fix") or {}).items()
    }
    weights = {k: int(v) for k, v in (data.get("weights") or DEFAULT_WEIGHTS).items()}
    return SolverInput(
        date=str(data["date"]),
        engineers=tuple(_parse_engineer(e) for e in data["engineers"]),
        requests=tuple(_parse_request(r) for r in data["requests"]),
        travel_matrix=TravelMatrixSpec(
            src=str(matrix.get("src", "haversine")),
            resolution=str(matrix.get("resolution", "min")),
            hour_coeff=hour_coeff,
        ),
        weights=weights,
        fix=fix,
    )


def solution_to_dict(solution: PlanSolution) -> dict:
    """Serialize a :class:`PlanSolution` into the JSON contract shape.

    Args:
        solution: solver output.

    Returns:
        Dict ready for ``json.dump``: assignments with "HH:MM" times, metrics,
        per-request structured reasons.
    """
    return {
        "assignments": [
            {
                "request": a.request,
                "engineer": a.engineer,
                "seq": a.seq,
                "eta": format_hhmm(a.eta_min),
                "done_by": format_hhmm(a.done_by_min),
                "travel_from_prev": a.travel_from_prev_min,
                "wait": a.wait_min,
            }
            for a in solution.assignments
        ],
        "unassigned": [{"request": u.request, "why": u.why} for u in solution.unassigned],
        "metrics": {
            "requests_total": solution.metrics.requests_total,
            "assigned": solution.metrics.assigned,
            "unassigned": solution.metrics.unassigned,
            "sla_ok_pct": round(solution.metrics.sla_ok_pct, 1),
            "sla_at_risk": solution.metrics.sla_at_risk,
            "late_total_min": solution.metrics.late_total_min,
            "travel_min_total": solution.metrics.travel_min_total,
            "travel_min_mean_per_eng": round(solution.metrics.travel_min_mean_per_eng, 1),
            "workload_min": solution.metrics.workload_min,
            "balance_std_min": round(solution.metrics.balance_std_min, 1),
            "makespan_min": solution.metrics.makespan_min,
            "wait_min_total": solution.metrics.wait_min_total,
            "moves_vs_prev": dict(solution.metrics.moves_vs_prev),
        },
        "solve_ms": solution.solve_ms,
        "reasons": solution.reasons,
    }
