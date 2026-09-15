# Architecture — System Layer

> Living documentation of the backend core. Updated in the same commit as the code it
> describes (AGENTS.md section 8.2). Canon for behaviour: `context/36` (System Layer),
> `context/33` (Router contract), `context/37` (Data Layer), `context/42` (data flows).

## 1. Where the System Layer sits

```text
Client App ─┐
Engineer App ┤
Dashboard   ─┼─► System Layer (apps/api) ─► Data Layer (PostgreSQL)
Integration API ─┘          │
                            ├─ mount-data-eng ─► published RouterTaskSnapshot
                            │                         │ read-only
                            │                         ▼
                            │                   Router Core (apps/solver)
                            ◄── ROUTER-gateway ──┘  result, accepted only in AUTO
```

The System Layer owns business state, authorization, user operations, the applied working
plan and its execution. It prepares the input for Router Core, accepts a current result and
serves the interfaces. It does **not** repeat Router's optimization, edit Router's memory,
or invent execution facts from the passage of time (`context/32` section 9).

## 2. Internal blocks

The eight blocks named in `context/36` section 2 are modules of one Nest application, not a
service each.

| Block | Module | State |
|---|---|---|
| `REST API` | `src/api`, `src/common` | Foundation in place: routing prefix, error envelope, validation pipe, request context |
| `auth-engine` | `src/auth` | Planned — branch `feat/api-auth` |
| `orchestrator backend` | `src/orchestrator` | Planned — branches `feat/api-requests`, `feat/api-engineers` |
| `dataengine` | `src/persistence` | Planned — branch `feat/api-data-layer` |
| `mount-data-eng` | `src/routing/mount-data-eng` | Planned — branch `feat/api-snapshot` |
| `ROUTER-gateway` | `src/routing/router-gateway` | Planned — branch `feat/api-router-gateway` |
| `AI-gateway` | — | Out of scope of this build; declared in `/health/services` as `not_configured` |
| `SMTP-gateway` | — | Out of scope of this build; sys records mail intents, transport is absent |

## 3. Cross-cutting foundation (implemented)

**Configuration** (`src/common/config`). One Zod schema describes every environment key the
process reads; an unparsable environment stops the process at boot rather than surfacing as
an `undefined` at the first request. `AppConfigService` gives typed access.

**Time** (`src/common/time`). Every absolute moment is an integer number of Unix seconds
(`context/33` section 4); local formatting happens only at the edges and never by adding an
offset to a stored value. `Clock` is injected rather than read from `Date.now()` in place —
partly for testability, partly as a standing reminder that the passage of time is not a
trigger for anything (`context/36` section 5.1).

**BigInt boundary** (`src/common/time/bigint-boundary.ts`). PostgreSQL stores those seconds
as `BIGINT`, which the driver returns as a JavaScript `bigint` that `JSON.stringify` cannot
encode. Conversion is explicit at the read boundary and refuses to approximate values outside
the safe integer range. `BigIntGuardInterceptor` fails the response outside production if an
unconverted `bigint` still reaches the encoder — better a 500 in development than a string
where the contract promises a number (`context/43` section 5.3).

**Errors** (`src/common/errors`). Services throw `SysError` with a code from a fixed
catalogue; one exception filter maps code to HTTP status and renders the single envelope
`{ error: { code, message, details, requestId } }`. The code, not the status, is the
contract: `VERSION_CONFLICT`, `WORK_ALREADY_STARTED`, `MODE_MANUAL`, `SNAPSHOT_STALE` and
`RESULT_NOT_APPLICABLE` are all 409 and must stay distinguishable without parsing prose.

**Request context and logging** (`src/common/logging`). An `AsyncLocalStorage` request id
travels with every log line and every error body, and is echoed in `x-request-id`. Logs are
one JSON object per line; login codes, passwords and token values are never passed to the
logger.

**Health** (`src/common/health`). Three endpoints outside the `api/v1` prefix: `health/live`
(process), `health/ready` (required dependencies only) and `health/services` (everything,
including integrations that are not wired). Modules register their own probes in
`HealthRegistry`, so an unreachable SMTP or LLM can never make the application look down —
the dispatcher's password login must work exactly when the mail contour is broken
(`context/43` section 11.3).

## 4. Conventions

- TypeScript `strict`, no `any`, no non-null assertions.
- Build is `tsc` with `experimentalDecorators` and `emitDecoratorMetadata`; Vite is not used
  to compile Nest classes (`context/43` section 4).
- Tests run on the compiled output with `node:test`, so they exercise the same decorator and
  metadata build as production.
- Lint and format: Biome, scoped to `apps/**` and `packages/**`.
- `packages/shared` is owned by the contracts owner and is not modified from here
  (AGENTS.md section 3.4).

## 5. Missing contracts

Listed explicitly rather than stubbed with invented shapes (AGENTS.md section 10.3):

| Contract | Needed for | Status |
|---|---|---|
| Router Core HTTP surface (result, health, active context version, tolerance setting) | `ROUTER-gateway` | Not defined; sys will poll Router, direction agreed |
| AI-gateway tool call protocol | AI chats | Out of scope of this build |
| SMTP-gateway transport and accept result | Mail delivery | Out of scope of this build |
| Source of request coordinates (geocoding) | Publishable snapshot | Absent from the official dataset; separate data-zone task |
