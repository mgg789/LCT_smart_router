"""Local interactive studio for testing the planning core by hand.

Serves a single-page map UI (Leaflet via CDN): click the map to drop a new
work order, pick a work type and time window, and watch the plan rebuild in
place — the solver warm-starts from the current plan (D-4), and the UI shows
the diff (reassigned / shifted), structured reasons and metrics. Requests
can also be cancelled, weights can be switched for what-if, and the day can
be reset to the pristine seed dataset.

This is a dev tool, not the product API (that is ``apps/api``, context/09
§3). Map tiles come from a CDN, so the studio expects internet access; the
offline demo contour is a separate concern (D-5/D-6/D-15).

Run from the repository root::

    python -m core.studio --scenario full --seed 42 --port 8017
"""

from __future__ import annotations

import argparse
import copy
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from core.gen import WORK_TYPES, generate
from core.solve import solve_task
from core.types import (
    PlanSolution,
    format_hhmm,
    solution_to_dict,
    solver_input_from_dict,
)

STUDIO_HTML = Path(__file__).parent / "studio.html"

# Distinct hues for engineer identity (map markers, routes, timeline rows).
ENGINEER_PALETTE = (
    "#2563eb", "#059669", "#db2777", "#d97706", "#7c3aed",
    "#0891b2", "#dc2626", "#65a30d", "#9333ea", "#ea580c",
    "#0d9488", "#be123c",
)


class AddRequestBody(BaseModel):
    """Payload of POST /api/requests (coords from a map click)."""

    lat: float
    lon: float
    work_type: str
    window_start: str
    window_end: str
    window_strict: bool = False
    priority: str = "std"


class WeightsBody(BaseModel):
    """Payload of POST /api/weights (what-if objective, context/14 §3)."""

    sla: int
    balance: int
    travel: int


class Studio:
    """In-memory state machine around the computation core.

    Keeps the working SolverInput as a raw mutable dict (the contract layer
    ignores unknown keys, so UI-only fields like ``work_type`` ride along),
    re-solves on every mutation and remembers the last event for highlighting.
    """

    def __init__(self, scenario: str, seed: int, date: str, time_limit_ms: int = 1000) -> None:
        self.scenario = scenario
        self.seed = seed
        self.date = date
        self.time_limit_ms = time_limit_ms
        self.base_data = generate(scenario, seed, date)
        self.data: dict = copy.deepcopy(self.base_data)
        self.plan: PlanSolution | None = None
        self.version = 0
        self.last_event: dict = {"added": [], "cancelled": []}
        self.replan()

    def replan(self) -> None:
        """Solve the current input, warm-starting from the previous plan."""
        input_data = solver_input_from_dict(self.data)
        previous = self.plan
        self.plan = solve_task(
            input_data, time_limit_ms=self.time_limit_ms, previous_plan=previous
        )
        self.version += 1

    def _next_new_request_id(self) -> str:
        count = sum(1 for r in self.data["requests"] if str(r["id"]).startswith("req_new_"))
        return f"req_new_{count + 1:03d}"

    def add_request(self, body: AddRequestBody) -> str:
        """Append a hand-made request and replan; returns its id.

        Raises:
            ValueError: on an unknown work type or a malformed window.
        """
        wt = WORK_TYPES.get(body.work_type)
        if wt is None:
            raise ValueError(f"unknown work type: {body.work_type!r}")
        request_id = self._next_new_request_id()
        self.data["requests"].append(
            {
                "id": request_id,
                "lat": body.lat,
                "lon": body.lon,
                "window": [body.window_start, body.window_end],
                "window_strict": body.window_strict,
                "service_min": wt.base_duration_min,
                "required_skills": list(wt.required_skills),
                "required_equipment": dict(wt.required_equipment),
                "allowed_vehicle_classes": list(wt.allowed_vehicle_classes),
                "priority": body.priority,
                "work_type": wt.id,
            }
        )
        self.last_event = {"added": [request_id], "cancelled": []}
        self.replan()
        return request_id

    def cancel_request(self, request_id: str) -> None:
        """Remove a request from the day and replan.

        Raises:
            ValueError: when the id does not exist.
        """
        before = len(self.data["requests"])
        self.data["requests"] = [r for r in self.data["requests"] if r["id"] != request_id]
        if len(self.data["requests"]) == before:
            raise ValueError(f"unknown request: {request_id!r}")
        self.last_event = {"added": [], "cancelled": [request_id]}
        self.replan()

    def set_weights(self, body: WeightsBody) -> None:
        """Replace the objective weights (what-if) and replan."""
        self.data["weights"] = {"sla": body.sla, "balance": body.balance, "travel": body.travel}
        self.last_event = {"added": [], "cancelled": []}
        self.replan()

    def reset(self) -> None:
        """Restore the pristine seed dataset and rebuild the plan."""
        self.data = copy.deepcopy(self.base_data)
        self.plan = None
        self.last_event = {"added": [], "cancelled": []}
        self.replan()

    def state(self) -> dict:
        """Full UI payload: plan, diff, reasons, catalog and event marks."""
        plan = self.plan
        if plan is None:  # pragma: no cover - constructor always solves
            raise RuntimeError("studio has no plan")
        assign_by_request = {a.request: a for a in plan.assignments}
        routes: dict[str, list[str]] = {}
        for visit in sorted(plan.assignments, key=lambda a: (a.engineer, a.seq)):
            routes.setdefault(visit.engineer, []).append(visit.request)

        engineers_out = []
        for i, engineer in enumerate(self.data["engineers"]):
            engineers_out.append(
                {
                    "id": engineer["id"],
                    "lat": engineer["start"]["lat"],
                    "lon": engineer["start"]["lon"],
                    "skills": engineer["skills"],
                    "vehicle_class": engineer["vehicle_class"],
                    "color": ENGINEER_PALETTE[i % len(ENGINEER_PALETTE)],
                    "workload_min": plan.metrics.workload_min.get(engineer["id"], 0),
                }
            )

        requests_out = []
        for request in self.data["requests"]:
            visit = assign_by_request.get(request["id"])
            requests_out.append(
                {
                    "id": request["id"],
                    "lat": request["lat"],
                    "lon": request["lon"],
                    "window": request["window"],
                    "window_strict": request.get("window_strict", False),
                    "priority": request.get("priority", "std"),
                    "service_min": request["service_min"],
                    "required_skills": request.get("required_skills", []),
                    "work_type": request.get("work_type"),
                    "status": "assigned" if visit else "unassigned",
                    "engineer": visit.engineer if visit else None,
                    "seq": visit.seq if visit else None,
                    "eta": format_hhmm(visit.eta_min) if visit else None,
                    "done_by": format_hhmm(visit.done_by_min) if visit else None,
                    "wait_min": visit.wait_min if visit else None,
                    "travel_from_prev": visit.travel_from_prev_min if visit else None,
                }
            )

        shifts = [e["shift"] for e in self.data["engineers"]]
        return {
            "version": self.version,
            "date": self.data["date"],
            "scenario": self.scenario,
            "seed": self.seed,
            "shift": [min(s[0] for s in shifts), max(s[1] for s in shifts)],
            "engineers": engineers_out,
            "requests": requests_out,
            "routes": routes,
            "metrics": solution_to_dict(plan)["metrics"],
            "solve_ms": plan.solve_ms,
            "reasons": plan.reasons,
            "last_event": self.last_event,
            "work_types": [
                {
                    "id": wt.id,
                    "name": wt.name,
                    "base_duration_min": wt.base_duration_min,
                    "skills": list(wt.required_skills),
                }
                for wt in WORK_TYPES.values()
            ],
        }


