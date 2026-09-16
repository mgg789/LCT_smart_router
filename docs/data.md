# Data — model, storage rules and provenance

> Updated in the same commit as the code it describes (AGENTS.md section 8.2).
> Canon: `context/37` (Data Layer), `context/36` (System Layer states), `context/33`
> (Router contract), `context/18` (official dataset).
> Schema source of truth: [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).

## 1. Storage decisions

| Decision | Why |
|---|---|
| One PostgreSQL for everything | `context/37` section 2.1. The image is `pgvector/pgvector:pg17` so the knowledge segments can be enabled later without touching infrastructure; nothing uses vectors yet. |
| Prisma ORM, Prisma Migrate as the single schema history | D-23, which supersedes `context/43` sections 2.1 and 5.4 for the Node side. No `db push`, no create-on-boot: the runtime never changes the schema. |
| All times and durations are `BIGINT` whole seconds | `context/33` section 4. Local rendering happens at the edges only, by formatter, never by adding an offset to a stored value. |
| `routing_snapshots.payload` is `TEXT`, not `jsonb` | `jsonb` normalises whitespace and key order. sys and Router must hash an identical byte sequence, so the exact serialized document is stored (`context/43` section 5.2). |
| `version` columns on mutable business rows | Optimistic concurrency. A write based on something the actor read carries the version it saw; a mismatch is a reported conflict, never a silent overwrite (`context/36` section 8). |
| Rows are not deleted to express an outcome | Cancellation, revocation and completion are states with their own timestamps. History has to survive; `context/37` section 6. |
| Tables **and columns** are snake_case | Router Core reads the published sector directly, from Python. An unquoted `SELECT inputHash` there folds to `inputhash` and fails, and requiring every cross-language query to quote a camelCase identifier is a trap. Prisma models keep their camelCase field names and carry `@map`. |

## 2. Areas of the model

Names below are physical tables; the semantic areas they implement are the ones on the
Data Layer board in `context/37` section 2.

| Area | Tables |
|---|---|
| Identity and access | `accounts`, `account_roles`, `login_codes`, `sessions`, `api_tokens` |
| Engineers | `engineers` (stable profile), `engineer_days` (one working day), `depots` |
| Requests | `requests`, `request_condition_history`, `request_facts` |
| Telemetry | `gps_observations` |
| Published sector | `routing_snapshots` (payload, `input_hash`, `task_fingerprint`), `routing_current` |
| Plan | `router_results`, `applied_plans`, `applied_plan_routes`, `applied_plan_stops`, `applied_plan_assignments`, `applied_plan_current`, `control_state` |
| Dispatcher catalogues | `policies`, `active_policy`, `alerts` |
| System bookkeeping | `operations`, `audit_log`, `notification_intents`, `app_state`, `import_packages`, `external_id_map` |

### Distinctions the schema is built to preserve

- **Request state is not one status.** Business stage (`lifecycle`), distribution outcome
  (`assignment_state`) and the visit's progress (`request_facts`) are separate columns and
  tables. Collapsing them was explicitly rejected in `context/36` section 3.
- **Stable profile vs. one working day.** `engineer_days` holds the shift, availability,
  lunch conditions and `lunch_taken`, so "already had lunch" can never become a permanent
  property of a person (`context/37` section 3.2).
- **Computed schedule vs. confirmed fact.** `applied_plan_stops` holds arrival, start and
  end times that were *calculated*. A fact only exists in `request_facts`, and only
  because an engineer marked it. No timer produces one (`context/36` section 5.2).
- **Four timestamps that are not interchangeable**: `planning_as_of` (when the input was
  published), `computed_at` (when Router produced a result), `applied_at` (when sys
  accepted it) and `occurred_at`/`recorded_at` on a fact.
- **Mail intent vs. delivery.** `notification_intents` has no `delivered` state. Our
  control ends when an external SMTP server accepts a message (`context/42` DF-20).

## 3. Privilege model

The initial migration creates two group roles with real GRANTs, `NOLOGIN` and without
passwords. A deployment creates the login users and grants them these roles, so no secret
enters the repository.

