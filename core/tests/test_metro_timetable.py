"""Headway boundaries, closure and shared-model consistency regressions."""

from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from core.metro_timetable import next_departure


def _epoch(clock: str) -> int:
    return int(datetime.fromisoformat(f"2026-09-29T{clock}").replace(tzinfo=ZoneInfo("Europe/Moscow")).timestamp())


@pytest.mark.parametrize(("ready", "train"), [
    ("05:29:59", None), ("05:30:00", "05:30:00"), ("05:30:01", "05:40:00"),
    ("07:29:59", "07:30:00"), ("07:30:01", "07:31:30"),
    ("09:59:59", "10:00:00"), ("10:00:01", "10:03:00"),
    ("16:59:59", "17:00:00"), ("17:00:01", "17:01:30"),
    ("19:59:59", "20:00:00"), ("20:00:01", "20:05:00"),
    ("22:59:59", "23:00:00"), ("23:00:01", "23:10:00"),
    ("00:00:01", "00:10:00"), ("00:50:00", "00:50:00"),
    ("00:50:01", None), ("01:00:00", None), ("03:00:00", None),
])
def test_headway_boundaries(ready, train):
    assert next_departure(_epoch(ready)) == (None if train is None else _epoch(train))


def test_service_and_core_share_identical_interval_model():
    root = Path(__file__).resolve().parents[2]
    assert (root / "core/metro_timetable.py").read_bytes() == (
        root / "services/route-engine3/metro_timetable.py"
    ).read_bytes()


def test_core_waits_at_boarding_and_transfer_but_not_each_station():
    from core.metro import MetroTravel
    from core.tests.test_metro import _network, _WalkingTravel

    travel = MetroTravel(_WalkingTravel(), _network())
    # 12:00 board, 12:02 arrive, 150 s interchange, next train 12:06, arrive12:08.
    path = travel._shortest_at('a', 'd', _epoch('12:00:00'))
    assert path.duration_sec == 480
    assert path.station_ids == ('a', 'b', 'c', 'd')
    assert travel._shortest_at('a', 'd', _epoch('03:00:00')) is None
    assert travel._shortest_at('a', 'd', _epoch('00:50:00')) is None
    # The first train may finish after closure, but the passenger cannot transfer.
    assert travel._shortest_at('a', 'b', _epoch('00:50:00')).duration_sec == 120
    network = _network()
    edges = [e.model_copy(update={'kind': 'ride'}) for e in network.edges]
    uninterrupted = MetroTravel(_WalkingTravel(), network.model_copy(update={'edges': edges}))
    assert uninterrupted._shortest_at('a', 'd', _epoch('12:00:00')).duration_sec == 330


def test_core_timed_quote_does_not_add_static_wait_again():
    from core.metro import MetroTravel
    from core.tests.test_metro import _network, _WalkingTravel

    travel = MetroTravel(_WalkingTravel(), _network())
    a, d = travel.stations['a'].location, travel.stations['d'].location
    quote = travel.quote_at(a, d, 'transit', _epoch('11:57:00'))
    # 180 entrance + (480 wait/rides/transfers) + 120 exit; approaches zero.
    assert quote.duration_sec == 780
    assert sum(s.duration_sec for s in quote.segments) == quote.duration_sec


def test_verified_unreachable_metro_cannot_be_replaced_with_offline_path():
    from core.metro import MetroTravel
    from core.route3 import VerifiedRoute3
    from core.tests.test_metro import _network, _WalkingTravel

    network = _network()
    a, d = network.stations[0].location, network.stations[-1].location
    departure = _epoch('12:00:00')
    corrections = {(a.lat, a.lon, d.lat, d.lon, 'transit', departure): None}
    travel = MetroTravel(VerifiedRoute3(_WalkingTravel(), corrections), network)
    assert travel.quote_at(a, d, 'transit', departure) is None
    assert travel.quote_at(a, d, 'transit', departure + 1) is not None
