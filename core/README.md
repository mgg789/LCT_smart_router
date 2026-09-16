# Router Core v2

Autonomous Python implementation of the v14 snapshot contract: geographic resources,
OR-Tools Engine and a single-coordinator Runtime. System Layer is developed separately.
The legacy prototype under `context/legacy_code/core/` remains frozen.

## Quick start

Run from the repository root. Tested on CPython 3.14.3 (Windows x64); dependencies
are pinned in `core/requirements.txt`. Create `core/.venv` only if it does not exist.

```powershell
python -m venv core/.venv
core/.venv/Scripts/python.exe -m pip install -r core/requirements.txt
core/.venv/Scripts/python.exe -m pytest core/tests -q
core/.venv/Scripts/python.exe -m core solve --graph core/examples/graph.json --snapshot core/examples/snapshot.json --output core/result.json
core/.venv/Scripts/python.exe -m core serve --graph core/examples/graph.json --snapshot core/examples/snapshot.json --port 8100
```

On Linux use `core/.venv/bin/python`. The service binds to **127.0.0.1**. Open
`http://127.0.0.1:8100/docs` or read `GET /v1/result`. Run one Uvicorn worker only.
Do not expose this private service directly to end users; sys owns authorization.

The included graph is a **synthetic four-node test network**, not actual Moscow
roads. All four profile costs are explicitly fabricated fixture values. The engine
and providers accept external datasets; no algorithm branches on fixture identities.
Main visits jobs 1 → 2 → 3 (180 travel seconds, 1.8 km), while FIFO baseline visits
3 → 2 → 1 (300 travel seconds, 3.0 km). These are regression figures, not measured
business savings on the organizer dataset.

```powershell
core/.venv/Scripts/python.exe -m core geocode --catalog core/examples/addresses.json "Test office"
core/.venv/Scripts/python.exe -m core project --graph core/examples/graph.json --lat 55.75 --lon 37.6 --limit-m 100
core/.venv/Scripts/python.exe -m core export-map --result core/result.json --output core/routes.geojson
```

`solve` is a one-shot file/DB calculation. `serve` polls the published snapshot,
starts calculations automatically and keeps repeated result reads idempotent.
Publish files using an atomic rename/replace; do not edit the live file in place.

## Official-region acceptance benchmarks

The repository contains a versioned, fully offline preparation of the organizer's
East-region CSV: 66 requests, 12 named teams, accepted coordinates and a cached
OSRM driving matrix. It also contains a South-central acceptance fixture: 56 requests
and 11 named teams. Run the reproducible profiles from the repository root:

```powershell
core/.venv/Scripts/python.exe -m core benchmark --region east --budget-ms 30000 --solution-limit 32 --skip-events --output core/east-golden.json
core/.venv/Scripts/python.exe -m core benchmark --region east --budget-ms 3000 --solution-limit 32 --event-budget-ms 1000 --output core/east-events.json
core/.venv/Scripts/python.exe -m core benchmark --region south_central --budget-ms 12000 --solution-limit 24 --skip-events --output core/south-central-golden.json
core/.venv/Scripts/python.exe -m core benchmark --regions east south_central --budget-ms 8000 --solution-limit 16 --skip-events --output core/multizone.json
```

The first command compares the exact FIFO baseline with Router. Golden results are
44/66 assigned and 3/13 urgent for FIFO versus 65/66 and 12/13 urgent for Router.
Router uses 38,021 travel seconds versus 50,145 for FIFO while serving 21 more jobs.
Request `57299` remains unassigned because its late emergency window conflicts with
available capacity. The golden gate also fixes both serialized plan hashes.

By default the command calculates five independent changes at 15:00 from the same applied plan:
a normal request, an urgent request, one engineer going offline, simultaneous
15-minute technical stops for two engineers, and a 3x traffic multiplier on matrix
edges touching a fixed East-district bounding box. Each event includes the trigger,
search path, before/after assignment deltas, full main/baseline plans and evidence.
Use `--skip-events` for the initial FIFO/Router comparison alone. The 30-second
golden deadline is a safety ceiling: the deterministic 32-solution limit is expected
to stop first on the pinned OR-Tools runtime.

The archive does not provide durations, shifts, transport or an engineer directory.
Each scenario config therefore records every synthetic assumption. Skills
come from work types seen for each control team; transport and shifts are explicit
per team; service durations are fixed per work type. Car time comes from the cached
OSRM matrix. Bike, walk and transit times are declared speed approximations over the
same distance. These figures are benchmark inputs, not measured production facts.

The South-central coordinates are explicitly labelled deterministic district-centroid
projections with address jitter, and its matrix is a haversine acceptance approximation.
They prove import, policy and multi-zone mechanics; they are not rooftop geocodes or
production road ETAs. The combined run is one snapshot and one Engine invocation over
two disconnected graph components. Namespaced IDs prevent collisions, and a missing
cross-zone edge makes cross-zone assignment impossible by construction.

