"""Tests for the offline haversine travel matrix."""

from core.matrix import (
    build_travel_minutes,
    builtin_hour_coefficient,
    haversine_km,
    hour_coefficient,
    travel_minutes,
)
from core.types import LatLon

MOSCOW_CENTER = LatLon(55.7558, 37.6173)
ZELENOGRAD = LatLon(55.9825, 37.1814)  # ~39 km NW of the center


def test_haversine_known_distance():
    dist = haversine_km(MOSCOW_CENTER, ZELENOGRAD)
    assert 35.0 < dist < 45.0
    assert haversine_km(MOSCOW_CENTER, MOSCOW_CENTER) == 0.0


def test_coefficient_curve():
    assert builtin_hour_coefficient(8) == 1.4  # morning peak
    assert builtin_hour_coefficient(18) == 1.4  # evening peak
    assert builtin_hour_coefficient(3) == 0.9  # night
    assert builtin_hour_coefficient(13) == 1.0  # midday


def test_custom_coeff_map_overrides_and_falls_back():
    assert hour_coefficient(9, {9: 1.2}) == 1.2
    assert hour_coefficient(8, {9: 1.2}) == 1.4  # missing hour → builtin
    assert hour_coefficient(8, None) == 1.4


def test_travel_minutes_scales_with_traffic():
    base = travel_minutes(10.0, 1.0)
    assert travel_minutes(10.0, 1.4) == int(-(-base * 1.4 // 1))  # ceil scaling
    assert travel_minutes(0.0, 1.4) == 0


def test_matrix_symmetric_zero_diagonal_positive():
    points = [MOSCOW_CENTER, ZELENOGRAD, LatLon(55.70, 37.60)]
    matrix = build_travel_minutes(points, hour=10)
    n = len(points)
    assert len(matrix) == n and all(len(row) == n for row in matrix)
    for i in range(n):
        for j in range(n):
            assert matrix[i][j] == matrix[j][i]
            assert matrix[i][j] > 0 or i == j
    # peak-hour matrix must be strictly slower than off-peak
    peak = build_travel_minutes(points, hour=18)
    assert all(p >= o for p, o in zip(peak[0], matrix[0]))
    assert peak[0][1] > matrix[0][1]
