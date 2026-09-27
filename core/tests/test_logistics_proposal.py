"""Equipment detours preserve committed work and cannot deliver too late."""

from copy import deepcopy

import pytest
from core.contracts import EquipmentStock
from core.geo import GraphTravel
from core.logistics_proposal import propose_logistics


def _scenario(snapshot):
    request = snapshot.requests[0].model_copy(update={"required_equipment": "router"})
    receiver = snapshot.engineers[0].model_copy(update={"engineer_id": "receiver"})
    donor = receiver.model_copy(update={
        "engineer_id": "donor", "input_order": 1,
        "equipment_stock": EquipmentStock(router=1),
    })
    return snapshot.model_copy(update={"requests": [request], "engineers": [receiver, donor]})


def _stop(task, start, end, *, kind="job", request_id=None):
    return {
        "kind": kind, "request_id": request_id,
        "lat": task.requests[0].location.lat, "lon": task.requests[0].location.lon,
        "start_at": task.planning_as_of + start, "end_at": task.planning_as_of + end,
    }


def _propose(task, graph, routes, **kwargs):
    return propose_logistics(task, GraphTravel(graph), task.requests[0].request_id,
                             "receiver", routes, [], **kwargs)


def test_donor_detour_preserves_published_route(snapshot, graph):
    task = _scenario(snapshot)
    routes = {"receiver": [], "donor": [_stop(task, 1200, 1800)]}
    original = deepcopy(routes)
    result = _propose(task, graph, routes)
    assert result["status"] == "available"
    assert result["proposal"]["kind"] == "donor_delivery"
    assert task.planning_as_of <= result["proposal"]["at"] < task.planning_as_of + 1200
    assert routes == original


@pytest.mark.parametrize("kind", ["job", "lunch", "handoff", "delivery", "office_pickup"])
def test_occupied_intervals_cannot_be_used_as_detour_slack(snapshot, graph, kind):
    task = _scenario(snapshot)
    routes = {"receiver": [], "donor": [_stop(task, 0, 8 * 3600, kind=kind)]}
    assert _propose(task, graph, routes)["status"] == "none"


def test_past_stop_does_not_move_delivery_back_in_time(snapshot, graph):
    task = _scenario(snapshot)
    routes = {"receiver": [], "donor": [_stop(task, -1800, -1200)]}
    result = _propose(task, graph, routes)
    assert result["status"] == "available"
    assert result["proposal"]["at"] >= task.planning_as_of


def test_offline_engineer_cannot_deliver(snapshot, graph):
    task = _scenario(snapshot)
    task = task.model_copy(update={"engineers": [task.engineers[0],
        task.engineers[1].model_copy(update={"availability": "offline"})]})
    assert _propose(task, graph, {"receiver": [], "donor": []})["status"] == "none"


def test_donor_keeps_equipment_reserved_for_own_job(snapshot, graph):
    task = _scenario(snapshot)
    own = task.requests[0].model_copy(update={"request_id": "donor-job", "arrival_order": 99})
    task = task.model_copy(update={"requests": [*task.requests, own]})
    routes = {"receiver": [], "donor": [_stop(task, 1200, 1800, request_id=own.request_id)]}
    assert _propose(task, graph, routes)["status"] == "none"


def test_active_receiver_never_leaves_for_office(snapshot, graph):
    task = _scenario(snapshot)
    task = task.model_copy(update={"engineers": task.engineers[:1]})
    depot = {"id": "office", "lat": 55.75, "lon": 37.60}
    result = propose_logistics(task, GraphTravel(graph), task.requests[0].request_id,
                              "receiver", {"receiver": []}, [depot])
    assert result["status"] == "none"


def test_office_pickup_must_fit_before_target_job(snapshot, graph):
    task = _scenario(snapshot)
    task = task.model_copy(update={"engineers": task.engineers[:1]})
    depot = {"id": "office", "lat": 55.75, "lon": 37.60}
    routes = {"receiver": [_stop(task, 60, 660, request_id=task.requests[0].request_id)]}
    result = propose_logistics(task, GraphTravel(graph), task.requests[0].request_id,
                              "receiver", routes, [depot], allow_office_pickup=True)
    assert result["status"] == "none"


def test_office_pickup_uses_existing_slack(snapshot, graph):
    task = _scenario(snapshot)
    task = task.model_copy(update={"engineers": task.engineers[:1]})
    depot = {"id": "office", "lat": 55.75, "lon": 37.60}
    routes = {"receiver": [_stop(task, 1200, 1800, request_id=task.requests[0].request_id)]}
    result = propose_logistics(task, GraphTravel(graph), task.requests[0].request_id,
                              "receiver", routes, [depot], allow_office_pickup=True)
    assert result["status"] == "available"
    assert result["proposal"]["kind"] == "office_pickup"
    assert result["proposal"]["at"] + 300 <= task.planning_as_of + 1200
