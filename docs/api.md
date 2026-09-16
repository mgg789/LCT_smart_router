# Router Core private API

## Boundary

Router exposes a private service API to System Layer. Authentication and business
authorization remain in sys. Router accepts no endpoint that directly assigns a job,
changes route order or applies a plan.

## Read endpoints

| Method | Path | Response |
|---|---|---|
| `GET` | `/health` | Liveness plus current coordinator status and technical context. |
| `GET` | `/v1/context` | Active `router_context_version`, generation, calculation state, search path and complete technical settings. |
| `GET` | `/v1/result` | The latest atomic `RouterResult` publication. |

`RouterResult.status` is a discriminated state:

- `pending` contains no plans, evidence or diagnostics;
- `ready` contains IDs, exact input hash, timestamps, context version, policy,
  technical settings, search path, ordered policy criteria, main/baseline plans and
  evidence for both plans;
- `error` contains at least one diagnostic and no plans or evidence.

The evidence bundle contains the selected schedule facts and every engineer candidate's
skill, transport, availability, solo feasibility, route-end append feasibility, travel
delta and blockers. It is the supported input for deterministic UI explanations and an
explanation-only LLM. The LLM must not change the plan.

## Technical settings

`PUT /v2/config/technical-settings` replaces the complete Router-owned revision:

```json
{
  "operation_id": "settings-42",
  "expected_context_version": "<sha256>",
  "lunches_enabled": false,
  "departure_lateness_tolerance_sec": 120,
  "task_start_lateness_tolerance_sec": 60
}
```

The operation uses compare-and-swap against the active context and is idempotent during
the process lifetime. When a settings store is configured, the accepted revision is
atomically persisted before activation and restored after restart. Every change creates
a new context version and invalidates an in-flight older result.

The lunch switch is a hard system policy. When false, no optional or required lunch is
scheduled in either main or baseline; the sys-owned input bytes and lunch facts remain
unchanged. The two tolerances only decide whether a changed schedule can use
`REVALIDATE`. They never extend customer windows or engineer shifts.

`PUT /v1/config/tolerance` remains a compatibility alias for the departure tolerance.
Conflicting operation IDs or stale context versions return HTTP `409`; malformed bodies
return `422`.

## Versioning

The service version is `2.0`. The sys exchange payload remains `schema_version="1.0"`
because V2 adds output metadata and Router-owned context without changing the shape of
`RouterTaskSnapshot`. Unknown fields and unknown policy IDs are rejected.

