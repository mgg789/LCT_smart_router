"""Equipment is a per-engineer hard capacity with no in-day exchange."""

import pytest
from core.contracts import (
    Depot,
    Engineer,
    EquipmentLogistics,
    EquipmentStock,
    PendingEquipmentHandoff,
    PendingEquipmentLogistics,
)
from core.engine import SearchSettings, solve
from core.evidence import build_plan_evidence
from core.geo import GraphTravel


def test_transport_capacity_defaults_and_rejects_overloaded_inventory(snapshot):
    """Legacy snapshots receive physical carrying limits before any solver work."""
    def engineer(transport, routers):
        payload = snapshot.engineers[0].model_dump()
        payload.update({"transport_type": transport, "equipment_stock": {"router": routers, "set_top_box": 0, "smart_speaker": 0}})
        payload.pop("equipment_capacity")
        return Engineer.model_validate(payload)

    walker, cyclist, driver = engineer("walk", 5), engineer("bike", 12), engineer("car", 30)
    assert (walker.equipment_capacity, cyclist.equipment_capacity, driver.equipment_capacity) == (5, 12, 30)
    with pytest.raises(ValueError, match="carrying capacity"):
        engineer("walk", 6)


def _equipment_snapshot(snapshot, *, second_engineer: bool = False):
    requests = [
        request.model_copy(update={"required_equipment": "router"})
        for request in snapshot.requests[:2]
    ]
    first = snapshot.engineers[0].model_copy(update={"equipment_stock": EquipmentStock(router=1)})
    engineers: list[Engineer] = [first]
    if second_engineer:
        engineers.append(
            first.model_copy(
                update={
                    "engineer_id": "eng-2",
                    "input_order": 1,
                    "equipment_stock": EquipmentStock(),
                }
            )
        )
    return snapshot.model_copy(update={"requests": requests, "engineers": engineers})


def test_stock_exhaustion_is_enforced_in_baseline_and_optimized_plan(snapshot, graph):
    """One carried router can satisfy at most one router request on every path."""
    task = _equipment_snapshot(snapshot)
    output = solve(
        task,
        GraphTravel(graph),
        SearchSettings(time_limit_ms=300, solution_limit=8),
    )

    for plan in (output.baseline, output.main):
        assigned = [
            assignment for assignment in plan.assignments if assignment.status == "assigned"
        ]
        assert len(assigned) == 1
        assert assigned[0].engineer_id == "eng-1"


def test_zero_stock_engineer_cannot_receive_transferred_equipment(snapshot, graph):
    """A second engineer's free time cannot consume the first engineer's carried stock."""
    task = _equipment_snapshot(snapshot, second_engineer=True)
    output = solve(
        task,
        GraphTravel(graph),
        SearchSettings(time_limit_ms=300, solution_limit=8),
    )

    for plan in (output.baseline, output.main):
        owners = {
            assignment.engineer_id
            for assignment in plan.assignments
            if assignment.status == "assigned"
        }
        assert owners == {"eng-1"}
        assert plan.summary.assigned_count == 1


def test_missing_stock_has_structured_reason_and_candidate_blocker(snapshot, graph):
    """A globally absent equipment type remains explicit in plan and LLM evidence."""
    request = snapshot.requests[0].model_copy(update={"required_equipment": "smart_speaker"})
    task = snapshot.model_copy(update={"requests": [request]})
    travel = GraphTravel(graph)
    output = solve(task, travel, SearchSettings(time_limit_ms=100, solution_limit=4))
    assignment = output.main.assignments[0]

    assert assignment.status == "unassigned"
    assert assignment.reasons[0].code == "NO_EQUIPMENT_STOCK"
    assert assignment.reasons[0].facts["equipment_type"] == "smart_speaker"
    assert assignment.reasons[0].facts["required_skill"] == request.required_skill
    evidence = build_plan_evidence(task, output.main, travel).requests[0]
    assert evidence.required_equipment == "smart_speaker"
    assert evidence.candidates[0].equipment_stock == 0
    assert evidence.candidates[0].equipment_match is False
    assert "equipment_missing" in evidence.candidates[0].blockers


def _handoff_snapshot(snapshot, *, donor_region="east", window=7200, receiver_capacity=30):
    """Make a request that only a stockless, otherwise qualified receiver can do."""
    request = snapshot.requests[0].model_copy(
        update={
            "required_skill": "connection",
            "required_equipment": "router",
            "region": "east",
            "window_end_at": snapshot.planning_as_of + window,
        }
    )
    donor = snapshot.engineers[0].model_copy(
        update={"engineer_id": "donor", "skills": ["local"], "region": donor_region,
                "equipment_stock": EquipmentStock(router=1)}
    )
    receiver = donor.model_copy(
        update={"engineer_id": "receiver", "input_order": 1, "skills": ["connection"],
                "region": "east", "equipment_stock": EquipmentStock(),
                "equipment_capacity": receiver_capacity}
    )
    return snapshot.model_copy(update={"requests": [request], "engineers": [donor, receiver]})


