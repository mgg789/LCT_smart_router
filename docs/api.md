# API — endpoints, conventions and missing contracts

> Updated in the same commit as the code it describes (AGENTS.md section 8.2).
> Generated schema: <http://localhost:8000/docs/openapi.json>; interactive: `/docs`.
> Architecture: [architecture.md](./architecture.md). Data model: [data.md](./data.md).

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
overwritten. Only the data the operation is based on is checked — an unrelated GPS point
or chat message does not invalidate an action (`context/36` section 8).

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

`not_configured` is a real answer, not a failure: `router`, `ai` and `smtp` report it
because they are not wired. An unreachable SMTP or LLM must never make the application
look down — the dispatcher's password login has to work exactly when the mail contour is
broken (`context/43` section 11.3).

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

## 5. Missing contracts

Listed rather than stubbed with invented shapes (AGENTS.md section 10.3).

### Router Core HTTP surface — needed by `ROUTER-gateway`

The direction is decided: **sys polls Router**; Router never writes into sys. What Router
has to expose is not defined yet. The System Layer will need, at minimum:

| Purpose | Shape |
|---|---|
| Current result | `RouterResult` of `context/33` section 8, including `resultId`, `inputHash`, `routerContextVersion`, `planningAsOf`, `computedAt`, `main`, `baseline`, `errors` |
| Active context version | The `routerContextVersion` in force *now*, read separately from any result package. A result cannot report its own currency (`context/33` section 7) |
| Health | Whether Router is reachable and computing |
| Tolerance setting | The one narrow configuration operation of `context/33` section 8: `operationId`, `toleranceSec`, `expectedContextVersion`; answered with accepted or rejected plus the active version |

Until it exists the gateway uses a null client that reports `pending`, and
`/health/services` says `router: not_configured`. The application is fully usable without
Router; it simply has no automatic plan.

### Snapshot serialization — shared with Router Core

sys and Router must hash **the same bytes** of the same document, or `inputHash` can never
match. `JSON.stringify` and `json.dumps` disagree on number formatting, so the byte-level
rule will be written down once, with a golden test vector both sides must reproduce.
Planned for the snapshot branch; see `context/43` section 5.2.

### Out of scope of this build

`AI-gateway` tool protocol and `SMTP-gateway` transport. sys will record mail intents;
delivery belongs to the external mail server, which is not in this contour.
