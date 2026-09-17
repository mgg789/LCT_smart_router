# API — endpoints, conventions and missing contracts

> Updated in the same commit as the code it describes (AGENTS.md section 8.2).
> Generated schema: <http://localhost:8000/docs/openapi.json>; interactive: `/docs`.
> Architecture: [architecture.md](./architecture.md). Data model: [data.md](./data.md).
> Sections 1-10 are the System Layer API; section 11 is the Router Core service API (D-22).

## 1. Conventions

**Prefix.** Everything lives under `/api/v1`. The three health endpoints are outside it,
because a probe should not have to know the API version.

**Time.** Every absolute moment and every duration in a payload is an integer number of
Unix seconds (`context/33` section 4). No ISO strings, no milliseconds, no local dates.
Formatting for a human happens in the client, with an explicitly chosen zone.

**Authentication.** A bearer credential in the `Authorization` header, never in the URL,
where it would end up in access logs and browser history (`context/41` section 12):

```
Authorization: Bearer <session token | integration key>
```

Both kinds resolve through the same guard into one `Actor`. A UI session and an
integration key differ in provenance, not in which handler runs: a business rule exists in
exactly one place, and the UI, the integration API and (later) an AI tool must not grow
three diverging versions of it (`context/36` section 2).

**Roles.** A session acts as one role. An integration key has a category instead, mapped
onto the role whose UI actions it replaces: `client` → client, `eng` → engineer,
`master` → dispatcher. A `client` or `eng` key never gains dispatcher functions just
because the same person owns it (`context/41` section 5).

**Closed by default.** The guard is global and denies unless an endpoint is marked public.
A new route with no decorator is unreachable rather than open. The only public endpoints
are the two login-code ones, the dispatcher password login and health — exactly the
exceptions `context/32` section 15 allows.

**Errors.** One envelope, always:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Request changed since it was read; refresh and confirm again",
    "details": { "expectedVersion": 3, "currentVersion": 5 },
    "requestId": "0f0f…"
  }
}
```

The **code** is the contract, not the status. Several distinct refusals share 409 and must
stay tellable apart without parsing prose:

| Code | Status | Means |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Payload failed its schema; `details.issues` lists the paths |
| `UNAUTHENTICATED` | 401 | No credential, or it is no longer valid |
| `FORBIDDEN` | 403 | Known actor, wrong role or token category |
| `NOT_FOUND` | 404 | No such object, or not visible to this actor |
| `VERSION_CONFLICT` | 409 | Someone changed the object after the actor read it |
| `OPERATION_ID_REUSED` | 409 | Same operation id replayed with different arguments |
| `WORK_ALREADY_STARTED` | 409 | The engineer recorded a start; ordinary changes are closed |
| `MODE_MANUAL` / `MODE_AUTO` | 409 | The working plan is owned by the other control mode |
| `SNAPSHOT_STALE` | 409 | The result belongs to a snapshot that is no longer published |
| `RESULT_NOT_APPLICABLE` | 409 | Finished, but must not become the working plan |
| `CONFIRMATION_REQUIRED` | 409 | A destructive action without its explicit confirmation |
| `SERVICE_NOT_CONFIGURED` | 503 | An optional integration is not wired in this deployment |
| `INTERNAL_ERROR` | 500 | Unexpected; details are logged, not returned |

`requestId` echoes `X-Request-Id` when the caller supplies one, and is generated
otherwise. The same id appears on every log line of that request.

## 2. Changing anything: the operation envelope

Every write goes through one envelope (`context/36` sections 1, 8 and 12). Endpoints that
change state accept these fields alongside their own payload:

| Field | Required | Meaning |
|---|---|---|
| `operationId` | yes | Stable id of one business intention, chosen by the caller (a UUID). Retrying after a lost response repeats it |
| `expectedVersion` | when the action follows from a prior read | The `version` of the object the actor was looking at |
| `confirmation` | for actions that demand explicit confirmation | Reference to the confirmed intent |

**Retrying is safe and is the intended behaviour.** The same `operationId` with the same
arguments returns the first outcome without doing the work again — one request, one
`requestId`, one email. A refusal is stored too, so a retry after a lost response returns
the same refusal rather than attempting the work a second time.

**The same `operationId` with different arguments is refused** with
`OPERATION_ID_REUSED`. That is a caller bug, not a new write.

**`expectedVersion` is how concurrent edits are surfaced.** If the object changed after
the actor read it, the answer is `VERSION_CONFLICT` carrying `expectedVersion` and
`currentVersion`; the client refreshes and confirms again. Nothing is ever silently
overwritten. Only the data the operation is based on is checked — an unrelated chat
message does not invalidate an action (`context/36` section 8).

Business change, the record of who made it and the follow-up work it requires commit
together. Waiting on Router, AI or SMTP is deliberately outside that unit: a network call
never holds the transaction open, and a mail failure does not turn an already saved
request into a non-existent one.

## 3. Health

| Method | Path | Answers |
|---|---|---|
| GET | `/health/live` | The process is up |
| GET | `/health/ready` | Required dependencies are usable; 503 when not. Only the database gates readiness |
| GET | `/health/services` | Every dependency, including ones this build does not have |

`not_configured` is a real answer, not a failure. In this contour the `router` probe
pings Router Core's `/health` through the configured `ROUTER_BASE_URL`, so it reports the
real reachability of the Python service. `ai` and `smtp` report `not_configured` because
they are not wired. An unreachable SMTP or LLM must never make the application look down —
the dispatcher's password login has to work exactly when the mail contour is broken
(`context/43` section 11.3).

## 4. Auth

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/api/v1/auth/login-code` | public | Request a one-time code for an address |
| POST | `/api/v1/auth/login-code/verify` | public | Exchange a code for a session |
| POST | `/api/v1/auth/dispatcher/password` | public | Sign the dispatcher in without SMTP |
| GET | `/api/v1/auth/session` | any actor | Describe the actor behind the credential |
| DELETE | `/api/v1/auth/session` | any actor | Sign out; idempotent |
| POST | `/api/v1/auth/tokens` | dispatcher | Create an integration key |
| GET | `/api/v1/auth/tokens` | dispatcher | List keys without their secrets |
| DELETE | `/api/v1/auth/tokens/:id` | dispatcher session | Revoke a key |

