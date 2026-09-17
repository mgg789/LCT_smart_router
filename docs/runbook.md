# Runbook — running, testing and troubleshooting

> Updated in the same commit as the code it describes (AGENTS.md section 8.2).
> Architecture: [architecture.md](./architecture.md).

## 1. Prerequisites

| Tool | Version used here | Note |
|---|---|---|
| Node.js | 24.13.0 (host), 24.21.0 (container) | LTS branch, per `context/43` section 4 |
| pnpm | 10.28.2 | Package manager of the workspace (D-23) |
| Docker Engine | 28.5.1 | |
| Docker Compose | v2.40.2 | The `docker compose` plugin, not the legacy v1 binary |

**Version deviation, recorded honestly.** `context/43` section 1 lists Node 24.21.0,
npm 11.19.1, PostgreSQL 18.6, Docker Engine 29.8.1 and Compose 5.5.1. Several of those
are not obtainable on the current development machine. The contour therefore pins what
actually installs: the versions above, `pgvector/pgvector:pg17` for the database, and the
exact dependency versions in `pnpm-lock.yaml`. `context/43` carries a status block naming
this and the other D-23 deviations; nothing was changed there silently.

## 2. First run

```bash
git checkout dev && git pull
cp .env.example .env          # required: dispatcher credentials have no defaults
pnpm install
pnpm compose:up               # docker compose -f infra/docker-compose.yml up -d --build
```

Then:

```bash
pnpm compose:ps               # postgres, router, api and web healthy
curl localhost:8000/health/live
curl localhost:8000/health/services
```

Dispatcher dashboard: <http://127.0.0.1:5173> (nginx in the `web` service, `/api` to `api`).
Interactive API documentation: <http://localhost:8000/docs>.
Machine-readable schema: <http://localhost:8000/docs/openapi.json>.

`health/services` reports the real state of each integration. `router` pings Router
Core, which the contour starts as its own service (port 8100, reads the published
snapshot with the read-only DB role); `ai` and `smtp` report `not_configured` because
they are not wired. The application is designed to run fully without them.

## 3. Everyday commands

| Command | What it does |
|---|---|
| `pnpm compose:up` | Build and start the contour in the background |
| `pnpm compose:logs` | Follow container logs |
| `pnpm compose:down` | Stop the contour, keep the data volume |
| `pnpm --filter api build` | Compile the service with `tsc` |
| `pnpm --filter api test` | Compile `src` + `test` and run them serially under `node:test` |
| `pnpm --filter api typecheck` | Types only, no output |
| `pnpm lint` / `pnpm format` | Biome check / write |

Running the service outside Docker, against the compose database:

```bash
pnpm --filter api build
node apps/api/dist/src/main.js
```

Router-related environment (all optional; see `.env.example`): `ROUTER_BASE_URL`
(where the gateway finds Router Core; compose sets `http://router:8100`),
`ROUTER_BUDGET_MS` (solver budget passed to the core service, default 8000),
`ROUTER_POLL_INTERVAL_MS` (execution-overrun coordinator period, default 500),
`ROUTER_REQUEST_TIMEOUT_MS` (gateway HTTP timeout, default 3000).

Router Core has its own CLI (`solve`, `serve`, `benchmark`, `geocode`, `project`,
`export-map`, `prepare-2gis`, `schema`) and offline resources — quick start and
acceptance benchmarks: [core/README.md](../core/README.md). The contour's `router`
service runs `serve --official-regions east southeast south_central` with its durable
technical settings in the `router-state` volume.

## 4. Loading the dataset

The contour starts empty. To load one, several or all regions of the organisers' data:

```bash
TOKEN=$(curl -s -X POST localhost:8000/api/v1/auth/dispatcher/password   -H 'content-type: application/json'   -d '{"email":"dispatcher@example.test","password":"<the one in .env>"}' | jq -r .token)

# one region
curl -s -X POST localhost:8000/api/v1/dispatch/data/import   -H "authorization: Bearer $TOKEN" -H 'content-type: application/json'   -d '{"operationId":"'$(uuidgen)'","region":"east"}'

# everything (205 requests, 35 engineers across east + southeast + south_central)
curl -s -X POST localhost:8000/api/v1/dispatch/data/import   -H "authorization: Bearer $TOKEN" -H 'content-type: application/json'   -d '{"operationId":"'$(uuidgen)'","regions":"all"}'
```

