"""Bounded equipment handoff and office-pickup rescue passes."""

from __future__ import annotations

from collections.abc import Iterator
from typing import TYPE_CHECKING

from core.contracts import (
    EngineerRoute,
    EquipmentHandoff,
    EquipmentLogistics,
    EquipmentStock,
    GeoPoint,
    Plan,
    RouterTaskSnapshot,
)
from core.geo import quote_at
from core.schedule import (
    HandoffStep,
    LogisticsStep,
    ScheduleStep,
    TravelProvider,
    assemble_plan,
    release_at,
    schedule_steps,
    score,
    transport_matches,
    validate_plan,
)

if TYPE_CHECKING:
    from core.engine import SearchSettings

# The rescue is deliberately a fallback, never an unbounded second optimizer.
EQUIPMENT_HANDOFF_EVALUATION_LIMIT = 256


def _route_steps(route: EngineerRoute) -> list[ScheduleStep]:
    """Recover the canonical replay steps from a validated route."""
    steps: list[ScheduleStep] = []
    for stop in route.stops:
        if stop.kind == "job":
            steps.append(stop.request_id)
        elif stop.kind == "handoff" and stop.handoff is not None:
            steps.append(HandoffStep(stop.handoff, stop.location, stop.start_at))
        elif stop.kind in ("delivery", "office_pickup") and stop.logistics is not None:
            steps.append(LogisticsStep(stop.logistics, stop.location, stop.start_at))
        elif stop.kind == "lunch":
            steps.append(None)
    return steps


def _insert_steps(steps: list[ScheduleStep], item: ScheduleStep) -> Iterator[list[ScheduleStep]]:
    """Yield deterministic insertion positions while retaining all existing order."""
    for index in range(len(steps) + 1):
        yield steps[:index] + [item] + steps[index:]


def _rescue_equipment_handoffs(
    snapshot: RouterTaskSnapshot, plan: Plan, travel: TravelProvider, settings: SearchSettings
) -> Plan:
    """Try a small deterministic post-solve exchange only for equipment-blocked work.

    The normal optimizer remains responsible for all ordinary routing.  This pass
    only adds one paired meeting and one formerly unassigned equipment job, then
    reconstructs both complete routes through the same schedule/validator path.
    """
    if not settings.equipment_transfers_enabled or not plan.is_usable:
        return plan
    engineers = {engineer.engineer_id: engineer for engineer in snapshot.engineers}
    requests = {request.request_id: request for request in snapshot.requests}
    current = plan
    evaluations = 0
    for assignment in current.assignments:
        request = requests[assignment.request_id]
        if assignment.status != "unassigned" or request.required_equipment is None:
            continue
        receivers = [
            engineer for engineer in snapshot.engineers
            if engineer.engineer_id in engineers
            and (request.region is None or engineer.region is None or engineer.region == request.region)
            and request.required_skill in engineer.skills
            and transport_matches(request.required_transport, engineer)
            and release_at(snapshot, engineer) is not None
        ]
        routes = {route.engineer_id: route for route in current.routes}
        for receiver in receivers:
            receiver_route = routes[receiver.engineer_id]
            for donor in snapshot.engineers:
                if donor.engineer_id == receiver.engineer_id:
                    continue
                if donor.region != receiver.region or (request.region and donor.region not in (None, request.region)):
                    continue
                donor_route = routes[donor.engineer_id]
                consumed = sum(
                    requests[stop.request_id].required_equipment == request.required_equipment
                    for stop in donor_route.stops
                    if stop.kind == "job" and stop.request_id is not None
                )
                if donor.equipment_stock.quantity(request.required_equipment) <= consumed:
                    continue
                locations = [donor.start_location, receiver.start_location] + [
                    stop.location for route in (donor_route, receiver_route) for stop in route.stops
                    if stop.kind == "job"
                ]
                # Same graph vertices are intentional candidates; de-duplicate
                # coordinates without relying on object identity.
                unique_locations = list(dict.fromkeys((point.lat, point.lon) for point in locations))[:8]
                for lat, lon in unique_locations:
                    location = GeoPoint(lat=lat, lon=lon)
                    for offset in range(0, 32):
                        meeting_at = snapshot.planning_as_of + offset * 300
                        handoff = EquipmentHandoff(
                            handoff_id=f"handoff:{request.request_id}:{donor.engineer_id}:{receiver.engineer_id}",
                            donor_engineer_id=donor.engineer_id,
                            receiver_engineer_id=receiver.engineer_id,
                            request_id=request.request_id,
                            items=EquipmentStock(
                                router=1 if request.required_equipment == "router" else 0,
                                set_top_box=1 if request.required_equipment == "set_top_box" else 0,
                                smart_speaker=1 if request.required_equipment == "smart_speaker" else 0,
                            ),
                        )
                        donor_event = HandoffStep(handoff, location, meeting_at)
                        receiver_event = HandoffStep(handoff, location, meeting_at)
                        for donor_steps in _insert_steps(_route_steps(donor_route), donor_event):
                            if evaluations >= EQUIPMENT_HANDOFF_EVALUATION_LIMIT:
                                return current
                            evaluations += 1
                            donor_candidate = schedule_steps(snapshot, donor, donor_steps, travel)
                            if donor_candidate is None:
                                continue
                            for receiver_with_event in _insert_steps(_route_steps(receiver_route), receiver_event):
                                for receiver_steps in _insert_steps(receiver_with_event, request.request_id):
                                    if evaluations >= EQUIPMENT_HANDOFF_EVALUATION_LIMIT:
                                        return current
                                    evaluations += 1
                                    receiver_candidate = schedule_steps(snapshot, receiver, receiver_steps, travel)
                                    if receiver_candidate is None:
                                        continue
                                    next_routes = [
                                        donor_candidate if route.engineer_id == donor.engineer_id else
                                        receiver_candidate if route.engineer_id == receiver.engineer_id else route
                                        for route in current.routes
                                    ]
                                    candidate = assemble_plan(snapshot, next_routes)
                                    try:
                                        validate_plan(snapshot, candidate, travel)
                                    except ValueError:
                                        continue
                                    if (candidate.summary.assigned_count > current.summary.assigned_count
                                            and score(snapshot, candidate) < score(snapshot, current)):
                                        return candidate
    return current


