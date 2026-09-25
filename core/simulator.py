"""What-if plans on a copied snapshot. Never publishes and never touches Runtime memory."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from typing import Literal

from pydantic import Field, model_validator

from core.contracts import (
    EngineerRoute,
    GeoPoint,
    Plan,
    Policy,
    Record,
    RouteLeg,
    RouterTaskSnapshot,
)
from core.engine import SearchSettings, apply_system_policy, official_roster, solve
from core.geo import content_hash
from core.runtime import calculate_policy_catalog, construction_travel, parse_snapshot
from core.schedule import assemble_plan, fixed_order, validate_plan

SEARCH_BUDGET_MS = 8000


class WindowShift(Record):
    """One request window, absolute Unix seconds, on the copied snapshot only."""

    request_id: str = Field(min_length=1)
    window_start_at: int = Field(ge=0)
    window_end_at: int = Field(ge=0)

    @model_validator(mode="after")
    def check_order(self) -> WindowShift:
        """Reject a reversed window before any route is built."""
        if self.window_end_at < self.window_start_at:
            raise ValueError("request window is reversed")
        return self


class EngineerPin(Record):
    """Force one request onto one engineer by insertion, not by a new snapshot field."""

    request_id: str = Field(min_length=1)
    engineer_id: str = Field(min_length=1)


class SimulationPatch(Record):
    """Validated what-if. A free snapshot from a model is not accepted."""

    catalog: bool = False
    policy_id: Literal["fast", "compact", "sla", "balanced", "eco", "covering"] | None = None
    lunches_enabled: bool | None = None
    metro_enabled: bool | None = None
    traffic_enabled: bool | None = None
    equipment_enabled: bool | None = None
    equipment_transfers_enabled: bool | None = None
    window: WindowShift | None = None
    pin: EngineerPin | None = None
    unassign_request_id: str | None = None

    @model_validator(mode="after")
    def check_shape(self) -> SimulationPatch:
        """One local edit, one policy/settings bundle, or the shared catalog. Not a mix."""
        local = sum(
            value is not None
            for value in (self.window, self.pin, self.unassign_request_id)
        )
        settings = self.policy_id is not None or any(
            value is not None
            for value in (
                self.lunches_enabled,
                self.metro_enabled,
                self.traffic_enabled,
                self.equipment_enabled,
                self.equipment_transfers_enabled,
            )
        )
        if self.catalog and (local or settings):
            raise ValueError("PATCH_MIXED")
        if local and settings:
            raise ValueError("PATCH_MIXED")
        if local > 1:
            raise ValueError("PATCH_MIXED")
        if not self.catalog and not local and not settings:
            raise ValueError("PATCH_EMPTY")
        return self


def patch_hash(patch: SimulationPatch) -> str:
    """Stable key fragment. None fields and the default catalog flag are omitted."""
    payload = patch.model_dump(mode="json", exclude_none=True)
    if payload.get("catalog") is False:
        del payload["catalog"]
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def _settings_of(settings: SearchSettings, patch: SimulationPatch) -> SearchSettings:
    """Copy technical knobs that the patch actually sets. The live settings object stays put."""
    updates = {
        name: getattr(patch, name)
        for name in (
            "lunches_enabled",
            "metro_enabled",
            "traffic_enabled",
            "equipment_enabled",
            "equipment_transfers_enabled",
        )
        if getattr(patch, name) is not None
    }
    updated = replace(settings, **updates) if updates else settings
    return replace(updated, time_limit_ms=min(updated.time_limit_ms, SEARCH_BUDGET_MS))


def _snapshot_of(snapshot: RouterTaskSnapshot, patch: SimulationPatch) -> RouterTaskSnapshot:
    """Apply policy and one window onto a copy. Pins stay in the route order, not the task."""
    requests = list(snapshot.requests)
    if patch.window is not None:
        found = False
        shifted = []
        for request in requests:
            if request.request_id == patch.window.request_id:
                found = True
                shifted.append(
                    request.model_copy(
                        update={
                            "window_start_at": patch.window.window_start_at,
                            "window_end_at": patch.window.window_end_at,
                        }
                    )
                )
            else:
                shifted.append(request)
        if not found:
            raise ValueError("UNKNOWN_REQUEST")
        requests = shifted
    policy = snapshot.policy
    if patch.policy_id is not None:
        policy = Policy(policy_id=patch.policy_id, parameters={})
    return snapshot.model_copy(update={"requests": requests, "policy": policy})


def _orders(plan: Plan, snapshot: RouterTaskSnapshot) -> dict[str, list[str]]:
    """Job ids in stop order. Engineers missing from the plan keep an empty route."""
    orders = {engineer.engineer_id: [] for engineer in snapshot.engineers}
    for route in plan.routes:
        if route.engineer_id not in orders:
            continue
        orders[route.engineer_id] = [
            stop.request_id for stop in route.stops if stop.kind == "job" and stop.request_id
        ]
    return orders


def _rebuild(
    snapshot: RouterTaskSnapshot, orders: dict[str, list[str]], travel
) -> Plan | None:
    """Replay fixed orders. A single infeasible engineer drops the whole candidate."""
    routes: list[EngineerRoute] = []
    for engineer in snapshot.engineers:
        route = fixed_order(snapshot, engineer, orders.get(engineer.engineer_id, []), travel)
        if route is None:
            return None
        routes.append(route)
    plan = assemble_plan(snapshot, routes)
    try:
        validate_plan(snapshot, plan, travel)
    except (ValueError, AssertionError):
        return None
    return plan


def _insert(
    snapshot: RouterTaskSnapshot,
    orders: dict[str, list[str]],
    request_id: str,
    engineer_id: str,
    travel,
) -> Plan | None:
    """Try every slot on one engineer. The best feasible slot wins; others stay in order."""
    if engineer_id not in orders:
        raise ValueError("UNKNOWN_ENGINEER")
    if request_id not in {request.request_id for request in snapshot.requests}:
        raise ValueError("UNKNOWN_REQUEST")
    cleaned = {key: [job for job in jobs if job != request_id] for key, jobs in orders.items()}
    base = cleaned[engineer_id]
    best: Plan | None = None
    best_key: tuple | None = None
    for index in range(len(base) + 1):
        trial = dict(cleaned)
        trial[engineer_id] = [*base[:index], request_id, *base[index:]]
        plan = _rebuild(snapshot, trial, travel)
        if plan is None:
            continue
        key = (
            plan.summary.unassigned_count,
            plan.summary.late_assigned_count,
            plan.summary.total_lateness_sec,
            plan.summary.distance_km,
        )
        if best_key is None or key < best_key:
            best, best_key = plan, key
    return best


def _metrics(plan: Plan) -> dict:
    """Numbers the store and the guard compare. Routes are separate."""
    summary = plan.summary
    return {
        "assigned_count": summary.requests_total - summary.unassigned_count,
        "unassigned_count": summary.unassigned_count,
        "late_assigned_count": summary.late_assigned_count,
        "total_lateness_sec": summary.total_lateness_sec,
        "distance_km": summary.distance_km,
    }


def _delta(base: Plan, candidate: Plan) -> dict:
    """Signed change against the applied plan. Positive lateness or unassigned is worse."""
    before = {item.request_id: item.engineer_id for item in base.assignments}
    after = {item.request_id: item.engineer_id for item in candidate.assignments}
    transfers = sum(
        1
        for request_id in set(before) | set(after)
        if before.get(request_id) != after.get(request_id)
    )
    left, right = _metrics(base), _metrics(candidate)
    return {
        "assigned": right["assigned_count"] - left["assigned_count"],
        "unassigned": right["unassigned_count"] - left["unassigned_count"],
        "late_assigned": right["late_assigned_count"] - left["late_assigned_count"],
        "total_lateness_sec": right["total_lateness_sec"] - left["total_lateness_sec"],
        "distance_km": round(right["distance_km"] - left["distance_km"], 3),
        "transfers": transfers,
        "before": left,
        "after": right,
    }


def _points(leg: RouteLeg) -> list[dict]:
    """Drawable points already on the leg. Callers color them; this does not re-route."""
    if leg.segments:
        return [
            {
                "travel_source": segment.travel_source,
                "points": [{"lat": point.lat, "lon": point.lon} for point in segment.geometry.points],
            }
            for segment in leg.segments
            if segment.geometry.points
        ]
    if leg.geometry is not None and leg.geometry.points:
        return [
            {
                "travel_source": leg.travel_source,
                "points": [{"lat": point.lat, "lon": point.lon} for point in leg.geometry.points],
            }
        ]
    return []


def _leg_ends(route: EngineerRoute, leg: RouteLeg) -> tuple[GeoPoint | None, GeoPoint | None]:
    """Stop coordinates for a straight fallback when the leg has no polyline."""
    stops = {stop.stop_id: stop for stop in route.stops}
    origin = stops.get(leg.from_stop_id) if leg.from_stop_id else None
    destination = stops.get(leg.to_stop_id)
    return (None if origin is None else origin.location, None if destination is None else destination.location)


def _borrow_index(plan: Plan | None) -> dict[tuple, RouteLeg]:
    """Same engineer and same job pair can reuse a road, metro or API polyline."""
    found: dict[tuple, RouteLeg] = {}
    if plan is None:
        return found
    for route in plan.routes:
        stops = {stop.stop_id: stop for stop in route.stops}
        for leg in route.legs:
            origin = stops.get(leg.from_stop_id) if leg.from_stop_id else None
            destination = stops.get(leg.to_stop_id)
            key = (
                route.engineer_id,
                None if origin is None or origin.request_id is None else origin.request_id,
                None if destination is None or destination.request_id is None else destination.request_id,
            )
            found[key] = leg
    return found


def route_view(plan: Plan, reference: Plan | None = None) -> list[dict]:
    """Geometry for the map. Strategy color is applied by the client, not here."""
    borrowed = _borrow_index(reference)
    routes = []
    for route in plan.routes:
        if not route.legs and not any(stop.kind == "job" for stop in route.stops):
            continue
        stops = {stop.stop_id: stop for stop in route.stops}
        segments = []
        for leg in route.legs:
            origin = stops.get(leg.from_stop_id) if leg.from_stop_id else None
            destination = stops.get(leg.to_stop_id)
            key = (
                route.engineer_id,
                None if origin is None or origin.request_id is None else origin.request_id,
                None if destination is None or destination.request_id is None else destination.request_id,
            )
            drawn = _points(borrowed.get(key, leg))
            if not drawn:
                start, end = _leg_ends(route, leg)
                if start is not None and end is not None:
                    drawn = [
                        {
                            "travel_source": "approximate",
                            "points": [
                                {"lat": start.lat, "lon": start.lon},
                                {"lat": end.lat, "lon": end.lon},
                            ],
                        }
                    ]
            segments.extend(drawn)
        if segments:
            routes.append({"engineer_id": route.engineer_id, "segments": segments})
    return routes


def _local(
    snapshot: RouterTaskSnapshot, base: Plan, patch: SimulationPatch, travel
) -> Plan | None:
    """Reinsert only the touched job. No OR-Tools call."""
    orders = _orders(base, snapshot)
    if patch.window is not None:
        return _rebuild(snapshot, orders, travel)
    if patch.unassign_request_id is not None:
        if patch.unassign_request_id not in {request.request_id for request in snapshot.requests}:
            raise ValueError("UNKNOWN_REQUEST")
        cleared = {
            key: [job for job in jobs if job != patch.unassign_request_id] for key, jobs in orders.items()
        }
        return _rebuild(snapshot, cleared, travel)
    assert patch.pin is not None
    return _insert(snapshot, orders, patch.pin.request_id, patch.pin.engineer_id, travel)


def _bounded(snapshot: RouterTaskSnapshot, settings: SearchSettings, travel, context_version: str) -> Plan:
    """One capped solve on the copy. Straight-line construction; the live worker is not involved."""
    output = solve(
        snapshot,
        travel,
        settings,
        memory=None,
        context_version=context_version,
    )
    return output.main


def simulate_patch(
    raw: bytes,
    settings: SearchSettings,
    context_version: str,
    patch: SimulationPatch,
    base: Plan | None,
    *,
    publication_id: str,
) -> dict:
    """Answer one what-if. `base` is a copy of the applied plan and is not written back."""
    digest = content_hash(raw)
    task = apply_system_policy(official_roster(parse_snapshot(raw)), settings)
    tuned = _settings_of(settings, patch)
    travel = construction_travel(tuned, task.planning_as_of)
    if patch.catalog:
        _comparison, plans = calculate_policy_catalog(
            raw, publication_id, travel, tuned, context_version, SEARCH_BUDGET_MS
        )
        return {
            "input_hash": digest,
            "input_publication_id": publication_id,
            "router_context_version": context_version,
            "patch_hash": patch_hash(patch),
            "method": "catalog",
            "strategies": [
                {
                    "strategy_id": strategy_id,
                    "metrics": _metrics(plan),
                    "routes": route_view(plan, base),
                }
                for strategy_id, plan in plans.items()
            ],
        }
    patched = apply_system_policy(_snapshot_of(task, patch), tuned)
    local = patch.window is not None or patch.pin is not None or patch.unassign_request_id is not None
    method = "insertion"
    candidate: Plan | None = None
    if local and base is not None and base.is_usable:
        candidate = _local(patched, base, patch, travel)
    if candidate is None:
        method = "bounded"
        candidate = _bounded(patched, tuned, travel, context_version)
    if base is None or not base.is_usable:
        empty = candidate.model_copy(deep=True)
        delta = _delta(empty, candidate)
        delta["transfers"] = 0
        for key in ("assigned", "unassigned", "late_assigned", "total_lateness_sec", "distance_km"):
            delta[key] = 0
        delta["before"] = delta["after"]
    else:
        delta = _delta(base, candidate)
    return {
        "input_hash": digest,
        "input_publication_id": publication_id,
        "router_context_version": context_version,
        "patch_hash": patch_hash(patch),
        "method": method,
        "delta": delta,
        "routes": route_view(candidate, base),
    }