### Behaviour worth knowing before integrating

- **Requesting a code reveals nothing.** The response is the same whether or not the
  address is known; otherwise the endpoint would be a directory of clients, engineers and
  the dispatcher.
- **A role is granted, never claimed.** `role: "client"` creates the account on first
  successful verification. `role: "engineer"` only works if the dispatcher created that
  engineer; otherwise the answer is indistinguishable from a wrong code, so the staff list
  does not leak (`context/36` section 7.2).
- **A code is single-use**, expires, is retired when a newer one is issued for the same
  address, and stops working after `LOGIN_CODE_MAX_ATTEMPTS` wrong guesses. Attempts are
  counted against the code, not the address, so a third party cannot lock someone out.
- **`devCode` in the response** appears only when `AUTH_DEV_EXPOSE_CODES` is on, which
  this build needs because it has no SMTP-gateway to deliver a code. The application
  refuses to start with it enabled in production.
- **Integration keys** take a name and a category and nothing else: no scopes, no expiry,
  no end-user binding, valid until deleted (`context/41` sections 3–4). The secret is
  shown once, at creation; a listing never re-reveals it. Revoking stops new calls and
  does not delete what the key created.
- **Keys cannot manage keys.** Creating one is a master-category function, but revoking
  requires a dispatcher session: key management is a Dashboard action.

## 5. Requests

### Client contour — `@Roles('client')`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/client/work-types` | Types of work to choose from |
| POST | `/api/v1/client/requests` | Prepare a request (a draft) |
| POST | `/api/v1/client/requests/:id/submit` | Confirm the content and send it |
| POST | `/api/v1/client/requests/:id/reschedule` | Change the date and window immediately |
| GET | `/api/v1/client/requests` | Active requests of this customer |
| GET | `/api/v1/client/requests/:id` | One request |

### Dashboard contour — `@Roles('dispatcher')`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/dispatch/requests` | The day, including started, finished and cancelled work |
| POST | `/api/v1/dispatch/requests` | Create a request on behalf of a customer |
| PATCH | `/api/v1/dispatch/requests/:id` | Change window, address, point or urgency |
| POST | `/api/v1/dispatch/requests/:id/cancel` | Cancel work that has not started |
| GET | `/api/v1/dispatch/requests/:id/history` | Previous conditions |