def _rescue_office_pickups(snapshot: RouterTaskSnapshot, plan: Plan, travel: TravelProvider, settings: SearchSettings) -> Plan:
    """Fill equipment-blocked gaps without moving any existing occupied interval."""
    if not settings.equipment_transfers_enabled or not plan.is_usable or not snapshot.depots:
        return plan
    requests = {item.request_id: item for item in snapshot.requests}
    current = plan
    evaluations = 0
    for assignment in sorted(plan.assignments, key=lambda item: requests[item.request_id].priority_tier):
        request = requests[assignment.request_id]
        if assignment.status != "unassigned" or request.required_equipment is None:
            continue
        # The preceding handoff pass already tried available donors. Stock on an
        # unavailable donor cannot block a feasible office trip by the recipient.
        found = False
        for engineer in snapshot.engineers:
            release = release_at(snapshot, engineer)
            if (request.region is not None and engineer.region is not None and request.region != engineer.region) or request.required_skill not in engineer.skills or not transport_matches(request.required_transport, engineer) or release is None:
                continue
            route = next(item for item in current.routes if item.engineer_id == engineer.engineer_id)
            old = _route_steps(route)
            occupied = [stop for stop in route.stops if stop.kind in ("job", "lunch", "handoff", "delivery", "office_pickup")]
            original = [(stop.kind, stop.request_id, stop.start_at, stop.end_at, stop.logistics, stop.handoff) for stop in occupied]
            for depot in snapshot.depots:
                if depot.region is not None and engineer.region is not None and depot.region != engineer.region:
                    continue
                logistics = EquipmentLogistics(
                    logistics_id=f"office-pickup:{request.request_id}:{engineer.engineer_id}:{depot.depot_id}",
                    kind="office_pickup", request_id=request.request_id,
                    equipment_type=request.required_equipment, receiver_engineer_id=engineer.engineer_id,
                    depot_id=depot.depot_id,
                )
                for index in range(len(old) + 1):
                    evaluations += 1
                    if evaluations > EQUIPMENT_HANDOFF_EVALUATION_LIMIT:
                        return current
                    previous = occupied[index - 1] if index else None
                    departure = previous.end_at if previous else release
                    location = previous.location if previous else engineer.start_location
                    quote = quote_at(travel, location, depot.location, engineer.travel_profile(), departure)
                    if quote is None:
                        continue
                    pickup = LogisticsStep(logistics, depot.location, departure + quote.duration_sec)
                    candidate = schedule_steps(snapshot, engineer, old[:index] + [pickup, request.request_id] + old[index:], travel)
                    if candidate is None:
                        continue
                    observed = [(stop.kind, stop.request_id, stop.start_at, stop.end_at, stop.logistics, stop.handoff)
                                for stop in candidate.stops
                                if stop.kind != "wait" and stop.request_id != request.request_id and stop.logistics != logistics]
                    if observed != original:
                        continue
                    next_plan = assemble_plan(snapshot, [candidate if item.engineer_id == engineer.engineer_id else item for item in current.routes])
                    validate_plan(snapshot, next_plan, travel)
                    current, found = next_plan, True
                    break
                if found:
                    break
            if found:
                break
    return current