| Role | May |
|---|---|
| `sys_app` | Select, insert, update and delete every business table. The application connects as this role. |
| `router_readonly` | `SELECT` on `routing_snapshots`, `routing_current` and the `router_active_snapshot` view, and nothing else. No default privileges, so a table added later stays invisible until someone grants it deliberately. |
| migration owner | Applies migrations, via `MIGRATE_DATABASE_URL`. Falls back to `DATABASE_URL` on a developer machine. |

Router Core reads the published sector directly and must not reach sessions, contacts,
chats or the optional GPS observations (`context/37` section 4.4). That is asserted by
`apps/api/test/integration/database-privileges.test.ts`, which runs `SET LOCAL ROLE
router_readonly` and expects `permission denied` on business tables — a naming convention
would pass review and fail in production.

### The `router_active_snapshot` read contract

Router V2 does not receive the task; it reads it. Migration
`20260916120000_router_active_snapshot_view` creates the view Router's own SQL names, and
the same test runs that query verbatim as `router_readonly`:

| Router's column | Comes from |
|---|---|
| `publication_id` | `routing_snapshots.id` |
| `publication_seq` | `routing_current.pointer_version` — increases by one per swap, so a lower value genuinely is a rollback |
| `payload_utf8` | `routing_snapshots.payload`, the exact hashed bytes |
| `payload_sha256` | `routing_snapshots.input_hash` |
| `published_at_epoch` | `routing_snapshots.created_at` |

The view joins the singleton pointer, so it yields one row or none, never two — which is
what Router checks before it will plan on anything. The mapping lives in the view on
purpose: either side can rename its own columns without touching the other. The test also
re-hashes `payload_utf8` and compares it with `payload_sha256`, because that is the first
thing Router does with the row.

## 4. Reference values

Codes are the technical identifiers of `context/33` section 4; the Russian terms are the
ones the case statement uses.

| Enum | Values | Russian meaning |
|---|---|---|
| `Skill` | `local` / `connection` / `emergency` | Локальные работы / Работы на подключение и дозаказы / Аварийные работы |
| `TransportType` | `car` / `walk` / `bike` / `transit` | Автомобиль / Пешеход / Велосипед / Общественный транспорт |
| `Priority` | `normal` / `urgent` | Обычная / Срочная |

A request requires exactly one skill; an engineer has one to three. An engineer has one
transport type; a request may place no transport restriction at all (`required_transport`
is null).

## 5. Provenance and what the dataset does not contain

`data_origin` is stored on every imported entity, and `synthesized` is not a decoration:
the official dataset has no engineer directory, no work durations, no priorities and no
coordinates (`context/18` section 6.3). Deriving them by a documented rule is allowed by
the case statement, but which values were derived has to stay visible.

The importer is the concrete case: crews come from the `Бригада` column, their skills and
transport are derived by a deterministic rule so that all three skills and all four
transports occur, and every engineer it creates carries `origin = synthesized`.

**Coordinates are the load-bearing gap.** `requests.lat` and `requests.lon` are nullable
and `needs_geocoding` defaults to true. Invented coordinates are forbidden
(AGENTS.md section 4.1), so a request without a point is excluded from the published
snapshot and counted in that snapshot's `diagnostics` — visible, not silently dropped.
Geocoding is a separate task of the data zone; the strategy is in `context/06` section 5.

## 6. Working with the schema

```bash
# Change the model, then create a migration (needs a running database):
pnpm --filter api exec prisma migrate dev --create-only --name <change>

# Review and, where needed, hand-edit the generated SQL, then apply it:
pnpm --filter api exec prisma migrate deploy

# Regenerate the client after any schema change:
pnpm --filter api exec prisma generate
```

The generated client is written to `apps/api/src/generated/prisma`, is git-ignored and is
compiled into `dist` together with the rest of the service. In the contour the one-shot
`migrate` compose service runs `prisma migrate deploy` from the same image as the
application, so the code and the schema it expects cannot be two different versions.

Custom SQL that Prisma cannot express — the role grants above — lives inside the
migration, appended after the generated statements. Keep doing that rather than applying
privileges out of band, so a fresh database is correct after `migrate deploy` alone.

