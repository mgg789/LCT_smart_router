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
                            │                   Router Core (root `core/`)
                            ◄── ROUTER-gateway ──┘  result, accepted only in AUTO
```

The dispatcher Dashboard lives in `apps/web` (`docs/web.md`). It reads sys views; it does
not talk to Router or the database. In compose it is the `web` service on
`http://127.0.0.1:5173`, proxying `/api` to `api`. The public demo gate is
`https://navix.droidje.com` (host nginx → that loopback port). Pipeline and
deploy path: [ci.md](./ci.md).

The System Layer owns business state, authorization, user operations, the applied working
plan and its execution. It prepares the input for Router Core, accepts a current result and
serves the interfaces. It does **not** repeat Router's optimization, edit Router's memory,
or invent execution facts from the passage of time (`context/32` section 9).

## 2. Internal blocks

The eight blocks named in `context/36` section 2 are modules of one Nest application, not a
service each.

| Block | Module | State |
|---|---|---|
| `REST API` | `src/api`, `src/common` | Foundation plus the auth surface: routing prefix, error envelope, Zod validation, request context |
| `auth-engine` | `src/auth` | Implemented: login codes, dispatcher password path, sessions, roles, integration keys, global guard |
| `orchestrator backend` | `src/orchestrator`, `src/operations` | Operation envelope (including external operations with reserved journal rows), request lifecycle with work-norm profiles and execution timing, engineers, working days, lunch, policy, execution facts and the execution-overrun coordinator. GPS is removed entirely (`context/50`) |
| `dataengine` | `src/persistence` | Implemented: schema, migrations, connection, transaction boundary, row locks, health probe |
| `mount-data-eng` | `src/routing/mount-data-eng` | Implemented: projection (with execution anchors — an active task pins the engineer's start point and `available_from`), canonical serialization, hash, immutable snapshots and the pointer switch |
| `ROUTER-gateway` | `src/routing/router-gateway` | Implemented end to end: HTTP client to Router Core (`/v1/result`, `/v1/context`, `PUT /v2/config/technical-settings`), acceptance checks (publication id + hash + context version + usability + facts), applied plan revisions, AUTO/MANUAL, manual edits, technical settings driven from sys |
| `AI-gateway` | — | Out of scope of this build; declared in `/health/services` as `not_configured` |
| `SMTP-gateway` | `src/notifications` (intents only) | sys records mail intents with per-transition deduplication; transport is out of scope of this build |

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

**Result acceptance** (`src/routing/router-gateway`). Five independent checks decide
whether a finished result becomes the working plan: mode, snapshot hash, context version,
usability, and absence of conflict with explicit facts. Both singletons are locked first,
so a result already being validated cannot land after the dispatcher takes manual control.
When a result conflicts with the facts sys declines it and publishes a current projection;
it never repairs the plan with an optimiser of its own. Each acceptance adds an immutable
revision carrying the moment it describes.

**Snapshot publication** (`src/routing/mount-data-eng`). Publishes the whole current
planning task on a listed business trigger, and only when the projection actually differs
from the one already published. The insert and the pointer switch commit together with the
pointer locked, so a slow publisher cannot move the active task backwards. What cannot be
projected -- a request without coordinates, an engineer without a shift -- is counted in
diagnostics rather than dropped, and those diagnostics are computed live, because an
unprojectable request changes no task and therefore triggers no publication that could
record it.

**Canonical JSON** (`src/common/json`). One document must produce one byte sequence in
both TypeScript and Python, because sys and Router hash the published snapshot
independently. `JSON.stringify` and `json.dumps` agree on syntax but disagree on numbers,
so the module fixes sorted keys, no whitespace, literal non-ASCII, integers without a
decimal point and every other number at exactly seven decimal places. The rules are stated
in the file and asserted by unit tests; Router Core has to reproduce them.

**Operation envelope** (`src/operations`). The single entry point for every change: an
`operationId` makes a retry return the first outcome instead of repeating the work, a
fingerprint of the arguments makes reuse of an id detectable, `expectedVersion` turns a
concurrent edit into a reported conflict instead of a silent overwrite, and the journal
entry is written in the same transaction as the change so it cannot be missing for
something that happened.

**Access control** (`src/common/access`, `src/auth`). The guard is global and denies by
default, so a new endpoint without a decorator is unreachable rather than public. It
resolves either a session token or an integration key into one `Actor`, and a category is
mapped onto the role whose UI actions it replaces. The decorators live in `common/access`
because health has to declare itself public without depending on the auth module.

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
| Router Core HTTP surface (result, health, context version, technical settings) | `ROUTER-gateway` | **Implemented end to end**: `http-router-client.ts` calls `/v1/result`, `/v1/context` and `PUT /v2/config/technical-settings`; acceptance checks publication id + hash + context version (`docs/api.md` sections 10–11). Open: the evidence bundle (`main_evidence`/`baseline_evidence`) is parsed but not yet consumed by any view |
| AI-gateway tool call protocol | AI chats | Out of scope of this build |
| SMTP-gateway transport and accept result | Mail delivery | Out of scope of this build |
| Source of request coordinates (geocoding) | A publishable snapshot with anything in it | Resolved for the official dataset: the import requires a versioned geocode package at `data/dataset/geocoded/<region>.json` (declared district-centroid projections, provenance stored). Ad-hoc requests without coordinates are still excluded and counted, never invented |