### The rules these endpoints enforce

- **Three states, not one.** A response carries `lifecycle` (business stage) and
  `assignmentState` (outcome of distribution) separately, and facts live in their own
  table. `pending` means "waiting for a current result" — not a refusal, and never turned
  into `unassigned` by an ongoing calculation or a Router error (`context/36` section 3).
- **A draft is not a task.** It is not in the free pool, produces no mail, and is not
  published. Only the confirmation makes it real.
- **The customer never types routing parameters.** The required skill, the expected
  duration and any transport restriction are derived from the type of work
  (`context/32` section 4.1). Urgency can raise the priority and never lowers it.
- **Duration comes from a work-norm profile, stored split.** Every one of the 16 work
  types maps to one of four profiles (`connection_base`, `outage_tkd`, `equipment_order`,
  `local_repair`); the importer stores the profile code plus its technical and
  documentation components, whose sum is `serviceDurationSec`, and a normative travel
  allowance (1200 s). The breakdown is visible on the request view, not recomputed at
  read time.
- **A reschedule keeps one request id and one live window.** The previous conditions go to
  history, which is a journal, not a second promise to the customer. The previous
  assignment does not confirm the new conditions, so the outcome returns to `pending`. If
  the new window finds no assignment, the old one is *not* restored automatically
  (`context/36` section 4).
- **Once the engineer records a start, ordinary changes are closed** — reschedule, edits
  and cancellation all answer `WORK_ALREADY_STARTED`, through every path: a stale screen,
  a link in an old email, a new session or an integration key (`context/42` DF-05).
- **Cancellation is a state change with its own timestamp**, never a deletion, and never
  follows automatically from a request going unassigned.
- **A customer sees only their own requests.** Someone else's is reported as absent rather
  than forbidden, because confirming that it exists is itself a disclosure.
- **A request without coordinates is stored and marked**, then excluded from the published
  snapshot with a counted diagnostic. Coordinates are never invented.

## 6. Engineers and working days

### Engineer contour — `@Roles('engineer')`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/engineer/profile` | Own profile |
| PATCH | `/api/v1/engineer/profile` | Change own skills, transport or usual start point |
| GET | `/api/v1/engineer/day` | Shift, availability and lunch state of today |
| POST | `/api/v1/engineer/availability` | Go online or offline, with an expected return |
| POST | `/api/v1/engineer/technical-break` | A 15-minute technical stop |
| POST | `/api/v1/engineer/lunch/start` · `/finish` | Record the actual start and the return |

Everything acts on the signed-in engineer. There is no field in which to name someone
else: the subject comes from the session (`context/42` DF-06).

### Dashboard side

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/dispatch/engineers` | Engineers with skills, transport and their current day |
| POST | `/api/v1/dispatch/engineers` | Add an engineer by address |
| PATCH | `/api/v1/dispatch/engineers/:id` | Change a profile |
| POST | `/api/v1/dispatch/engineers/:id/workday` | Set the shift and lunch conditions |
| POST | `/api/v1/dispatch/engineers/:id/availability` | Take an engineer off the line, or back on |
| POST | `/api/v1/dispatch/engineers/:id/technical-break` | Put an engineer on a 15-minute technical stop; the day goes offline |

### The rules these endpoints enforce

- **Only the dispatcher creates an engineer.** Typing an address on the engineer sign-in
  screen never produces the role. Creating the access and having someone Router can plan
  for are different results: skills, transport and a start point must be real values, and
  missing ones are never invented (`context/42` DF-03).
- **Profile and working day are separate.** The shift, availability and lunch facts belong
  to one day, so "already had lunch" cannot become a permanent property of a person.
- **Lunch cannot be enabled without a duration and a full window**, and the whole lunch
  must fit inside the window. The hours were never agreed, and a feature that is switched
  on must not run on an invented norm (`context/32` section 8). `required` together with
  `enabled: false` is contradictory and is refused.
- **`lunchTaken` is set only by the engineer actually starting lunch** — not by publishing
  a schedule. It means the single lunch of the day is used up, not that it has finished,
  and it survives a restart, a mode switch and turning the feature off and on again.
- **`online` is working availability**, not a network state and not "free right now".
  Going offline does not finish the work in hand and does not reassign it.
  `expectedOnlineAt` is a forecast: reaching it creates no online fact.
- **The engineer and the dispatcher edit the same profile through the same handler**, so
  their concurrent edits meet one version check and neither silently overwrites the other.
  Which of them may change skills, transport and office is explicitly still open
  (`context/36` section 14.2); the restriction lives in the controller so it can change
  without touching the logic.

The engineer's route for the day is the applied working plan (`GET /api/v1/engineer/plan`),
and what an engineer may mark are the execution facts of that plan (section 8). Location
tracking is not part of the product at all: GPS collection was removed by decision
(`context/50` section 2), and there is no position endpoint, table or live layer.

## 7. The published planning task

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/dispatch/policies` | Prepared policies and the one in force |
| POST | `/api/v1/dispatch/policy` | Choose a prepared policy |
| GET | `/api/v1/dispatch/router/technical-settings` | The Router-owned technical revision in force, with its context version |
| PUT | `/api/v1/dispatch/router/technical-settings` | Replace the whole revision (operation envelope; see below) |
| GET | `/api/v1/dispatch/debug/snapshot` | The published task exactly as Router reads it |

