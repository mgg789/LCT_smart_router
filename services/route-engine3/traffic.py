"""Departure-time traffic model for route-engine3 (v2, car profile only).

Vendored copy of services/road-api/traffic.py so this service stays a
self-contained unit: the car graph's durations get the same deterministic
radial forecast the main project uses (LCT_smart_router core/traffic_engine.py,
version «moscow-radial-v1») plus the two demo extensions requested by Mike on
2026-09-22:

* MKAD together with the Third Transport Ring (ТТК) and the Garden Ring
  (Садовое кольцо) crawl in the narrow rush windows 08:00–09:15 and
  17:15–18:45 (×2.6), magistrals ×1.8, streets ×1.2 on top of the band
  factors;
* straight-line connectors use a length-aware speed curve (short links never
  reach free-flow speed) instead of a flat 40 km/h.

Pure stdlib, works on (lat, lon) tuples, all times are Europe/Moscow local.
Factors are transparency data — the UI legend fetches them via /model.
Walk and bike never touch this module: their durations are flat
distance / average speed by contract.
"""

import math
import re
from datetime import datetime
from zoneinfo import ZoneInfo

MSK = ZoneInfo("Europe/Moscow")
MODEL_VERSION = "moscow-radial-v1+demo-magistral-rush-v1"

MOSCOW_CENTER = (55.7558, 37.6173)  # same anchor as core/traffic_engine.py
DIRECTION_EPS_M = 500.0  # radius delta below this counts as "cross"

# --- moscow-radial-v1 bands (verbatim from core/traffic_engine.py) ---------
BANDS = [  # (from_minute, to_minute, period, {direction: factor} | factor)
    (
        7 * 60,
        10 * 60 + 30,
        "morning_peak",
        {"inbound": 1.45, "outbound": 1.15, "cross": 1.25},
    ),
    (
        16 * 60,
        20 * 60 + 30,
        "evening_peak",
        {"inbound": 1.20, "outbound": 1.50, "cross": 1.30},
    ),
    (10 * 60 + 30, 16 * 60, "daytime", 1.18),
    (6 * 60, 7 * 60, "shoulder", 1.10),
    (20 * 60 + 30, 22 * 60, "shoulder", 1.10),
]
NIGHT_FACTOR = 1.0

CENTER_BONUS = [(5_000.0, 0.10), (15_000.0, 0.05)]  # avg radius → additive bonus

# --- demo extension: magistral rush ------------------------------------
# "ring" = МКАД + ТТК + Садовое кольцо; Mike 2026-09-22: в пик кольца фактически
# стоят — коэффициенты подняты по его замечанию («пик слишком слабо оценивается»).
# street тоже замедляется внутри окон, но умеренно.
RUSH_WINDOWS = [(8 * 60, 9 * 60 + 15), (17 * 60 + 15, 18 * 60 + 45)]
RUSH_FACTORS = {"ring": 2.6, "magistral": 1.8, "street": 1.2}

RING_RE = re.compile(
    r"МКАД|MKAD|ТТК|третье\s+транспортное|садовое\s+кольцо", re.IGNORECASE
)
_MAGISTRAL_RE = re.compile(
    r"(шоссе|проспект|набережная|наб\.|магистраль|мост|трасса|тракт"
    r"|\b[МАРЕ]\s?[-—]?\s?\d+)",
    re.IGNORECASE,
)

# --- demo extension: straight-line speed curve -------------------------
STRAIGHT_CURVE = [  # (max_distance_m, assumed_kmh) — first match wins
    (1_500.0, 24.0),
    (5_000.0, 30.0),
    (12_000.0, 36.0),
    (float("inf"), 40.0),
]


def local_minute_of_day(epoch_s):
    """Minute-of-day and ISO string for a Unix epoch in Europe/Moscow."""
    local = datetime.fromtimestamp(epoch_s, MSK)
    return local.hour * 60 + local.minute, local.isoformat(timespec="minutes")


def period_of(minute_of_day):
    """Named band for the UI; mirrors _forecast_period of the main project."""
    for start, end, name, _factors in BANDS:
        if start <= minute_of_day < end:
            return name
    return "night"