def test_enabled_transfer_schedules_paired_meeting_and_moves_stock_after_it(snapshot, graph):
    """A rescue inserts two matching 300-second stops before the receiver's job."""
    task = _handoff_snapshot(snapshot)
    output = solve(task, GraphTravel(graph), SearchSettings(
        time_limit_ms=100, solution_limit=4, equipment_transfers_enabled=True, access_buffer_sec=0,
    ))
    assert output.main.assignments[0].engineer_id == "receiver"
    donor, receiver = output.main.routes
    handoffs = [stop for route in (donor, receiver) for stop in route.stops if stop.kind == "handoff"]
    assert len(handoffs) == 2
    assert handoffs[0].location == handoffs[1].location
    assert handoffs[0].start_at == handoffs[1].start_at
    assert all(stop.end_at - stop.start_at == 300 for stop in handoffs)
    assert next(stop for stop in receiver.stops if stop.kind == "handoff").sequence < next(
        stop for stop in receiver.stops if stop.kind == "job"
    ).sequence


def test_shift_start_at_the_office_loads_there_instead_of_a_handoff(snapshot, graph):
    """Two engineers still in the office do not hand a device to each other."""
    task = _handoff_snapshot(snapshot)
    office = task.engineers[0].start_location
    task = task.model_copy(update={
        "depots": [Depot(depot_id="east-office", region="east", location=office)],
    })
    plan = solve(task, GraphTravel(graph), SearchSettings(
        time_limit_ms=100, solution_limit=4, equipment_transfers_enabled=True, access_buffer_sec=0,
    )).main
    assert plan.assignments[0].status == "assigned"
    assert plan.assignments[0].engineer_id == "receiver"
    stops = [stop for route in plan.routes for stop in route.stops]
    assert not any(stop.kind == "handoff" for stop in stops)
    pickup = next(stop for stop in stops if stop.kind == "office_pickup")
    assert pickup.location == office
    assert pickup.start_at == task.planning_as_of
    donor = next(route for route in plan.routes if route.engineer_id == "donor")
    assert all(stop.kind != "office_pickup" for stop in donor.stops)


def test_transfer_is_disabled_or_rejected_across_regions(snapshot, graph):
    """The optional rescue never weakens the disabled or same-region constraints."""
    travel = GraphTravel(graph)
    disabled = solve(_handoff_snapshot(snapshot), travel, SearchSettings(
        time_limit_ms=100, solution_limit=4, access_buffer_sec=0,
    )).main
    foreign = solve(_handoff_snapshot(snapshot, donor_region="west"), travel, SearchSettings(
        time_limit_ms=100, solution_limit=4, equipment_transfers_enabled=True, access_buffer_sec=0,
    )).main
    assert disabled.assignments[0].status == foreign.assignments[0].status == "unassigned"


def test_transfer_respects_window_and_receiver_capacity(snapshot, graph):
    """A meeting cannot make a late job feasible or overfill the receiver."""
    travel = GraphTravel(graph)
    impossible = _handoff_snapshot(snapshot, window=200)
    impossible = impossible.model_copy(
        update={"requests": [impossible.requests[0].model_copy(update={"service_duration_sec": 3000})]}
    )
    late = solve(impossible, travel, SearchSettings(
        time_limit_ms=100, solution_limit=4, equipment_transfers_enabled=True, access_buffer_sec=0,
    )).main
    full = solve(_handoff_snapshot(snapshot, receiver_capacity=0), travel, SearchSettings(
        time_limit_ms=100, solution_limit=4, equipment_transfers_enabled=True, access_buffer_sec=0,
    )).main
    assert late.assignments[0].status == full.assignments[0].status == "unassigned"


def test_pending_handoff_is_replayed_at_its_frozen_place_and_time(snapshot, graph):
    """Confirmed exchanges survive replanning and credit stock only after the meeting."""
    task = _handoff_snapshot(snapshot)
    meeting = PendingEquipmentHandoff(
        handoff_id="confirmed-1", donor_engineer_id="donor", receiver_engineer_id="receiver",
        request_id="job-1", items=EquipmentStock(router=1),
        location=graph.nodes[0].location, meeting_at=task.planning_as_of,
    )
    task = task.model_copy(update={"pending_equipment_handoffs": [meeting]})
    plan = solve(task, GraphTravel(graph), SearchSettings(time_limit_ms=100, solution_limit=4, access_buffer_sec=0)).main
    assert plan.assignments[0].engineer_id == "receiver"
    frozen = [stop for route in plan.routes for stop in route.stops if stop.kind == "handoff"]
    assert len(frozen) == 2
    assert {stop.handoff.handoff_id for stop in frozen} == {"confirmed-1"}
    assert {stop.start_at for stop in frozen} == {task.planning_as_of}


