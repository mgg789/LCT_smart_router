"""Seeded demo-dataset generator for the solver core (context/14 §5).

Produces SolverInput JSON (context/14 §3) for two scenarios:

- ``mini`` — day-0 fitting set: 5 engineers × 10 requests, designed feasible
  (golden-plan source; every request is assignable);
- ``full`` — fallback demo set per context/14 §5.1: 10 engineers × 80 requests
  with 6-8 Moscow clusters, window peaks 10-12 / 14-17, 6 narrow VIP windows,
  3 wide windows, 2 deliberately far requests, and equipment/qualification
  scarcity (CCTV installs are servicable by a single engineer) so the plan
  legitimately contains unassigned requests for the reasons panel.

All randomness flows through one ``random.Random(seed)``: the same seed yields
byte-identical datasets, which the golden determinism test relies on.
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass

from core.cli import resolve_output_path
from core.matrix import builtin_hour_coefficient

# Real-ish Moscow district anchors (lat, lon).
CLUSTERS: dict[str, tuple[float, float]] = {
    "center": (55.7558, 37.6173),
    "north": (55.8780, 37.5460),
    "east": (55.7900, 37.8600),
    "southeast": (55.7000, 37.8300),
    "south": (55.6200, 37.6000),
    "southwest": (55.6500, 37.4800),
    "west": (55.7400, 37.3800),
    "northwest": (55.8000, 37.4900),
}
OFFICE = CLUSTERS["center"]
FAR_CORNERS = [(55.9200, 37.9500), (55.5500, 37.4500)]

DAY_START_MIN = 9 * 60
DAY_END_MIN = 18 * 60


@dataclass(frozen=True)
class WorkType:
    """Work catalog entry (context/14 §2 ``work_types`` + §5.1 list)."""

    id: str
    name: str
    base_duration_min: int
    required_skills: tuple[str, ...]
    required_equipment: dict[str, int]
    allowed_vehicle_classes: tuple[str, ...]


WORK_TYPES: dict[str, WorkType] = {
    wt.id: wt
    for wt in (
        WorkType("install_inet", "Подключение интернета", 60, ("fiber",), {"onr": 1, "router_wifi6": 1}, ("any",)),
        WorkType("replace_router", "Замена роутера", 30, ("fiber",), {"router_wifi6": 1}, ("any",)),
        WorkType("repair_line", "Ремонт линии", 90, ("network", "splice"), {"splice_kit": 1}, ("any",)),
        WorkType("install_video", "Монтаж видеонаблюдения", 120, ("video",), {"thermal_camera": 1}, ("van", "van_ladder")),
        WorkType("setup_tv", "Настройка ТВ", 30, ("video",), {"stb": 1}, ("any",)),
        WorkType("audit_node", "Аудит узла", 45, ("network",), {}, ("any",)),
        WorkType("b2b_maintenance", "ТО B2B", 60, ("network",), {}, ("any",)),
        WorkType("consultation", "Консультация", 20, (), {}, ("any",)),
    )
}

# Full-scenario composition (context/14 §5.1: 80 requests). Three CCTV
# installs against a single qualifying engineer (van + video + thermal_camera)
# create the deliberate equipment scarcity.
FULL_COMPOSITION: tuple[tuple[str, int], ...] = (
    ("install_inet", 12),
    ("replace_router", 10),
    ("repair_line", 6),
    ("install_video", 3),
    ("setup_tv", 10),
    ("audit_node", 10),
    ("b2b_maintenance", 10),
    ("consultation", 19),
)

# Hand-authored engineer rosters; skill/vehicle/equipment counts follow
# context/14 §5.1 (fiber≈5, video=3, network≈7, splice=2, 3 vans, thermal×2).
_FULL_ENGINEERS: tuple[tuple[str, str, str, tuple[str, ...], tuple[str, ...]], ...] = (
    # (id, base, vehicle_class, skills, equipment)
    ("eng_01", "office", "van", ("fiber", "network", "splice"), ("onr", "router_wifi6", "splice_kit")),
    ("eng_02", "office", "sedan", ("fiber", "network"), ("onr", "router_wifi6")),
    ("eng_03", "office", "van", ("fiber", "video"), ("onr", "stb", "thermal_camera")),
    ("eng_04", "west", "sedan", ("fiber", "network"), ("onr", "router_wifi6")),
    ("eng_05", "southwest", "sedan", ("fiber", "video"), ("stb", "thermal_camera")),
    ("eng_06", "office", "van", ("network", "splice"), ("splice_kit",)),
    ("eng_07", "north", "sedan", ("network",), ()),
    ("eng_08", "east", "sedan", ("network", "video"), ("stb",)),
    ("eng_09", "office", "sedan", ("fiber", "network"), ("onr", "router_wifi6")),
    ("eng_10", "southeast", "sedan", ("network",), ()),
)

_MINI_ENGINEERS: tuple[tuple[str, str, str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("eng_01", "office", "van", ("fiber", "network", "splice"), ("onr", "router_wifi6", "splice_kit")),
    ("eng_02", "office", "sedan", ("fiber", "video"), ("onr", "stb", "thermal_camera")),
    ("eng_03", "west", "sedan", ("network", "splice"), ("splice_kit",)),
    ("eng_04", "north", "sedan", ("fiber", "network"), ("onr", "router_wifi6")),
    ("eng_05", "east", "van", ("network", "video"), ("stb", "thermal_camera")),
)

# Mini-scenario requests: (work_type, cluster, window_open, window_close,
# priority). Windows are wide enough for every request to be assignable —
# the golden plan must cover all 10.
_MINI_REQUESTS: tuple[tuple[str, str, str, str, str], ...] = (
    ("install_inet", "center", "09:00", "12:00", "std"),
    ("replace_router", "north", "10:00", "12:30", "std"),
    ("install_inet", "east", "13:00", "16:00", "std"),
    ("repair_line", "center", "10:00", "14:00", "std"),
    ("install_video", "south", "11:00", "15:00", "vip"),
    ("setup_tv", "north", "09:00", "11:30", "std"),
    ("audit_node", "east", "13:30", "17:00", "std"),
    ("b2b_maintenance", "center", "14:00", "17:30", "std"),
    ("consultation", "west", "09:30", "17:00", "std"),
    ("install_inet", "south", "10:30", "11:30", "vip"),
)


def _jitter(rng: random.Random, base: tuple[float, float], spread: float) -> tuple[float, float]:
    """Offset a coordinate by a seeded uniform jitter (degrees)."""
    return (round(base[0] + rng.uniform(-spread, spread), 5), round(base[1] + rng.uniform(-spread, spread), 5))


def _engineers(rng: random.Random, roster) -> list[dict]:
    out: list[dict] = []
    for eng_id, base, vehicle_class, skills, equipment in roster:
        if base == "office":
            lat, lon = _jitter(rng, OFFICE, 0.003)
        else:
            lat, lon = _jitter(rng, CLUSTERS[base], 0.005)
        out.append(
            {
                "id": eng_id,
                "start": {"lat": lat, "lon": lon},
                "end": None,
                "shift": ["09:00", "18:00"],
                "skills": list(skills),
                "vehicle_class": vehicle_class,
                "equipment": list(equipment),
            }
        )
    return out


def _sample_std_window(rng: random.Random) -> tuple[int, int]:
    """Sample a std window biased toward the 10-12 / 14-17 demand peaks."""
    start_hours = [9, 10, 10, 11, 11, 12, 13, 14, 14, 15, 15, 16]
    start = rng.choice(start_hours) * 60 + rng.choice((0, 15, 30, 45))
    width = rng.randint(150, 210)
    close = min(start + width, DAY_END_MIN - 15)
    return start, close


def _make_request(rng: random.Random, req_id: str, wt: WorkType, lat: float, lon: float) -> dict:
    open_min, close_min = _sample_std_window(rng)
    return {
        "id": req_id,
        "lat": lat,
        "lon": lon,
        "window": [f"{open_min // 60:02d}:{open_min % 60:02d}", f"{close_min // 60:02d}:{close_min % 60:02d}"],
        "window_strict": False,
        "service_min": round(wt.base_duration_min * rng.uniform(0.8, 1.2)),
        "required_skills": list(wt.required_skills),
        "required_equipment": dict(wt.required_equipment),
        "allowed_vehicle_classes": list(wt.allowed_vehicle_classes),
        "priority": "std",
    }


def generate(scenario: str, seed: int, date: str = "2026-09-14") -> dict:
    """Generate a SolverInput dict for a named scenario.

    Args:
        scenario: ``"mini"`` (5×10, feasible) or ``"full"`` (10×80, context/14 §5.1).
        seed: PRNG seed; the same seed reproduces the dataset byte-for-byte.
        date: plan date (any ISO date string; the core is timezone-free).

    Returns:
        Dict in the SolverInput contract shape (context/14 §3).

    Raises:
        ValueError: on an unknown scenario name.
    """
    rng = random.Random(seed)
    if scenario == "mini":
        roster, requests = _MINI_ENGINEERS, _mini_requests(rng)
    elif scenario == "full":
        roster, requests = _FULL_ENGINEERS, _full_requests(rng)
    else:
        raise ValueError(f"unknown scenario: {scenario!r}")
    return {
        "date": date,
        "engineers": _engineers(rng, roster),
        "requests": requests,
        "travel_matrix": {
            "src": "haversine",
            "resolution": "min",
            "hour_coeff": {h: builtin_hour_coefficient(h) for h in range(24)},
        },
        "weights": {"sla": 100000, "balance": 500, "travel": 1},
        "fix": {},
    }


def _mini_requests(rng: random.Random) -> list[dict]:
    out: list[dict] = []
    for i, (wt_id, cluster, open_s, close_s, priority) in enumerate(_MINI_REQUESTS, start=1):
        wt = WORK_TYPES[wt_id]
        lat, lon = _jitter(rng, CLUSTERS[cluster], 0.02)
        req = _make_request(rng, f"req_{i:03d}", wt, lat, lon)
        req["window"] = [open_s, close_s]
        req["window_strict"] = priority == "vip"
        req["priority"] = priority
        out.append(req)
    return out


def _full_requests(rng: random.Random) -> list[dict]:
    out: list[dict] = []
    cluster_names = list(CLUSTERS)
    req_no = 1
    for wt_id, count in FULL_COMPOSITION:
        wt = WORK_TYPES[wt_id]
        for _ in range(count):
            # 70% of requests sit inside district clusters (context/14 §5.1).
            base = CLUSTERS[rng.choice(cluster_names)] if rng.random() < 0.7 else CLUSTERS["center"]
            lat, lon = _jitter(rng, base, 0.02)
            out.append(_make_request(rng, f"req_{req_no:03d}", wt, lat, lon))
            req_no += 1

    # Two deliberately far/hard requests (context/14 §5.1).
    customized: set[str] = set()
    for corner in FAR_CORNERS:
        victim = rng.choice([r for r in out if r["id"] not in customized])
        victim["lat"], victim["lon"] = corner
        victim["window"] = ["10:00", "14:00"]
        customized.add(victim["id"])

    # Three wide windows, then six narrow VIP windows on short work.
    wide = rng.sample([r for r in out if r["id"] not in customized], 3)
    for req in wide:
        req["window"] = ["09:00", "18:00"]
        customized.add(req["id"])
    vip_pool = [
        r
        for r in out
        if r["id"] not in customized and len(r["required_skills"]) <= 1 and r["service_min"] <= 70
    ]
    vip = rng.sample(vip_pool, 6)
    for req in vip:
        req["priority"] = "vip"
        req["window_strict"] = True
        start = rng.choice((600, 630, 660, 840, 870, 900))  # demand peaks only
        req["window"] = [f"{start // 60:02d}:{start % 60:02d}", f"{(start + 60) // 60:02d}:{(start + 60) % 60:02d}"]
    return out


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint: write a generated dataset to a JSON file."""
    parser = argparse.ArgumentParser(description="Generate a seeded demo dataset (SolverInput JSON).")
    parser.add_argument("--scenario", choices=("mini", "full"), default="mini")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--date", default="2026-09-14")
    parser.add_argument("--out", required=True, help="output JSON path")
    args = parser.parse_args(argv)
    data = generate(args.scenario, args.seed, args.date)
    out_path = resolve_output_path(args.out)
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print(f"{args.scenario}: {len(data['engineers'])} engineers, {len(data['requests'])} requests -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
