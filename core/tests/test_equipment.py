"""Equipment is a per-engineer hard capacity with no in-day exchange."""

from core.contracts import Engineer, EquipmentStock
from core.engine import SearchSettings, solve
from core.evidence import build_plan_evidence
from core.geo import GraphTravel


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