`mount-data-eng` publishes the **whole current task**, never a stream of changes. Work that
is finished, cancelled or already under way is removed before publication, which is why
Router needs no business status per request (`context/33` section 5).

### What publishes, and what must not

Publication happens only on a listed business trigger — a confirmed request, changed
conditions, a cancellation, an engineer created or edited, a shift or availability change,
a lunch actually started, a policy change, an execution fact with a material timing
consequence (`request.execution_started`, `request.execution_variance`,
`request.execution_overrun`), an import or a reset. The list is a closed enum in
`publication-triggers.ts`.

Deliberately **not** triggers, each for a stated reason:

| Event | Why not |
|---|---|
| Time passing | There is no replanning timer; `planning_as_of` does not tick. The single deliberate exception is the execution-overrun poller, which only *detects* an overrun of an already started task and publishes its projection — it never rebuilds the plan |
| A routine completion without material variance | Following the current plan needs no re-optimisation; a finish inside both tolerances moves no anchor that Router can see |
| An engineer's silence | An expired estimate does not become `null`, offline, or a refusal |
| Reading anything | A read publishes nothing and moves no pointer |

And even on a real trigger, a projection byte-identical to the published one is **not**
republished and `planning_as_of` does not move. Rewriting the same content must not
produce an endless series of timestamps (`context/33` section 7).

### Hash and storage

The document is serialized once by the canonical rules of
[contracts/snapshot-canonical.md](./contracts/snapshot-canonical.md); the same string is
stored and hashed.

Two digests are kept, and the distinction matters. `input_hash` covers the **whole
document, including `planning_as_of`** — that is what a Router result is matched against.
`task_fingerprint` covers the task **without** that timestamp, and it is what answers "did
the task actually change". Comparing `input_hash` would report a change every second,
because the timestamp is inside the thing being hashed, so the "nothing changed" rule would
never fire and `planning_as_of` would tick. The contract puts the change check before the
time is stamped (`context/33` section 7), and the fingerprint is how that is done. The snapshot row and the pointer switch commit in one transaction with
the pointer locked, so a slow publisher cannot move the active task back to an older
projection. Published snapshots are immutable and kept; only the pointer moves.

### Diagnostics

`debug/snapshot` returns `diagnostics` computed **live** from current data, plus
`diagnosticsAtPublication` frozen on the document. The distinction matters: a request still
waiting for coordinates cannot be projected, so it does not change the task and triggers no
publication — a count frozen at publication time would never mention it. Live diagnostics
report what is currently excluded and why:

| Field | Means |
|---|---|
| `requestsWithoutLocation` | Submitted work with no coordinates; they are never invented |
| `requestsOutsideHorizon` | Work whose window lies entirely outside this task's period |
| `engineersWithoutStartLocation` | No usable start point, so no route could begin |
| `engineersWithoutShift` | A working day exists but nobody has set a shift |
| `engineersWithoutWorkday` | No working day for this horizon at all |
| `engineersOverrun` | Engineers withdrawn from the task because their started work overran its tolerance (`overrunDetectedAt` is set) |

An engineer with no shift is excluded rather than given an invented one: a calendar-day
default would let work be scheduled at three in the morning.