def create_app(studio: Studio) -> FastAPI:
    """Build the FastAPI app around a studio state."""
    app = FastAPI(title="LCT Studio", docs_url=None, redoc_url=None)

    @app.get("/")
    def index() -> FileResponse:
        """Serve the single-page UI."""
        return FileResponse(STUDIO_HTML, media_type="text/html")

    @app.get("/api/state")
    def get_state() -> dict:
        """Current plan state for the UI."""
        return studio.state()

    @app.post("/api/requests")
    def post_request(body: AddRequestBody) -> dict:
        """Add a request and replan; returns the fresh state."""
        try:
            studio.add_request(body)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return studio.state()

    @app.post("/api/requests/{request_id}/cancel")
    def post_cancel(request_id: str) -> dict:
        """Cancel a request and replan; returns the fresh state."""
        try:
            studio.cancel_request(request_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return studio.state()

    @app.post("/api/weights")
    def post_weights(body: WeightsBody) -> dict:
        """Switch objective weights (what-if) and replan."""
        studio.set_weights(body)
        return studio.state()

    @app.post("/api/reset")
    def post_reset() -> dict:
        """Reset the day to the pristine seed dataset."""
        studio.reset()
        return studio.state()

    return app


def main(argv: list[str] | None = None) -> int:
    """CLI: generate the demo city, solve the morning plan, serve the UI."""
    parser = argparse.ArgumentParser(description="LCT Studio — local replanning playground.")
    parser.add_argument("--scenario", choices=("mini", "full"), default="full")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--date", default="2026-09-14")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8017)
    parser.add_argument("--time-limit-ms", type=int, default=1000)
    args = parser.parse_args(argv)

    studio = Studio(args.scenario, args.seed, args.date, time_limit_ms=args.time_limit_ms)
    app = create_app(studio)
    print(f"LCT Studio: http://{args.host}:{args.port}  (scenario={args.scenario}, seed={args.seed})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
