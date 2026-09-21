"""Read-only insertion search for a same-day customer window."""

from time import monotonic

from core.contracts import RouterTaskSnapshot
from core.schedule import fixed_order


def propose_window(
    snapshot: RouterTaskSnapshot, travel, request_id: str, routes: dict, day_end_at: int
) -> dict:
    """Keep assigned job orders and search every insertion using canonical travel/scheduling.

    Returns the earliest witnessed service interval, never a fabricated slot or a
    claim that rearranging the whole day could not yield another solution.
    """
    requests = {request.request_id: request for request in snapshot.requests}
    if request_id not in requests:
        raise ValueError("REQUEST_NOT_IN_PREVIEW")
    jobs = [job for order in routes.values() for job in order]
    if len(jobs) != len(set(jobs)) or set(jobs) - requests.keys():
        raise ValueError("INVALID_PREVIEW_ROUTES")
    if set(routes) - {engineer.engineer_id for engineer in snapshot.engineers}:
        raise ValueError("UNKNOWN_PREVIEW_ENGINEER")
    start = max(snapshot.planning_as_of, snapshot.horizon_start_at)
    end = min(snapshot.horizon_end_at, day_end_at)
    if start >= end:
        return {"status": "none", "proposal": None}
    target = requests[request_id].model_copy(
        update={"window_start_at": start, "window_end_at": end}
    )
    task = snapshot.model_copy(
        update={
            "requests": [
                target if request.request_id == request_id else request
                for request in snapshot.requests
            ]
        }
    )
    candidates = []
    deadline = monotonic() + 8
    for engineer in sorted(task.engineers, key=lambda item: item.engineer_id):
        order = [job for job in routes.get(engineer.engineer_id, []) if job != request_id]
        for index in range(len(order) + 1):
            if monotonic() > deadline:
                raise TimeoutError("WINDOW_SEARCH_TIMEOUT")
            candidate_order = order[:index] + [request_id] + order[index:]
            route = fixed_order(task, engineer, candidate_order, travel)
            if route is None:
                continue
            stop = next(stop for stop in route.stops if stop.request_id == request_id)
            if stop.start_at < start or stop.end_at > end:
                continue
            # Round outward for the minute-resolution dispatcher form, then verify
            # that the rounded window itself has a canonical scheduling witness.
            window_start = max(start, (stop.start_at // 60) * 60)
            window_end = min(end, ((stop.end_at + 59) // 60) * 60)
            narrowed = task.model_copy(
                update={
                    "requests": [
                        request.model_copy(
                            update={"window_start_at": window_start, "window_end_at": window_end}
                        )
                        if request.request_id == request_id
                        else request
                        for request in task.requests
                    ]
                }
            )
            checked = fixed_order(narrowed, engineer, candidate_order, travel)
            if checked is None:
                continue
            visit = next(stop for stop in checked.stops if stop.request_id == request_id)
            if visit.start_at < window_start or visit.end_at > window_end:
                continue
            candidates.append(
                {
                    "engineerId": engineer.engineer_id,
                    "windowStartAt": window_start,
                    "windowEndAt": window_end,
                    "serviceStartAt": visit.start_at,
                    "serviceEndAt": visit.end_at,
                }
            )
    if not candidates:
        return {"status": "none", "proposal": None}
    candidates.sort(key=lambda item: (item["serviceStartAt"], item["engineerId"]))
    return {"status": "available", "proposal": candidates[0]}
