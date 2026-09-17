"""Generate offline presentation views from validated Router results; run from repo root.

Uses only checked-in official East resources. Does not call sys or change golden plans.
The saved clock is deliberately fixed to the organizer work date, not the current day.
"""

import hashlib
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from core.contracts import Plan, Policy, RouterTaskSnapshot
from core.engine import SearchSettings, solve
from core.geo import GraphTravel, configure_travel
from core.official import OfficialScenario, load_official_region
from core.schedule import validate_plan

ROOT = Path(__file__).resolve().parents[3]
POLICIES = ["compact", "fast", "sla", "balanced", "eco"]


def _camel(value):
    """Map Router dictionary field names to the existing dispatcher view spelling."""
    if isinstance(value, list):
        return [_camel(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        key.split("_")[0] + "".join(x.title() for x in key.split("_")[1:]): _camel(item)
        for key, item in value.items()
    }


def view(
    snapshot: RouterTaskSnapshot,
    plan: Plan,
    scenario: OfficialScenario,
    revision: int,
    lunches: bool,
    fingerprint: str,
) -> dict[str, object]:
    """Convert a validated fixed-date plan to the frontend view with anonymous contacts."""
    now = snapshot.planning_as_of
    date = datetime.fromtimestamp(now, timezone(timedelta(hours=3))).date().isoformat()
    assignments = [
        {
            "requestId": a.request_id,
            "status": a.status,
            "engineerId": a.engineer_id,
            "reasons": {
                "assignment": {
                    "chosen": a.engineer_id,
                    "factors": [
                        {
                            "code": r.code,
                            "detail": r.text,
                            "basis": r.basis,
                            "facts": r.facts,
                        }
                        for r in a.reasons
                    ],
                    "alternatives": [],
                }
            },
        }
        for a in plan.assignments
    ]
    outcomes = {a.request_id: a.status for a in plan.assignments}
    requests = []
    for request in snapshot.requests:
        details = scenario.request_details.get(request.request_id, {})
        requests.append(
            {
                "id": request.request_id,
                "version": 1,
                "lifecycle": "submitted",
                "assignmentState": outcomes[request.request_id],
                "addressText": str(
                    details.get(
                        "address",
                        details.get("district", "Демо-объект " + request.request_id),
                    )
                ),
                "region": request.region,
                "lat": request.location.lat,
                "lon": request.location.lon,
                "needsGeocoding": False,
                "geocodeQuality": "district_centroid_projection",
                "requiredEquipment": request.required_equipment,
                "workType": request.required_skill,
                "workTypeTitle": {
                    "local": "Локальные работы",
                    "connection": "Подключение",
                    "emergency": "Аварийные работы",
                }[request.required_skill],
                "requiredSkill": request.required_skill,
                "normProfileCode": request.required_skill,
                "normativeTravelDurationSec": 1200,
                "technicalDurationSec": request.service_duration_sec,
                "documentationDurationSec": 0,
                "serviceDurationSec": request.service_duration_sec,
                "actualDurationSec": None,
                "durationVarianceSec": None,
                "windowStartAt": request.window_start_at,
                "windowEndAt": request.window_end_at,
                "priority": request.priority,
                "contactName": None,
                "problemText": None,
                "createdAt": now,
                "submittedAt": now,
                "startedAt": None,
                "expectedCompletionAt": None,
                "continuationAvailableAt": None,
                "overrunDetectedAt": None,
                "completedAt": None,
                "cancelledAt": None,
            }
        )
    engineers = [
        {
            "id": e.engineer_id,
            "version": 1,
            "displayName": f"Бригада {index + 1}",
            "inputOrder": e.input_order,
            "skills": e.skills,
            "transportType": e.transport_type,
            "region": e.region,
            "homeLat": e.start_location.lat,
            "homeLon": e.start_location.lon,
            "hasAccount": False,
            "day": {
                "engineerId": e.engineer_id,
                "workDate": date,
                "version": 1,
                "shiftStartAt": e.shift_start_at,
                "shiftEndAt": e.shift_end_at,
                "availability": e.availability,
                "expectedOnlineAt": e.expected_online_at,
                "equipmentStock": _camel(e.equipment_stock.model_dump()),
                "equipmentIssuedAt": now,
                "lunch": {
                    **_camel(e.lunch.model_dump()),
                    "enabled": lunches,
                    "taken": False,
                    "startedAt": None,
                },
            },
        }
        for index, e in enumerate(snapshot.engineers)
    ]
    routes = [
        dict(
            engineerId=r.engineer_id,
            startLat=r.start_location.lat,
            startLon=r.start_location.lon,
            startAt=r.start_at,
            finishAt=r.finish_at,
            **_camel(r.metrics.model_dump()),
            lunchStatus=r.lunch.status,
            stops=[
                {
                    "sequence": s.sequence,
                    "kind": s.kind,
                    "requestId": s.request_id,
                    "lat": s.location.lat,
                    "lon": s.location.lon,
                    "arrivalAt": s.arrival_at,
                    "startAt": s.start_at,
                    "endAt": s.end_at,
                }
                for s in r.stops
            ],
            legs=_camel([leg.model_dump() for leg in r.legs]),
        )
        for r in plan.routes
    ]
    context = "demo-recording-v1"
    result = {
        "resultId": f"demo-{revision}",
        "inputHash": fingerprint,
        "routerContextVersion": context,
    }
    return {
        "workDate": date,
        "timeZone": "Europe/Moscow",
        "nowAt": now,
        "policyId": snapshot.policy.policy_id,
        "lunchesEnabled": lunches,
        "routerContextVersion": context,
        "policies": [
            {
                "policyId": p,
                "title": p,
                "description": "Записанный результат Router",
                "isDefault": p == "compact",
            }
            for p in POLICIES
        ],
        "engineers": engineers,
        "requests": requests,
        "plan": {
            "mode": "auto",
            "modeVersion": 1,
            "plan": {
                "revision": revision,
                "origin": "auto",
                "planAsOf": now,
                "appliedAt": now,
                "routes": routes,
                "assignments": assignments,
            },
            "appliedResult": result,
            "lastResult": {
                **result,
                "accepted": True,
                "rejectionCode": None,
                "receivedAt": now,
            },
        },
        "alerts": [
            {
                "id": a.alert_id,
                "code": a.code,
                "severity": a.severity,
                "engineerIds": a.engineer_ids,
                "requestIds": a.request_ids,
                "reasons": [r.text for r in a.reasons],
                "restoreOption": None,
                "createdAt": now,
                "seenAt": None,
                "resolvedAt": None,
            }
            for a in plan.alerts
        ],
    }


def main() -> None:
    """Solve all recorded states and write one versioned bundle, validating every main/FIFO plan."""
    scenario = load_official_region(ROOT / "data/dataset/anonymized", "east")
    base = scenario.snapshot.model_copy(
        update={
            "requests": scenario.snapshot.requests[:18],
            "engineers": scenario.snapshot.engineers[:5],
        }
    )
    urgent = scenario.snapshot.requests[18].model_copy(update={"priority": "urgent"})
    cases = [
        ("initial", "Начальный план", base, False),
        (
            "urgent",
            "Добавлена срочная заявка",
            base.model_copy(update={"requests": [*base.requests, urgent]}),
            False,
        ),
        (
            "unavailable",
            "Бригада 1 недоступна",
            base.model_copy(
                update={
                    "engineers": [
                        base.engineers[0].model_copy(
                            update={
                                "availability": "offline",
                                "expected_online_at": None,
                            }
                        ),
                        *base.engineers[1:],
                    ]
                }
            ),
            False,
        ),
        ("lunch", "План с обедами", base, True),
    ]
    recorded = []
    for index, (key, title, task, lunches) in enumerate(cases, 1):
        settings = SearchSettings(
            time_limit_ms=3000, solution_limit=4, lunches_enabled=lunches
        )
        travel = configure_travel(
            GraphTravel(scenario.graph), settings.technical(), task.planning_as_of
        )
        outputs = {}
        for policy in POLICIES:
            current = task.model_copy(
                update={"policy": Policy(policy_id=policy, parameters={})}
            )
            output = solve(current, travel, settings)
            validate_plan(output.memory.snapshot, output.main, travel)
            validate_plan(output.memory.snapshot, output.baseline, travel)
            outputs[policy] = output
        fingerprint = hashlib.sha256(task.model_dump_json().encode()).hexdigest()
        main_output = outputs["compact"]
        rows = [
            {
                "strategyId": p,
                "kind": "policy",
                "isUsable": outputs[p].main.is_usable,
                "calculationMs": 0,
                "metrics": _camel(outputs[p].main.summary.model_dump()),
            }
            for p in POLICIES
        ]
        rows.append(
            {
                "strategyId": "baseline",
                "kind": "baseline",
                "isUsable": main_output.baseline.is_usable,
                "calculationMs": 0,
                "metrics": _camel(main_output.baseline.summary.model_dump()),
            }
        )
        snapshots = {
            p: view(
                task.model_copy(update={"policy": Policy(policy_id=p, parameters={})}),
                outputs[p].main,
                scenario,
                index,
                lunches,
                fingerprint,
            )
            for p in POLICIES
        }
        recorded.append(
            {
                "id": key,
                "title": title,
                "snapshots": snapshots,
                "comparison": {
                    "inputPublicationId": key,
                    "inputHash": fingerprint,
                    "routerContextVersion": "demo-recording-v1",
                    "computedAt": task.planning_as_of,
                    "searchBudgetMs": settings.time_limit_ms,
                    "rows": rows,
                },
            }
        )
        print(
            key,
            main_output.main.summary.assigned_count,
            "/",
            len(task.requests),
            flush=True,
        )
    pack = {
        "schemaVersion": 1,
        "sourceCommit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        "source": "Official East subset; district-centroid projection; Router main and FIFO validated. Fixed work date 2026-08-17. Recorded results, not live calculation. calculationMs is not measured.",
        "scenarios": recorded,
    }
    target = ROOT / "apps/web/src/demo/generated/recorded.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(pack, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