### Router technical settings, driven from sys

The eight Router-owned controls that version the calculation context — `lunchesEnabled`
(off by default since `context/50`), the two revalidation tolerances, `travelTimeMode`
(`graph_with_access_buffer` or `fixed_normative`), `accessBufferSec`, `fixedTravelTimeSec`,
`earlyFinishReplanThresholdSec` and `taskOverrunToleranceSec` — are read and replaced as
one revision:

- `GET /api/v1/dispatch/router/technical-settings` reads them from Router's `GET /v1/context`
  together with the active `router_context_version`; the read-through is not cached as
  state.
- `PUT /api/v1/dispatch/router/technical-settings` goes through the operation envelope and
  `executeExternal`: the journal row is reserved as `outcome_unknown`, the remote
  `PUT /v2/config/technical-settings` (with `operation_id` and `expected_context_version`)
  runs **outside** any database transaction, and the journal is finalised to
  `applied`, `conflict` or `rejected` afterwards. A replayed `operationId` returns the
  stored outcome without calling Router again; a crash between the call and the finalisation
  leaves the row pending for retry, and Router's own durable operation receipts make the
  retried call idempotent. Router's HTTP 409 surfaces as `VERSION_CONFLICT` with Router's
  `detail` preserved.

The same external-operation pattern (reserved journal row, remote call outside the
transaction, finalise after) backs `engineer.technical-break` and `data.import`, so a lost
response can never repeat a side effect or lose the record of one.

## 8. The working plan, control mode and facts

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/v1/dispatch/plan` | dispatcher | The applied plan, the control mode and the last result |
| POST | `/api/v1/dispatch/mode` | dispatcher | Switch emergency manual control on or off |
| POST | `/api/v1/dispatch/plan/reassign` | dispatcher | Move work that has not started to another engineer |
| POST | `/api/v1/dispatch/plan/reorder` | dispatcher | Save the finished order of one queue |
| GET | `/api/v1/dispatch/alerts` | dispatcher | Explainable problems from the plan |
| POST | `/api/v1/dispatch/alerts/:id/seen` | dispatcher | Mark an alert seen |
| GET | `/api/v1/engineer/plan` | engineer | This engineer's route for the day |
| POST | `/api/v1/engineer/requests/:id/facts` | engineer | Record a confirmed execution fact |
| POST | `/api/v1/dispatch/debug/router-result` | dispatcher | Feed a result through the acceptance checks |

### Acceptance: five independent checks

A result becomes the working plan only if **all** of these hold (`context/33` section 7):

1. the mode allows it — in MANUAL the Router-to-sys bus is disconnected;
2. `input_hash` matches the snapshot published **now**;
3. `router_context_version` matches the version in force **now** — a result cannot report
   its own currency, so the active version is read separately;
4. `main.is_usable` — a finished answer is not automatically an applicable one, and
   `false` does not prove the visits are impossible;
5. no conflict with explicit facts — started, finished or cancelled work is not
   redistributed, and a used lunch is not planned again.

Each failure has its own code, so a stale answer, an unusable plan and a manual-mode
refusal stay distinguishable. Refused packages are stored with the reason: a refusal has
to be explainable afterwards, not invisible.

**When a result conflicts with the facts, sys does not repair it.** It declines to apply
it and publishes a current projection instead. Choosing assignments is Router's job and
stays Router's job.

Re-reading the same `result_id` does not apply it again, does not return completed work to
the pool and does not repeat a letter. The single exception is the explicit return to AUTO,
which may apply a still-suitable result the system has seen before.

### The plan itself

Each acceptance adds an **immutable revision**; a pointer names the one in force (D-10).
The revision carries `planAsOf` — the moment the plan describes. While a recalculation is
under way the interface keeps showing the last applied plan with that moment, rather than
clearing the day or borrowing the timestamp of a snapshot that has not been computed yet
(`context/36` section 6). `origin` says `auto` or `manual`, so a manual plan never looks
like a fresh calculation.

### Manual control

Manual mode disconnects exactly one thing: the delivery of Router's result into sys. Router
keeps computing, the sector keeps being read, requests keep arriving; the answers simply
stay inside Router. The dispatcher becomes the author of the plan and gets two gestures,
reassign and reorder — no group draft, no "apply changes" button, and no ETA required.
Old automatic times are not recomputed and are not presented as if they had been: sys runs
no hidden optimiser.

Returning to AUTO is an explicit transition. The current result replaces the *future*
distribution; it does not merge with the manual plan and undoes nothing that happened.

### Facts

`arrived`, `arrived_blocked`, `started`, `finished`, `problem` — every one an explicit mark
by the engineer. Nothing creates a fact from a schedule or from silence — the single
exception, again deliberate, is the overrun detection below, which derives a *diagnostic*,
never a completion. Arrival and start are separate events, so someone on site who cannot
begin reports exactly that. Finishing work that never started is refused rather than
inferred. `occurredAt` (when the engineer says it happened) and the stored `recordedAt` are
kept apart.

An engineer may only mark work the **applied plan** assigned them.

### Execution timing

A started fact is where prediction meets reality, and the request row carries the state it
creates: `expectedCompletionAt` (started at + service duration), `continuationAvailableAt`
(when the engineer can take the next task) and, when things go wrong, `overrunDetectedAt`.

- **Start** records one active task per engineer (a second start is refused), sets
  `expectedCompletionAt` and `continuationAvailableAt`, and publishes
  `request.execution_started`.
- **Finish** is refused if it predates the start (422). Otherwise the variance is
  classified against the two Router-owned tolerances: finishing at least
  `earlyFinishReplanThresholdSec` early, or more than `taskOverrunToleranceSec` late, or
  after a detected overrun is a **material variance** — `continuationAvailableAt` moves to
  the actual finish and `request.execution_variance` is published. An absorbed deviation
  (for example 14 minutes early) changes no anchor and publishes nothing.
- **Overrun** is detected by a background coordinator (`ROUTER_POLL_INTERVAL_MS`, disabled
  in tests) that marks `overrunDetectedAt` on in-progress requests past
  `expectedCompletionAt + taskOverrunToleranceSec` and publishes
  `request.execution_overrun`. The engineer disappears from the next published snapshot
  (counted in `engineersOverrun`); no finish fact is ever invented.

The two thresholds are read from Router's technical settings
(`ExecutionTimingPolicy`), with defaults of 900 and 600 seconds when Router is not
configured — so the classifier stays honest about whose numbers it is using.

## 9. Data: import and the two resets

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/dispatch/data/state` | Whether the application is initialised, how, and what has been imported |
| POST | `/api/v1/dispatch/data/import` | Load one, several or all regions of the official dataset |
| POST | `/api/v1/dispatch/data/upload` | Atomically load a JSON package for a new region or append requests to an existing region |
| POST | `/api/v1/dispatch/data/reset` | Reset to the test data, or to an empty working set |

