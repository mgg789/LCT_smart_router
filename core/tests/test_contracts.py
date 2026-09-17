"""Input integrity and strict byte-document semantics."""

import pytest
from core.contracts import RouterTaskSnapshot
from core.geo import content_hash
from core.runtime import parse_snapshot


@pytest.mark.parametrize("value", [True, "1786946400", 1786946400.5])
def test_epoch_is_strict_integer(snapshot, value):
    data = snapshot.model_dump()
    data["planning_as_of"] = value
    with pytest.raises(ValueError):
        RouterTaskSnapshot.model_validate(data)


def test_duplicate_order_and_missing_lunch_data(snapshot):
    data = snapshot.model_dump()
    data["requests"][1]["arrival_order"] = data["requests"][0]["arrival_order"]
    with pytest.raises(ValueError, match="duplicate"):
        RouterTaskSnapshot.model_validate(data)
    data = snapshot.model_dump()
    data["engineers"][0]["lunch"]["enabled"] = True
    with pytest.raises(ValueError, match="requires"):
        RouterTaskSnapshot.model_validate(data)


def test_duplicate_json_keys_and_hash_bytes(snapshot):
    raw = snapshot.model_dump_json().encode()
    assert parse_snapshot(raw) == snapshot
    assert content_hash(raw) != content_hash(raw + b"\n")
    with pytest.raises(ValueError, match="duplicate JSON"):
        parse_snapshot(b'{"schema_version":"1.0","schema_version":"2"}')


def test_invalid_policy_rejected(snapshot):
    data = snapshot.model_dump()
    data["policy"]["parameters"] = {"disable_windows": True}
    with pytest.raises(ValueError):
        RouterTaskSnapshot.model_validate(data)


def test_output_interval_invariants(graph):
    from core.contracts import RouteLeg, RouteStop

    with pytest.raises(ValueError, match="stop interval"):
        RouteStop(
            stop_id="s",
            sequence=0,
            kind="job",
            request_id="j",
            location=graph.nodes[0].location,
            arrival_at=10,
            start_at=9,
            end_at=20,
        )
    with pytest.raises(ValueError, match="leg timestamps"):
        RouteLeg(
            leg_id="l",
            from_stop_id=None,
            to_stop_id="s",
            departure_at=10,
            arrival_at=20,
            travel_time_sec=0,
            distance_km=1.0,
            geometry=None,
            travel_source="road_matrix",
        )
