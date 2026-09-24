"""Small predicates shared by canonical scheduling and bounded route search."""

from collections.abc import Iterable

from core.contracts import RouterTaskSnapshot


def respects_pinned_order(
    snapshot: RouterTaskSnapshot, engineer_id: str, jobs: Iterable[str]
) -> bool:
    """Check relative order while permitting intermediate routes with only some pinned jobs."""
    order = next((row for row in snapshot.pinned_orders if row.engineer_id == engineer_id), None)
    if order is None:
        return True
    ranks = {request_id: index for index, request_id in enumerate(order.request_ids)}
    observed = [ranks[job] for job in jobs if job in ranks]
    return observed == sorted(observed)


def pinned_ranks(snapshot: RouterTaskSnapshot) -> dict[str, int]:
    """Seed ordered pins first; insertion may still place unrelated work anywhere feasible."""
    return {
        request_id: index
        for order in snapshot.pinned_orders
        for index, request_id in enumerate(order.request_ids)
    }