### Import

The organisers' files are windows-1251 with `;` separators and Russian headers, and they
are the untouched source of truth. The importer handles the anomalies they actually
contain: blank rows, the regional office hidden in a last row that looks blank, empty and
all-day windows (a missing window is treated as the full source day, and the date is
derived from the rows), missing districts, four spellings of the Moscow prefix, and
impossible windows (`31.02` is an error, not a guess).

`POST /api/v1/dispatch/data/import` takes `region` (one) **xor** `regions` (`"all"` or an
explicit list of `east`, `southeast`, `south_central`), plus an optional
`engineerCountPerRegion` cap that must not exceed the crews the dataset actually contains.
The whole batch — every requested region — applies atomically or not at all, and the
summary reports per-region results. For `regions: "all"` that is 205 requests and 35
engineers across the three regions.

Three rules from `context/37` section 9.1:

- **the package is checked before anything is applied** — including the SHA-256 of every
  source and geocode byte; re-importing the same source with different bytes is a 422, not
  a silent overwrite;
- **an error means nothing is applied** — a half-loaded file leaves a state nobody chose.
  A type of work that is not in the catalogue is an error, because mapping it to the
  nearest familiar one would silently send the wrong engineer;
- **repeating a package creates no duplicates**, recognised by origin and content rather
  than by file name.