def radial_factor(minute_of_day, direction):
    """Base v1 multiplier for one time band and radial direction."""
    for start, end, _name, factors in BANDS:
        if start <= minute_of_day < end:
            return factors[direction] if isinstance(factors, dict) else factors
    return NIGHT_FACTOR


def radius_bonus_m(radius_m):
    """Additive penalty for legs close to the congested core (v1 rule)."""
    for limit, bonus in CENTER_BONUS:
        if radius_m < limit:
            return bonus
    return 0.0


def in_rush(minute_of_day):
    """True inside the narrow MKAD/magistral rush windows."""
    return any(start <= minute_of_day < end for start, end in RUSH_WINDOWS)


def classify_step(name, ref):
    """Road class of one route step: ring (МКАД/ТТК/Садовое), magistral, street."""
    text = f"{ref or ''} {name or ''}"
    if RING_RE.search(text):
        return "ring"
    if _MAGISTRAL_RE.search(text):
        return "magistral"
    return "street"


def step_direction(prev_radius_m, radius_m):
    """Radial direction of one step: inbound (к центру), outbound, or cross."""
    delta = radius_m - prev_radius_m
    if delta > DIRECTION_EPS_M:
        return "outbound"
    if delta < -DIRECTION_EPS_M:
        return "inbound"
    return "cross"


def straight_speed_kmh(distance_m):
    """Length-aware speed for straight connectors (acceleration-limited)."""
    for limit, kmh in STRAIGHT_CURVE:
        if distance_m < limit:
            return kmh
    return STRAIGHT_CURVE[-1][1]


def haversine_m(a, b):
    """Great-circle distance in metres between two (lat, lon) points."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(min(1.0, math.sqrt(h)))


def endpoint_factor(epoch_s, a, b):
    """v1 endpoint-based factor for straight connectors, as the main project applies it."""
    minute, _iso = local_minute_of_day(epoch_s)
    ra, rb = haversine_m(a, MOSCOW_CENTER), haversine_m(b, MOSCOW_CENTER)
    direction = (
        "outbound"
        if rb - ra > DIRECTION_EPS_M
        else "inbound"
        if rb - ra < -DIRECTION_EPS_M
        else "cross"
    )
    factor = radial_factor(minute, direction)
    factor += radius_bonus_m((ra + rb) / 2)
    return round(factor, 2), period_of(minute)


def summarize_route(steps, departure_epoch):
    """Factor an OSRM step list (v2 model) into durations and a class breakdown.

    steps: OSRM route legs flattened, each with duration/distance/name/ref and
    a (lat, lon) midpoint. Returns summary dict for the /route3 car response.
    """
    minute, iso = local_minute_of_day(departure_epoch)
    period = period_of(minute)
    rush = in_rush(minute)

    prev_radius = haversine_m(steps[0]["midpoint"], MOSCOW_CENTER)
    base_total = factored_total = 0.0
    breakdown = {}

    for step in steps:
        radius = haversine_m(step["midpoint"], MOSCOW_CENTER)
        direction = step_direction(prev_radius, radius)
        prev_radius = radius
        cls = classify_step(step.get("name"), step.get("ref"))

        factor = radial_factor(minute, direction)
        factor += radius_bonus_m(radius)
        if rush and cls in RUSH_FACTORS:
            factor *= RUSH_FACTORS[cls]

        base = step["duration"]
        factored = base * factor
        base_total += base
        factored_total += factored

        row = breakdown.setdefault(
            cls, {"distance_m": 0.0, "base_s": 0.0, "factored_s": 0.0, "factors": set()}
        )
        row["distance_m"] += step["distance"]
        row["base_s"] += base
        row["factored_s"] += factored
        row["factors"].add(round(factor, 2))

    for row in breakdown.values():
        row["factors"] = sorted(row["factors"])
        for key in ("distance_m", "base_s", "factored_s"):
            row[key] = round(row[key], 1)

    return {
        "model_version": MODEL_VERSION,
        "departure_iso": iso,
        "period": period,
        "rush_active": rush,
        "base_duration_s": round(base_total, 1),
        "duration_s": round(factored_total, 1),
        "effective_factor": round(factored_total / base_total, 2)
        if base_total
        else 1.0,
        "breakdown": breakdown,
    }