### Explanation data for UI and LLM

`evidence.requests[]` is the calculation-backed source for the “Why this engineer”
panel. It directly supports the four rows in the UI reference:

- skill and required-transport matches;
- planned start, request window and remaining window margin;
- predecessor request, travel seconds and road distance;
- the original machine reason code, basis and fact object from the plan;
- every alternative engineer's skills, transport, availability, assigned load,
  solo feasibility, append-to-current-route feasibility, projected append times,
  incremental travel cost and blocker codes.

The evidence intentionally distinguishes local checks from global search. A separate
LLM may turn these facts into natural language, but it must not infer missing facts,
change assignments or claim global optimality. `solo_feasible` means an empty route
can serve the job; `append_at_route_end_feasible` checks only one explicit order.

## Ownership and modules

| Module | Responsibility |
|---|---|
| `contracts.py` | Strict Pydantic snapshot/result schemas; integer Unix seconds |
| `geo.py` | Versioned directed graph, Dijkstra paths, matrices, coordinate projection, offline gazetteer |
| `geocoding.py` | Explicit Nominatim source, validated candidates, rate limiting and offline cache |
| `osrm.py` | Profile-specific OSRM paths, consistent time/distance/geometry, disk cache |
| `twogis.py` | Cached 2GIS traffic and multimodal matrix preparation outside Engine |
| `policy.py` | Versioned five-policy catalog and candidate comparison |
| `schedule.py` | Fixed-order scheduler, exact FIFO baseline, metrics and result validation |
| `engine.py` | Joint jobs/lunch routing, bounded policy stages and three replanning paths |
| `runtime.py` | Snapshot adapters, process isolation, generations, result/context ownership |
| `api.py` | Private result, health, context and durable technical-settings endpoints |
| `export.py` | GeoJSON paths and stop points for the map frontend |
| `official.py` | Strict organizer CSV import, resource integrity and multi-zone composition |
| `evidence.py` | Detailed per-request and per-candidate facts for UI/LLM explanations |
| `benchmark.py` | FIFO/Router benchmark plus deterministic replanning event harness |

No sys business tables, accounts, request FSM, emails or applied plans are mutated.
Geocoding happens before publication: sys consumes accepted coordinates rather than
asking the solver to guess an address during optimization.

## Geographic resources

### Offline graph

The JSON format is illustrated by `examples/graph.json`. Each edge is **directed**,
has integer metres and per-profile integer seconds. A missing profile means that
profile cannot traverse the edge. Omitted edge geometry means the edge's own straight
segment between its vertices; a detailed source must provide intermediate points.
The exported path concatenates precisely those edges. Labels carry source attribution.

Graph costs include whatever restrictions the producer encoded. Engine costs remain
static for one calculation: it does not import OSM PBF, evaluate traffic by each future
departure or query a public-transport timetable during search. Use a prepared, validated
graph, OSRM or a 2GIS matrix snapshot. Transit is supported only when explicit transit
costs are supplied; it is never replaced by car travel. No external maps or
infrastructure are provisioned by these commands.

Snapshot coordinates must match graph vertices (1 mm float tolerance). `project`
returns a **candidate** nearest vertex and projection distance; accepting it is an
explicit preparation step. Router does not invent access-road connectors or silently
snap through walls. Co-located graph vertices need disambiguation before import.
Unknown coordinates/unreachable directed paths return no quote, never zero travel.

### OSRM and cache preparation

Use `--osrm-config path/to/private-config.json` instead of `--graph`. Example shape:

```json
{
  "map_version": "moscow-extract-YYYY-MM-DD-profile-v1",
  "endpoints": {"car": "http://127.0.0.1:5000"},
  "cache_dir": "core/.cache/osrm",
  "offline": true
}
```

Each endpoint must already be deployed with its declared transport profile. The
OSRM path segment `driving` is the conventional API profile label; it does **not**
change the Lua profile with which that server was built. Never point walk/bike/transit
at a car-only backend and label the result as another mode.

For deliberate cache preparation, use `offline:false` and run the desired snapshot
once; all relevant directed point pairs for the configured engineers are requested.
Then set `offline:true`. A cache miss is a technical error, while OSRM `NoRoute` is
an unreachable path. Provider/network failures are not cached as unreachable roads.
An online cache fill is quadratic and may take much longer than the search budget.
Prefer preparation outside the serving path. Change `map_version` whenever OSRM
resources/profiles change; OSRM does not expose an immutable map fingerprint here.

Time, distance and geometry come from the **same** route response. Seconds/metres
are rounded up. OSRM projection/access semantics apply: no additional access time
from the original coordinate to OSRM's snapped road position is invented.

### 2GIS traffic and multimodal matrix preparation

