"""Read-only, order-preserving searches for urgent equipment logistics."""

from time import monotonic

from core.contracts import GeoPoint, RouterTaskSnapshot
from core.geo import quote_at
from core.schedule import release_at

LOGISTICS_DURATION_SEC = 300


def propose_logistics(snapshot: RouterTaskSnapshot, travel, request_id: str, receiver_engineer_id: str,
                      routes: dict[str, list[dict]], depots: list[dict], *, allow_office_pickup: bool = False) -> dict:
    """Find a donor detour first, then an office pickup, without moving published jobs."""
    requests = {item.request_id: item for item in snapshot.requests}
    request = requests.get(request_id)
    engineers = {item.engineer_id: item for item in snapshot.engineers}
    receiver = engineers.get(receiver_engineer_id)
    if request is None or receiver is None or request.required_equipment is None:
        raise ValueError("INVALID_LOGISTICS_REQUEST")
    if receiver_engineer_id not in routes:
        raise ValueError("MISSING_RECEIVER_ROUTE")
    deadline = monotonic() + 5
    candidates: list[dict] = []
    for donor_id, donor in sorted(engineers.items()):
        if monotonic() > deadline:
            raise TimeoutError("LOGISTICS_SEARCH_TIMEOUT")
        if donor_id == receiver_engineer_id or donor.region != receiver.region or release_at(snapshot, donor) is None:
            continue
        used = sum(
            requests[stop["request_id"]].required_equipment == request.required_equipment
            for stop in routes.get(donor_id, [])
            if stop.get("kind") == "job" and stop.get("request_id") in requests
        )
        used += sum(
            item.logistics.equipment_type == request.required_equipment
            and item.logistics.kind == "donor_delivery"
            and item.logistics.donor_engineer_id == donor_id
            for item in snapshot.pending_equipment_logistics
        )
        if donor.equipment_stock.quantity(request.required_equipment) <= used:
            continue
        fit = _first_gap(snapshot, travel, donor, routes.get(donor_id, []), request.location, deadline)
        if fit:
            candidates.append({"kind": "donor_delivery", "donor_engineer_id": donor_id, **fit})
    if candidates:
        return {"status": "available", "proposal": min(candidates, key=lambda item: (item["at"], item["donor_engineer_id"]))}
    if not allow_office_pickup:
        return {"status": "none", "proposal": None}
    for depot in sorted(depots, key=lambda item: str(item.get("id", ""))):
        if monotonic() > deadline:
            raise TimeoutError("LOGISTICS_SEARCH_TIMEOUT")
        if depot.get("lat") is None or depot.get("lon") is None:
            continue
        fit = _first_gap(snapshot, travel, receiver, routes[receiver_engineer_id],
                         GeoPoint(lat=depot["lat"], lon=depot["lon"]), deadline,
                         before_request_id=request_id)
        if fit:
            return {"status": "available", "proposal": {"kind": "office_pickup", "depot_id": depot["id"], **fit}}
    return {"status": "none", "proposal": None}


def _first_gap(snapshot, travel, engineer, stops, target, deadline, before_request_id: str | None = None):
    """Find one five-minute detour that leaves every supplied job interval unchanged."""
    clock = max(snapshot.planning_as_of, snapshot.horizon_start_at, engineer.shift_start_at, release_at(snapshot, engineer) or 0)
    location = engineer.start_location
    # Every published non-travel interval occupies time: lunches and legacy handoffs
    # are just as immovable as jobs.  Past stops establish the present anchor only.
    occupied = sorted((stop for stop in stops if stop.get("kind") not in ("wait", "start") and "start_at" in stop and "end_at" in stop), key=lambda item: int(item["start_at"]))
    future = []
    for stop in occupied:
        if int(stop["end_at"]) <= clock:
            location = GeoPoint(lat=stop["lat"], lon=stop["lon"])
            continue
        future.append(stop)
    for next_stop in [*future, None]:
        if monotonic() > deadline:
            raise TimeoutError("LOGISTICS_SEARCH_TIMEOUT")
        gap_end = int(next_stop["start_at"]) if next_stop else min(engineer.shift_end_at, snapshot.horizon_end_at)
        next_location = GeoPoint(lat=next_stop["lat"], lon=next_stop["lon"]) if next_stop else None
        outbound = quote_at(travel, location, target, engineer.travel_profile(), clock)
        at = clock + outbound.duration_sec if outbound else 0
        inbound = quote_at(travel, target, next_location, engineer.travel_profile(), at + LOGISTICS_DURATION_SEC) if next_location and outbound else None
        if outbound and (next_location is None or inbound):
            if at + LOGISTICS_DURATION_SEC + (inbound.duration_sec if inbound else 0) <= gap_end:
                direct = quote_at(travel, location, next_location, engineer.travel_profile(), clock) if next_location else None
                travel_delta = outbound.duration_sec + (inbound.duration_sec if inbound else 0) - (direct.duration_sec if direct else 0)
                distance_delta = outbound.distance_m + (inbound.distance_m if inbound else 0) - (direct.distance_m if direct else 0)
                return {"at": at, "location": {"lat": target.lat, "lon": target.lon},
                        "travel_delta_sec": travel_delta, "distance_delta_m": distance_delta,
                        "occupied_from_at": clock,
                        "occupied_until_at": at + LOGISTICS_DURATION_SEC + (inbound.duration_sec if inbound else 0),
                        "wait_delta_sec": -(LOGISTICS_DURATION_SEC + travel_delta) if next_location else 0}
        if next_stop and next_stop.get("request_id") == before_request_id:
            # A pickup after the target cannot supply that target's equipment.
            return None
        if next_stop:
            location, clock = next_location, max(clock, int(next_stop["end_at"]))
    return None