## 7. Not implemented yet

| Area | State |
|---|---|
| Importer for `data/dataset/anonymized` | Done, `feat/api-data-import` |
| Engineers, working days, facts | Done, `feat/api-engineers` |
| Three data actions (append, reset to demo, full reset) | Done, `feat/api-data-import` |
| Coordinates for imported requests | The importer reads `data/dataset/geocoded/<region>.json`; Router now ships per-scenario geocodes in `core/scenarios/*/geocodes.json`, which are declared district-centroid projections, not production geocoding. Wiring one to the other is a decision, not a merge (see section 8) |
| Knowledge segments and pgvector | Out of scope of this build; the image supports the extension |
| Retention periods per data class | Required by `context/37` section 6.3; the columns exist (`audit_log.retain_until`), the values are a deployment decision and are not invented here |

## 8. Router data boundary (Router Core side)

### Special-sector input

System Layer is the only writer of business state and publishes one immutable full
`RouterTaskSnapshot`. Router reads the active publication directly with a SELECT-only
role; it does not read live request rows or write to the special sector.

The `router_active_snapshot` view contract is exactly one row:

| Column | Type/meaning |
|---|---|
| `publication_id` | Non-empty immutable publication ID. |
| `publication_seq` | Monotonic non-negative integer; a lower active value is rejected as rollback. |
| `payload_utf8` | Exact UTF-8 JSON text used for calculation and hashing. |
| `payload_sha256` | Lowercase SHA-256 supplied by sys and independently verified by Router. |
| `published_at_epoch` | Non-negative Unix seconds for publication metadata. |

Publication metadata is outside the hashed payload. Router rejects hash mismatches,
invalid UTF-8, duplicate JSON keys, strict-schema violations, more than one active row
and payloads larger than 16 MiB. PostgreSQL reads use a short read-only transaction with
connection and statement timeouts. File input derives equivalent metadata from the
atomic file publication.

### Output

Router publishes `RouterResult` through its own result memory/API. It does not write the
result into `routing_snapshots`. Sys may store an accepted full main+baseline result and
its evidence in Data Layer, linked by `result_id`, `input_publication_id`, `input_hash`
and `router_context_version`.

Sys applies a result only when the exact input hash and active Router context match,
AUTO is active, `main.is_usable` is true and current execution facts do not conflict.

### Import and enrichment ownership

Business CSV/API data ingestion belongs to sys/data-layer: stage the whole batch,
validate schema and encoding, deduplicate external IDs, report conflicts, normalize
addresses, enrich from versioned caches, check completeness, then apply atomically.
Router only validates the resulting snapshot and prepares routing resources. It never
silently invents missing duration, coordinates, skills, transport or availability.

Official benchmark import is a separate, versioned offline acceptance adapter. Its
synthetic engineer profiles, service durations, geocoding quality and travel assumptions
are recorded with the scenario and must not be treated as production business facts.

The acceptance adapter executes these checks before creating a snapshot:

1. verify pinned SHA-256 for both organizer CSV files and both prepared resources;
2. decode the organizer files as CP1251 semicolon CSV and validate required headers;
3. keep numeric request rows, recognize the case-insensitive office footer and reject
   duplicate synthetic request IDs;
4. compare the complete multiset of request time/type/district facts with the control
   distribution (control request IDs are not assumed unique);
5. require complete duration, skill, team, geocode and matrix catalogs;
6. validate the resulting `RouterTaskSnapshot` and `RoadGraph` through the same strict
   models used by the service.

`python -m core.prepare_official` reproducibly rebuilds the South-central acceptance
resources. Those coordinates are declared district-centroid projections and the matrix
is an approximation, not production geocoding or road time. Their byte hashes are pinned
in the scenario config.

Multi-zone acceptance namespaces every request, engineer and graph node by region,
renumbers the two business-order fields contiguously and combines regional graphs as
disconnected components. The Router then performs one ordinary calculation. Absence of
cross-component edges makes cross-zone travel unreachable instead of assigning an
invented large or zero cost.