`prepare-2gis` creates one immutable `RoadGraph` for the coordinates in a strict
Router snapshot. It requests separate 2GIS Distance Matrix profiles for cars,
walking, bicycles and public transport. Car mode supports current traffic (`jam`) or
traffic statistics for `--departure-at` (`statistics`). Public transport includes the
same departure timestamp and can enable timetable consideration. The generated graph
is then consumed by the normal offline `solve --graph ...` or activated atomically by
`RouterRuntime.update_graph()`; Engine never sees the API key or performs HTTP.

Copy `examples/2gis-config.json` to a private operator config, choose a unique
`dataset_version`, set `offline:false`, and provide the key only through the environment:

```powershell
$env:TWOGIS_API_KEY = "<key from 2GIS Platform Manager>"
core/.venv/Scripts/python.exe -m core prepare-2gis --snapshot core/examples/snapshot.json --config path/to/private-2gis.json --departure-at 1786946400 --output core/2gis-graph.json
```

After the cache is filled, remove the environment variable, set `offline:true`, and
repeat the same command. An offline miss fails with `TWOGIS_CACHE_MISS`; authentication,
network, malformed-response and provider-route failures are distinct and are never
cached as unreachable travel. The key is absent from the config identity, cache and
graph. Synchronous requests are split into at most 25 sources and 25 targets.

`jam` means traffic at cache-fill time; use a new `dataset_version` for every deliberate
refresh. `statistics` is reproducible for the specified timestamp. Transit duration is
a schedule-aware snapshot at that timestamp, not a time-dependent timetable inside the
solver. Distance Matrix returns duration and distance only, so these edges currently
render as straight source-to-target lines. Detailed car/transit geometry is a separate
Routing API enrichment step. Matrix billing is per source-target combination; a complete
N-point graph needs N² combinations per requested profile, even when chunked.

The Router `transit` profile represents an engineer travelling on foot plus public
transport; 2GIS includes the pedestrian legs in that route. The `walk` profile is
walking only. Snapshot preparation must therefore label a non-car engineer as `transit`
when public transport is allowed; Router does not switch a `walk` engineer to transit during
optimization.

