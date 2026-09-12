"""Travel-time matrix backend for the solver core.

The prototype ships an offline haversine backend: great-circle kilometers ×
road factor ÷ average city speed, scaled by an hour-of-day traffic coefficient
(decision D-7: historical hourly coefficients). Decision D-5 (self-hosted
OSRM as the real matrix source) is untouched — ``osrm_cache`` is a planned
drop-in backend producing the same integer-minute matrix interface.

Matrix semantics: ``minutes[i][j]`` is the driving time between node i and
node j in whole minutes (ceil). The matrix for a single solve is built for one
reference hour (the earliest shift start across engineers) because a
pre-solve matrix cannot depend on solver decisions; refining to per-arc
departure hours is future work (see docs/solver.md).
"""

from __future__ import annotations

import math

from core.types import LatLon

# Moscow-ish defaults; tuned against "distance is a proxy, model correctness
# does not depend on absolute minutes" (see docs/solver.md — haversine caveat).
BASE_SPEED_KMH = 28.0
ROAD_FACTOR = 1.35

# Peak hours coefficient 1.4, night 0.9 (context/04 §3, decision D-3).
_PEAK_HOURS = {7, 8, 9, 17, 18, 19}
_NIGHT_HOURS = {22, 23, 0, 1, 2, 3, 4, 5, 6}
PEAK_COEFF = 1.4
NIGHT_COEFF = 0.9
DEFAULT_COEFF = 1.0


def builtin_hour_coefficient(hour: int) -> float:
    """Return the default traffic coefficient for a hour of day.

    Args:
        hour: local-city hour, 0-23.

    Returns:
        1.4 for morning/evening peaks, 0.9 for night, 1.0 otherwise.
    """
    if hour in _PEAK_HOURS:
        return PEAK_COEFF
    if hour in _NIGHT_HOURS:
        return NIGHT_COEFF
    return DEFAULT_COEFF


def hour_coefficient(hour: int, coeff_map: dict[int, float] | None = None) -> float:
    """Resolve the traffic coefficient for a hour, honoring a custom map.

    Args:
        hour: local-city hour, 0-23.
        coeff_map: optional explicit hour → coefficient map from SolverInput
            (``travel_matrix.hour_coeff``); missing hours fall back to the
            builtin curve.

    Returns:
        Positive coefficient applied to the raw travel minutes.
    """
    if coeff_map:
        return float(coeff_map.get(hour, builtin_hour_coefficient(hour)))
    return builtin_hour_coefficient(hour)


def haversine_km(a: LatLon, b: LatLon) -> float:
    """Great-circle distance between two WGS84 points.

    Args:
        a, b: points in decimal degrees.

    Returns:
        Distance in kilometers (Earth radius 6371.0088 km).
    """
    lat1, lon1, lat2, lon2 = map(math.radians, (a.lat, a.lon, b.lat, b.lon))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def travel_minutes(dist_km: float, coeff: float) -> int:
    """Convert a distance into traffic-adjusted driving minutes (ceil).

    Args:
        dist_km: great-circle distance in kilometers.
        coeff: hour-of-day traffic coefficient (≥ 0).

    Returns:
        Whole minutes; 0 when the points coincide.
    """
    speed_kmh = BASE_SPEED_KMH / ROAD_FACTOR
    return math.ceil(dist_km / speed_kmh * coeff * 60.0)


def build_travel_minutes(
    points: list[LatLon],
    hour: int,
    coeff_map: dict[int, float] | None = None,
) -> list[list[int]]:
    """Build the full n×n travel-time matrix in minutes for one reference hour.

    Args:
        points: node coordinates (order defines node indices).
        hour: reference local-city hour for the traffic coefficient.
        coeff_map: optional explicit coefficient map (see :func:`hour_coefficient`).

    Returns:
        Symmetric integer matrix; diagonal is zero.
    """
    coeff = hour_coefficient(hour, coeff_map)
    matrix: list[list[int]] = []
    for a in points:
        row: list[int] = []
        for b in points:
            row.append(0 if a is b else travel_minutes(haversine_km(a, b), coeff))
        matrix.append(row)
    return matrix