What the dataset does not contain matters as much. There is no engineer directory, no
durations, no priorities and no coordinates (`context/18` section 6.3). Crews come from the
`Бригада` column of the control distribution; their skills and transport are derived by a
stated, deterministic rule and stored with `origin = synthesized`, so a derived value never
looks like data. **Coordinates come only from a versioned geocode package** at
`data/dataset/geocoded/<region>.json` (strict schema, one entry per request address plus
the depot); the import refuses to run without a package that covers every address, and
imported requests are created with real points — nothing sits in `needsGeocoding`. Benchmark
windows are rebased onto the live horizon (shifted to start 60 seconds after import), so a
dataset dated 17.08 plans against "now" without editing the CSVs.

### Dispatcher JSON upload

`POST /api/v1/dispatch/data/upload` accepts one strict `schemaVersion: "1.0"` document.
`mode: "new_region"` requires a depot, at least one engineer and at least one request;
`mode: "append_requests"` accepts only requests and requires the named region to exist.
The browser performs the same structural checks for immediate feedback, but the server is
authoritative. Coordinates are WGS84 and all times are Unix seconds.

The entire package runs in the operation transaction. Duplicate IDs inside a file, an
unknown structure, an impossible time interval, a changed row behind an existing external
ID, or a mode/region mismatch rejects the whole package. An exact package replay is
idempotent. A matching existing request is skipped with a warning; the same external ID
with different business data is a conflict. A successful import publishes one new Router
snapshot and returns its `publicationId` and `inputHash`.

The request shape and an executable example live in
[`data-upload-example.json`](./data-upload-example.json). Uploaded engineers receive the
standard optional 45-minute lunch window 11:20–15:00 local time. The global Router switch
still decides whether those lunch inputs participate in a calculation.

### Resets

Adding data, resetting to the test data and a full reset are three different actions, and
both resets require an explicit confirmation phrase naming what will be affected:

| Action | Confirmation |
|---|---|
| `kind: "demo"` | `reset to test data` |
| `kind: "empty"` | `erase all application data` |

The refusal lists what the action would remove and what it would keep, so the confirmation
is an informed one. An integration key cannot confirm a reset: it carries the dispatcher's
authority, not their confirmation, and an AI may prepare either action but never confirm it
on the dispatcher's behalf (`context/42` DF-24).

A reset clears **data, not the application**. Source code, `.env`, the schema and the
knowledge sources stay, and the dispatcher account is restored from configuration rather
than from a hidden archive of old users. It does clear sessions — including the one that
confirmed it, so the Dashboard asks for a new sign-in. After an empty reset the startup
profile records that the emptiness was deliberate: an empty `requests` table is not proof
that setup never happened, and a restart must not quietly reload the demo data
(`context/37` section 9.5).

## 10. Missing contracts

Listed rather than stubbed with invented shapes (AGENTS.md section 10.3).

### Router Core HTTP surface — implemented

**No longer missing.** Router Core V2 (D-22) publishes its private service API, reproduced
in section 11 below with machine-readable payloads in `core/schemas/`. The gateway's HTTP
client (`http-router-client.ts`) speaks all of it:

| What `ROUTER-gateway` needs | Router endpoint |
|---|---|
| Current result | `GET /v1/result` |
| Active context version and technical settings | `GET /v1/context` |
| Replace technical settings (CAS, idempotent) | `PUT /v2/config/technical-settings` |
| Reachability | `GET /health` |

The payload shapes were written independently on both sides from `context/33` and agree
field for field: `plan`, `engineer_route`, `route_stop`, `route_leg`, `assignment`,
`lunch_result`, `route_metrics`, `plan_metrics`, `planning_alert`, `reason` and
`diagnostic` in `result.types.ts` have exactly the properties of the matching `$defs` in
`core/schemas/router-result-1.0.json`, in both directions. The same holds for the
published task: the golden vector in `docs/contracts/fixtures/` validates against
`core/schemas/router-task-snapshot-1.0.json`, including every enum.

Applied plan routes persist Router legs instead of reconstructing travel in the UI. Every
leg exposes `travelSource` (`approximate`, `road_matrix`, `route_api`, or `traffic_api`),
`trafficFactor`, distance, duration and optional provider geometry. `road_matrix` means
road distance/time is known; it does not imply that a drawable road polyline was returned.

Acceptance checks `input_hash` **and** `input_publication_id` against the snapshot
published now, plus the context version. What is deliberately still open:

* **The evidence bundle is not consumed yet.** Router also returns `input_publication_id`,
  `policy_id`, `policy_criteria`, `search_path`, `technical_settings`, `main_evidence` and
  `baseline_evidence`. `routerResultSchema` keeps them (it is a loose object), but nothing
  downstream acts on the evidence yet — and the evidence bundle is the supported input for
  map explanations. Wiring it to the UI is the next contract, not a silent merge.

The debug endpoint `POST /api/v1/dispatch/debug/router-result` remains as a test way in
that runs the identical acceptance checks — never a second way to apply a plan.

### Snapshot serialization — shared with Router Core

sys and Router must hash **the same bytes** of the same document, or `input_hash` can never
match. The byte-level rule is written down in
[contracts/snapshot-canonical.md](./contracts/snapshot-canonical.md) with a golden vector
in [contracts/fixtures/](./contracts/fixtures/), reproduced independently in TypeScript and
Python.

In practice the shared path does not depend on re-serialization at all: sys publishes exact
bytes and their SHA-256, and Router hashes the bytes it was given
(`core/runtime.py`, `SnapshotPublication`). The specification is what keeps a future
re-serializer on either side from drifting, and it remains the rule.

### Out of scope of this build

`AI-gateway` tool protocol and `SMTP-gateway` transport. sys will record mail intents;
delivery belongs to the external mail server, which is not in this contour.

## 11. Router Core private API

### Boundary

Router exposes a private service API to System Layer. Authentication and business
authorization remain in sys. Router accepts no endpoint that directly assigns a job,
changes route order or applies a plan.

### Read endpoints

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

### Technical settings

`GET /v1/context` returns the active `router_context_version` plus the complete technical
revision. `PUT /v2/config/technical-settings` replaces that revision in full — partial
updates are refused:

```json
{
  "operation_id": "settings-42",
  "expected_context_version": "<sha256>",
  "lunches_enabled": false,
  "departure_lateness_tolerance_sec": 120,
  "task_start_lateness_tolerance_sec": 60,
  "travel_time_mode": "graph_with_access_buffer",
  "access_buffer_sec": 600,
  "fixed_travel_time_sec": 1200,
  "early_finish_replan_threshold_sec": 900,
  "task_overrun_tolerance_sec": 600
}
```

Defaults: `lunches_enabled=false`, both revalidation tolerances `0`,
`graph_with_access_buffer` with a 600-second access buffer, `fixed_travel_time_sec=1200`,
`early_finish_replan_threshold_sec=900`, `task_overrun_tolerance_sec=600`; every field is
capped at 86400.

The operation uses compare-and-swap against the active context and is idempotent —
durably, not just within a process: accepted operations are stored as receipts in the same
atomic document as the settings (schema `1.0`), so a replay after a restart returns the
original outcome instead of conflicting. A write is rejected with
`SETTINGS_STORE_UNAVAILABLE` when the Runtime has no durable settings store. Every change
creates a new context version and invalidates an in-flight older result.

`travel_time_mode` decides how every non-zero leg is priced, on top of the connected road
graph and without changing its paths or distances: `graph_with_access_buffer` adds
`access_buffer_sec` to the graph duration; `fixed_normative` replaces the duration with
`fixed_travel_time_sec`. A zero-distance leg stays zero in both modes. The wrapper owns a
derived version (`base graph version + timing configuration`), so a timing-only change
still invalidates results.

The lunch switch is a hard system policy. When false — the default since `context/50` —
no optional or required lunch is scheduled in either main or baseline; the sys-owned input
bytes and lunch facts remain unchanged. The two revalidation tolerances only decide whether
a changed schedule can use `REVALIDATE`. `early_finish_replan_threshold_sec` and
`task_overrun_tolerance_sec` are consumed by sys's execution-timing policy to classify
finish variance and detect overruns (section 8). None of these values ever extend customer
windows or engineer shifts.

`PUT /v1/config/tolerance` remains a compatibility alias for the departure tolerance.
Conflicting operation IDs or stale context versions return HTTP `409`; malformed bodies
return `422`.

### Versioning

The service version is `2.0`. The sys exchange payload remains `schema_version="1.0"`
because V2 adds output metadata and Router-owned context without changing the shape of
`RouterTaskSnapshot`. Unknown fields and unknown policy IDs are rejected.

Checked integration artifacts live in `core/schemas/`. Regenerate them with
`python -m core.schema`; CI/tests should treat a schema diff as a contract change.