The official API contract and limits are documented by 2GIS:
[Distance Matrix overview](https://docs.2gis.com/en/api/navigation/distance-matrix/overview),
[`POST /get_dist_matrix`](https://docs.2gis.com/en/api/navigation/distance-matrix/reference/get_dist_matrix),
and [profile examples](https://docs.2gis.com/en/api/navigation/distance-matrix/examples).

### Geocoding

`geocode --catalog` reads an attributed offline candidate array. Alternatively use
`geocode --nominatim-config private-config.json "address"` with this shape:

```json
{
  "endpoint": "http://127.0.0.1:8088",
  "dataset_version": "prepared-geocoder-v1",
  "user_agent": "LCT-Router/1 (operator contact)",
  "cache_dir": "core/.cache/geocoding",
  "offline": true
}
```

An explicit online preparation pass (`offline:false`) caches validated candidates.
No provider is called by default. Ambiguous addresses return multiple candidates;
missing cache entries fail explicitly. Accept a candidate in the preparation/UI
layer before putting it into the snapshot. Provider-specific credentials and usage
policies belong to operator configuration, never to the snapshot or repository.

## Engine behavior

- Hard checks: skill, transport, known release, start-time window, shift/horizon,
  directed reachability and non-overlapping travel/work/wait/lunch intervals.
- Routes are open. The last job's service time still counts before shift end.
- Baseline: `arrival_order` jobs, first feasible `input_order` engineer, append only.
- Policy catalog keeps the same hard constraints and coverage/lunch priorities for
  all presets. `fast` minimizes travel time; `compact` minimizes engineers used;
  `sla` favors earlier starts inside customer windows; `balanced` reduces the maximum
  jobs on one engineer; `eco` minimizes distance. Each then applies documented
  secondary criteria. Unknown IDs and policy parameters fail instead of silently
  falling back or being ignored.
- OR-Tools Routing 9.15 uses domain restrictions for allowed vehicles and a lunch
  alternative at the engineer's start or directly after a compatible job. Required
  lunch is mandatory; lunch already taken cannot be scheduled again.
- The policy compiler runs bounded lexicographic stages. Later stages cannot worsen
  values already fixed by earlier stages. This preserves urgent and total coverage
  while allowing the selected business value to decide among equally covered plans.
- `REVALIDATE` reschedules unchanged assignments/order only within the stable
  reference's tolerance. `REPAIR_AND_IMPROVE` projects previous business IDs and
  uses a feasible seed. Context changes or no usable seed choose `COLD_START`.
- A ready plan can contain unassigned jobs. No feasible required-lunch candidate
  yields `is_usable:false`, empty executable routes and an explicit conflict alert.
- Reasons distinguish proven static rejection from a bounded search finding no
  assignment. Neither `ready` nor an unassigned outcome proves global optimality.

`--budget-ms` controls the search budget (default 3000), not validation, graph
preparation or HTTP calls. Each stage also has a solution limit; repeatability is
tested on the pinned Windows runtime and fixture. Cross-platform deterministic
quality under wall-time exhaustion is not asserted. Larger datasets need profiling.

## Sys and data-layer integration contract

The external schemas follow `context/33-router_contract_v2.md`. Checked JSON Schema
files live in `core/schemas/`; regenerate them with `python -m core.schema`. The private
service also exposes request and response schemas in `/openapi.json`.

| Interface | Meaning |
|---|---|
| Snapshot payload | Exact UTF-8 JSON document, `schema_version:"1.0"`, duplicate keys rejected |
| `input_hash` | Lowercase SHA-256 hex of those **exact bytes**, including whitespace; no independent reserialization |
| PostgreSQL input | Sys-owned `router_active_snapshot` view with one publication row; see `docs/data.md` |
| `GET /health` | Coordinator state; liveness is not proof of a usable plan |
| `GET /v1/context` | Active context version and complete technical settings, separate from the last result |
| `GET /v1/result` | Atomic `RouterResult`: state, plans, evidence, policy and exact input identity |
| `PUT /v2/config/technical-settings` | CAS update for lunch switch and both lateness tolerances |
| `PUT /v1/config/tolerance` | Compatibility alias for departure tolerance |

DB usage: omit `--snapshot`, set `ROUTER_DATABASE_URL` in the process environment.
The view returns `publication_id`, monotonic `publication_seq`, `payload_utf8`,
`payload_sha256` and `published_at_epoch`. The reader issues one SELECT in a read-only
transaction; sys owns publication, view/migrations and a SELECT-only role. Router
rejects multiple rows, rollback, payloads above 16 MiB and a SHA mismatch.
`payload_utf8` preserves published text; do not reconstruct it from JSONB.
No PostgreSQL database or role is created by Router.

Context identity includes resource contents/version, the derived policy-catalog version
and search settings. A new context invalidates the current result immediately.
Map activation is currently a process restart or internal `update_graph()` call;
there is no public graph-upload or arbitrary solve endpoint.

The Router-owned technical revision contains `lunches_enabled`,
`departure_lateness_tolerance_sec` and `task_start_lateness_tolerance_sec`. The lunch
switch is a hard override and suppresses every optional or required lunch without
mutating sys input. Tolerances only choose revalidation versus repair; they never widen
customer windows, engineer shifts or the planning horizon. Accepted settings are saved
atomically in `.router/settings.json` by the default service command and restored on restart.
An embedded Runtime without a durable store may calculate, but rejects settings writes
instead of acknowledging a process-only change.

Only one job runs; input/context changes replace one waiting job. Finished stale
generations are discarded, not retagged. Cancellation is cooperative at the job
boundary: a current bounded search is allowed to finish. The result store, previous
plan and operation-id cache are process-local. Restart restores durable technical
settings, recomputes the active snapshot and produces a new result ID. Sys must
reread context and preserve its own applied-plan/execution history across restarts.

Sys applies a result only in AUTO, with matching hash/context, `ready`, usable main
and no conflict with facts. MANUAL disables consumption; Router keeps calculating.
These checks are sys responsibilities, not implemented by this module.

A calculation error is retained until the snapshot or context changes (or Runtime
restarts); Router does not retry unchanged failed jobs on a timer. Read failures are
polled again automatically. Refill an OSRM cache before starting the offline service.

## Verification and remaining integration

```powershell
core/.venv/Scripts/python.exe -m pytest core/tests -q
core/.venv/Scripts/python.exe -m ruff check core
core/.venv/Scripts/python.exe -m ruff format --check core
```

The suite covers hard constraints, policy precedence, lunches, graph direction,
transport profiles, provider cache contracts, exact hashing, invalid output,
stable revalidation, stale generations and actual process isolation through the
private API. Provider HTTP tests use controlled responses; they do not establish
that a real OSRM/Nominatim deployment or PostgreSQL view already exists.

Remaining integration: sys view/permissions and acceptance transaction; replacement
of the South-central acceptance projection with accepted geocodes and road/provider
ETAs; preparation of the Southeast official region; full application UI/SSE smoke.
The standalone Router tests cannot substitute for the monorepo smoke gate while the
repository root has no pnpm importer manifest.

Implementation references: [OR-Tools VRPTW](https://developers.google.com/optimization/routing/vrptw),
[OR-Tools v9.15](https://github.com/google/or-tools/releases/tag/v9.15),
[OSRM API](https://project-osrm.org/docs/v5.24.0/api/),
[Nominatim search](https://nominatim.org/release-docs/latest/api/Search/).