def test_enabled_office_pickup_assigns_stockless_job_without_moving_existing_job(snapshot, graph):
    """The office action and new job occupy slack while the published job stays fixed."""
    existing = snapshot.requests[0].model_copy(update={"required_equipment": None})
    blocked = snapshot.requests[1].model_copy(update={"required_equipment": "router"})
    engineer = snapshot.engineers[0].model_copy(update={"equipment_stock": EquipmentStock()})
    task = snapshot.model_copy(update={
        "requests": [existing, blocked], "engineers": [engineer],
        "depots": [Depot(depot_id="east-office", region=engineer.region, location=engineer.start_location)],
    })
    plain = solve(task, GraphTravel(graph), SearchSettings(time_limit_ms=100, solution_limit=4, access_buffer_sec=0)).main
    rescued = solve(task, GraphTravel(graph), SearchSettings(time_limit_ms=100, solution_limit=4, access_buffer_sec=0, equipment_transfers_enabled=True)).main
    before = next(stop for stop in plain.routes[0].stops if stop.request_id == existing.request_id)
    after = next(stop for stop in rescued.routes[0].stops if stop.request_id == existing.request_id)
    assert plain.summary.assigned_count == 1
    assert rescued.summary.assigned_count == 2
    assert (before.start_at, before.end_at) == (after.start_at, after.end_at)
    assert any(stop.kind == "office_pickup" for stop in rescued.routes[0].stops)
    pickup = next(stop for stop in rescued.routes[0].stops if stop.kind == "office_pickup")
    pending = task.model_copy(update={"pending_equipment_logistics": [PendingEquipmentLogistics(
        logistics=pickup.logistics, location=pickup.location, at=pickup.start_at,
    )]})
    replayed = solve(pending, GraphTravel(graph), SearchSettings(time_limit_ms=100, solution_limit=4, access_buffer_sec=0,
                                                                equipment_transfers_enabled=True)).main
    replayed_pickups = [stop for route in replayed.routes for stop in route.stops if stop.kind == "office_pickup"]
    assert len(replayed_pickups) == 1
    assert replayed_pickups[0].logistics == pickup.logistics
    assert replayed_pickups[0].start_at == pickup.start_at
    assert replayed.summary.assigned_count == 2


def test_pending_office_pickup_is_not_duplicated_onto_another_engineer(snapshot, graph):
    """A frozen office pickup stays the only reservation when another engineer is tried first."""
    request = snapshot.requests[0].model_copy(update={"required_equipment": "router"})
    holder = snapshot.engineers[0].model_copy(update={"equipment_stock": EquipmentStock(), "input_order": 1})
    other = holder.model_copy(update={"engineer_id": "eng-2", "input_order": 0})
    depot = Depot(depot_id="office", location=holder.start_location)
    logistics = EquipmentLogistics(
        logistics_id=f"office-pickup:{request.request_id}:{holder.engineer_id}:{depot.depot_id}",
        kind="office_pickup",
        request_id=request.request_id,
        equipment_type="router",
        receiver_engineer_id=holder.engineer_id,
        depot_id=depot.depot_id,
    )
    task = snapshot.model_copy(update={
        "requests": [request],
        "engineers": [other, holder],
        "depots": [depot],
        "pending_equipment_logistics": [PendingEquipmentLogistics(
            logistics=logistics, location=depot.location, at=snapshot.planning_as_of,
        )],
    })
    plan = solve(task, GraphTravel(graph), SearchSettings(
        time_limit_ms=200, solution_limit=4, access_buffer_sec=0, equipment_transfers_enabled=True,
    )).main
    pickups = [
        stop for route in plan.routes for stop in route.stops
        if stop.kind == "office_pickup" and stop.logistics is not None and stop.logistics.request_id == request.request_id
    ]
    assert len(pickups) == 1
    assert pickups[0].logistics == logistics
    assignment = next(item for item in plan.assignments if item.request_id == request.request_id)
    assert assignment.engineer_id == holder.engineer_id


def test_office_pickup_does_not_depend_on_unavailable_donor_stock(snapshot, graph):
    """A stocked but unavailable colleague must not prevent a feasible office visit."""
    request = snapshot.requests[0].model_copy(update={"required_equipment": "router"})
    receiver = snapshot.engineers[0]
    donor = receiver.model_copy(update={"engineer_id": "offline-donor", "input_order": 2,
                                         "availability": "offline", "equipment_stock": EquipmentStock(router=2)})
    task = snapshot.model_copy(update={"requests": [request], "engineers": [receiver, donor],
                                      "depots": [Depot(depot_id="office", location=receiver.start_location)]})
    plan = solve(task, GraphTravel(graph), SearchSettings(time_limit_ms=100, solution_limit=4,
                 access_buffer_sec=0, equipment_transfers_enabled=True)).main
    assert plan.assignments[0].engineer_id == receiver.engineer_id
    assert any(stop.kind == "office_pickup" for route in plan.routes for stop in route.stops)