Regions: `east`, `southeast`, `south_central` (`regions` also accepts an explicit list).
An optional `engineerCountPerRegion` object caps crews per region (a cap above the
dataset's crew count is a 422). The import is atomic across all requested regions.

**The geocode sidecar is required.** `data/dataset/geocoded/<region>.json` must exist and
cover every request address plus the depot; the files are mounted read-only into the
container, so an updated package needs no rebuild. Imported requests get real points
(declared district-centroid projections with recorded provenance), and benchmark windows
are rebased onto the live horizon so a dataset dated 17.08 plans against "now".
`GET /api/v1/dispatch/debug/snapshot` shows the published task and its diagnostics.

## 5. Data and restarts

`docker compose down` keeps the named volume `postgres-data`, so an ordinary restart
preserves business data, the working plan, the control mode and lunch facts
(`context/43` section 11.3).

`docker compose down -v` destroys that volume. **It is not the application's "full
reset".** The product-level reset is a confirmed dispatcher action with its own defined
scope and post-conditions (`context/37` section 9.4); deleting the volume merely removes
the database and tells nobody.

## 6. Troubleshooting

**`api` container restarts immediately.** The environment failed validation. The first
log line names every offending key. Check `.env` against `.env.example`.

**`Cannot find module .../typescript/bin/tsc` during the image build.** The host
`node_modules` reached the build context. `.dockerignore` excludes it; verify it was not
removed — pnpm's `node_modules` is a symlink tree into the local store and is useless
inside a container.

**`pnpm install --frozen-lockfile` fails in the image.** `package.json` and
`pnpm-lock.yaml` disagree. Run `pnpm install` on the host and commit the updated
lockfile; do not relax the flag, its whole purpose is to fail on drift.

**Port already in use.** Override `API_PORT` or `POSTGRES_PORT` in `.env`. Postgres is
published on `127.0.0.1` only.

**Health endpoints answer but a feature does not exist.** Check the table in
[architecture.md](./architecture.md) section 2 — several blocks are planned and not yet
implemented, and section 5 lists the contracts that are still missing.

## 7. Why the tests run serially

`--test-concurrency=1` is deliberate. The System Layer has genuinely global singletons --
the AUTO/MANUAL row and the pointer to the published snapshot -- and they are the subject
of several tests. Running test files in parallel against one database makes each file
observe the others' publications, so a suite that is correct in isolation fails at random.
Separate databases per file would allow parallelism; until that is worth the setup, serial
execution is the honest option rather than weakening the assertions.

A related trap when writing tests here: every timestamp is a whole second, so "the most
recent row" is ambiguous whenever two rows are written in the same second. Identify a row
by its own id or by a value that is unique to it, never by `orderBy: { createdAt: 'desc' }`.
Two intermittent failures came from exactly that.

## 8. Smoke gate

```bash
pnpm compose:up
pnpm smoke
```

`pnpm smoke` (AGENTS.md section 11.1) drives the whole spine over HTTP against the
**running contour**, not in process: it proves the artifact that actually ships works —
migrations applied, configuration read, dataset mounted, every contour reachable.

It checks, in order: the contour answers and reports its missing integrations honestly; the
dispatcher signs in without SMTP; the application data resets; the official dataset imports
with geocode coverage and no errors; an engineer with a shift and an urgent request
classified from its type of work; the task republished with both in it; a read publishing
nothing and leaving `planning_as_of` alone; a valid Router result becoming the working plan;
the same result refused as `ALREADY_APPLIED`; a stale one refused as `SNAPSHOT_STALE`; and
the dispatcher seeing the applied plan with its mode.

**It is destructive**: it resets the application data first, so it belongs on a development
or demo contour and nowhere else. `SMOKE_BASE_URL` points it elsewhere than
`http://localhost:8000`.
