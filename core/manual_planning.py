"""Durable manual intents as a constrained overlay, never mutations of source facts."""

from dataclasses import replace
from typing import TYPE_CHECKING

from core.schedule import TravelProvider

if TYPE_CHECKING:
    from core.engine import EngineOutput, SearchSettings

from core.contracts import ManualDecision, ManualResolution, Plan, RouterTaskSnapshot


def overlay(snapshot: RouterTaskSnapshot, decisions: list[ManualDecision]) -> RouterTaskSnapshot:
    """Apply a compatible set to a private snapshot; execution release anchors stay intact."""
    requests = {r.request_id: r.model_dump() for r in snapshot.requests}
    engineers = {e.engineer_id: e.model_dump() for e in snapshot.engineers}
    for item in decisions:
        if item.kind in ("assignment", "window"):
            request = requests.get(item.target_id)
            if request is None:  # Already executed/cancelled work is not rewritten.
                continue
            if item.kind == "assignment":
                request["manual_unassigned"] = item.engineer_id is None
                request["manual_engineer_id"] = item.engineer_id
            else:
                if item.start_at is None or item.end_at is None or item.end_at <= item.start_at:
                    raise ValueError("invalid manual window")
                request["window_start_at"], request["window_end_at"] = item.start_at, item.end_at
                request["manual_window"] = True
        else:
            engineer = engineers.get(item.target_id)
            if engineer is None:
                continue
            if item.start_at is None or item.end_at is None or item.end_at <= item.start_at:
                raise ValueError("invalid manual engineer interval")
            if item.kind == "shift":
                engineer["shift_start_at"], engineer["shift_end_at"] = item.start_at, item.end_at
                engineer["manual_shift"] = True
            elif not engineer["lunch_taken"]:
                duration = engineer["lunch"]["duration_sec"] or 1800
                engineer["lunch"].update(
                    {
                        "enabled": True,
                        "required": True,
                        "duration_sec": duration,
                        "window_start_at": item.start_at,
                        "window_end_at": item.end_at,
                    }
                )
                engineer["manual_lunch"] = True
    # Validate after all edits: a shift extension may make a requested lunch possible.
    data = snapshot.model_dump()
    data.update(
        manual_decisions=[], requests=list(requests.values()), engineers=list(engineers.values())
    )
    if engineers:
        data["horizon_start_at"] = min(
            snapshot.horizon_start_at, *(e["shift_start_at"] for e in engineers.values())
        )
        data["horizon_end_at"] = max(
            snapshot.horizon_end_at, *(e["shift_end_at"] for e in engineers.values())
        )
    return RouterTaskSnapshot.model_validate(data)


def satisfies(snapshot: RouterTaskSnapshot, plan: Plan) -> bool:
    """Check forced choices against the computed witness, not a search success flag."""
    if not plan.is_usable:
        return False
    assigned = {a.request_id: a.engineer_id for a in plan.assignments if a.status == "assigned"}
    for request in snapshot.requests:
        if (
            request.manual_engineer_id is not None
            and assigned.get(request.request_id) != request.manual_engineer_id
        ):
            return False
        if request.manual_unassigned and request.request_id in assigned:
            return False
    for engineer in snapshot.engineers:
        if engineer.manual_lunch and not engineer.lunch_taken:
            route = next((r for r in plan.routes if r.engineer_id == engineer.engineer_id), None)
            if route is None or route.lunch.status != "scheduled":
                return False
    return True


def solve_manual(
    snapshot: RouterTaskSnapshot,
    travel: TravelProvider,
    settings: "SearchSettings",
    context_version: str | None = None,
) -> "EngineOutput":
    """Bounded lexicographic constraint search; rejected means no witness found, not proof.

    Full sets are attempted first. For small conflicts exhaustive subset order preserves
    top priorities even when a lower shift extension enables a higher lunch request.
    Larger sets use bounded compatible insertion. All dropped choices remain in metadata.
    """
    from core.engine import EngineMemory, EngineOutput, solve

    clean = snapshot.model_copy(update={"manual_decisions": []}, deep=True)
    original = solve(clean, travel, settings, None, context_version)
    ordered = sorted(snapshot.manual_decisions, key=lambda d: (d.priority, d.id))
    cache = {}
    trials = 0
    trial_settings = replace(settings, time_limit_ms=min(settings.time_limit_ms, 300))

    def trial(items):
        nonlocal trials
        key = tuple(d.id for d in items)
        if key in cache:
            return cache[key]
        if trials >= 96:
            return None
        trials += 1
        try:
            task = overlay(clean, items)
            result = solve(task, travel, trial_settings, None, context_version)
            found = (task, result) if satisfies(task, result.main) else None
        except ValueError:
            found = None
        cache[key] = found
        return found

    accepted = list(ordered)
    selected = trial(accepted)
    if selected is None:
        if len(ordered) <= 6:
            # Descending bit masks enumerate inclusion vectors lexicographically.
            for mask in range((1 << len(ordered)) - 2, -1, -1):
                subset = [
                    d for index, d in enumerate(ordered) if mask & (1 << (len(ordered) - index - 1))
                ]
                candidate = trial(subset)
                if candidate is not None:
                    accepted, selected = subset, candidate
                    break
        else:
            accepted = []
            for decision in ordered:
                candidate = trial([*accepted, decision])
                if candidate is not None:
                    accepted.append(decision)
                    selected = candidate
    if selected is None:
        accepted, selected = [], (clean, original)
    task, output = selected
    accepted_ids = [d.id for d in accepted]
    rejected = [d for d in ordered if d.id not in accepted_ids]
    conflicts = {d.id for d in rejected}
    # Reduce each failed combination to a small witness; a exhausted budget retains
    # conservative participants instead of silently clearing a conflict card.
    for decision in rejected:
        participants = [*accepted, decision]
        for other in accepted:
            reduced = [d for d in participants if d.id != other.id]
            if trials < 96 and trial(reduced) is None:
                participants = reduced
        conflicts.update(d.id for d in participants)
    resolution = ManualResolution(
        accepted_ids=accepted_ids,
        rejected_ids=[d.id for d in rejected],
        conflict_ids=sorted(conflicts),
    )
    main = output.main.model_copy(update={"manual_resolution": resolution})
    return EngineOutput(
        main,
        original.baseline,
        "MANUAL_CONSTRAINTS",
        EngineMemory(task, main, output.memory.context_version),
    )
