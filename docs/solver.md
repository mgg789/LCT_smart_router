# Solver — computation core

## Current Router V2 (2026-09-17)

The new implementation lives in root `core/` by the owner's instruction (D-22).
It follows the v14 `RouterTaskSnapshot` / `RouterResult` contract rather than the
legacy contract below. Runtime, Engine and geographic preparation belong to this
module; System Layer is integrated through the ROUTER-gateway HTTP client
(`docs/api.md` section 10).

- Strict Unix-second inputs and result validation; exact FIFO baseline.
- OR-Tools joint job/lunch model, open routes and five versioned policy presets:
  `fast`, `compact`, `sla`, `balanced` and `eco`. Hard constraints are shared;
  their resource/SLA-risk ordering is compiled from the catalog. The default
  policy is `compact` since the QA decisions (`context/50`) — scenario snapshots
  and goldens are built on it.
- Directed transport graph, path/matrix cache, OSRM adapter, address candidates and GeoJSON.
- Optional 2GIS preparation adapter for current/statistical car traffic and separate
  walk, bike and schedule-aware public-transport matrix profiles; live HTTP stays
  outside Engine and every response is available through a versioned offline cache.
- Autonomous process-isolated Runtime with exact publication integrity checks, durable
  Router technical settings **with durable idempotency receipts** (accepted operations
  survive a restart in the same atomic document), file/PostgreSQL adapters and a
  private API.
- Eight-field technical revision (D-22 implementation of `context/50`):
  `lunches_enabled` (default **false**), the two revalidation tolerances,
  `travel_time_mode` (`graph_with_access_buffer` adds `access_buffer_sec` to graph
  durations; `fixed_normative` prices every non-zero leg at `fixed_travel_time_sec`),
  `early_finish_replan_threshold_sec` and `task_overrun_tolerance_sec`. The
  `TechnicalTravel` wrapper (core/geo.py `configure_travel`) applies the timing policy
  on every calculation path and derives its version from `base graph version + timing
  configuration`. The last two thresholds are also read by sys to classify execution
  variance.
- `position_observed_at` removed from `Engineer` and the snapshot schema: sys anchors
  the remaining route at the active task's location with `available_from`; there is
  no telemetry input.
- Official acceptance: East baseline 36/66 (urgent 2/13) vs Router 64/66 (12/13);
  South-central baseline 33/56 (2/16) vs Router 51/56 (16/16) under the pinned
  golden profiles (compact, aligned work-norm durations). Southeast is a third
  complete scenario (`core/scenarios/southeast-v1`: 83 requests, 12 engineers,
  31 urgent, includes out-of-MKAD Kashira/Stupino) solvable under the same rules.
- All three regions run as one 205-request, 35-engineer snapshot with disconnected
  graph components (East + South-central 122/23 is also pinned). The acceptance test
  proves that no cross-zone assignment is produced. `python -m core.prepare_official
  --region <name>` regenerates either centroid fixture with source-hash verification.
- Structured explanation evidence is part of every ready result for the UI and an
  explanation-only LLM: selected engineer facts, predecessor travel, window margin and
  all candidate blockers.
- Five live-event acceptance scenarios: normal/urgent request, engineer offline,
  two simultaneous 15-minute stops and a geographic 3x traffic multiplier.
- Tests for hard constraints, stable replanning, event recovery, golden output hashes,
  obsolete generations and provider boundaries.

See [core/README.md](../core/README.md), [api.md](./api.md) and [data.md](./data.md)
for setup, API/view/hash contracts, geographic
resource formats and explicit V2 limits. The official East scenario uses versioned
synthetic operating assumptions plus cached Nominatim/OSRM preparation; it does not
claim live traffic or production map deployment. South-central and Southeast use
declared district-centroid projections and an approximate matrix until accepted
provider data is prepared. `prepare-2gis` is separately covered
by controlled provider tests; no real account/key acceptance run has been performed.
The sys database view is exercised by integration tests; the frontend contour is
being built in parallel on `feat/web-dashboard-dev`. The previous prototype files
are unchanged.

## Historical day-0 prototype

> Status: **legacy, frozen 2026-09-15** — the day-0 prototype moved from
> `core/` (repo root) to `context/legacy_code/core/` (backup, D-19 in
> `context/29`); paths below are historical. Target home stays `apps/solver`
> (D-18) when the monorepo skeleton lands, contracts unchanged.
> Docs live here per AGENTS.md §8.

## What it does

Static daily plan: `SolverInput` JSON → `PlanSolution` JSON (both defined in
`context/14` §3) on Google OR-Tools Routing (GLS). Covers case items 1–3 and
5 of the Beeline Business ТЗ (qualification/availability distribution, time
windows, transport+equipment verification, travel/SLA objective, structured
reasons). Re-planning (case item 4), lunch breaks and the balance objective
in the cost function are **not** in the prototype yet — see "Next steps".

## Module layout (AGENTS.md §9.2)

| Module | Responsibility |
|---|---|
| `core/types.py` | JSON contract layer: `SolverInput` / `PlanSolution` dataclasses, "HH:MM" ↔ minutes parsing |
| `core/matrix.py` | travel-time matrix backend: offline haversine × road factor × hour coefficient (D-7); OSRM cache is a future drop-in (D-5 unchanged) |
| `core/model.py` | compatibility prefilter + OR-Tools routing model + route extraction |
| `core/reasons.py` | rule-based explanation factors (D-3, context/11 §3) |
| `core/metrics.py` | plan metrics object (context/14 §4 subset) |
| `core/gen.py` | seeded dataset generator: `mini` (5×10, feasible) and `full` (10×80 per context/14 §5.1) |
| `core/solve.py` | `solve_task()` composition + CLI |
| `core/studio.py` + `core/studio.html` | local interactive playground: map UI to add/cancel requests and watch replans (dev tool, not the product API) |

## Replanning (warm start, D-4)

`solve_task(..., previous_plan=plan)` re-plans the day: the previous plan's
routes seed the search via `ReadAssignmentFromRoutes` (new requests start
inactive and are inserted around the preserved routes), and the metrics gain
`moves_vs_prev`:

- `reassigned` — the engineer changed for a request present in both plans;
- `shifted` — same engineer, eta drifted ≥ 5 min (`SHIFTED_ETA_MIN`).

`SolveOutput.warm_started` reports whether the seed was accepted; an
infeasible seed (e.g. a request became unservable) silently falls back to a
cold start. Gotcha: `ReadAssignmentFromRoutes` speaks in **internal manager
indices**, not node numbers — the multi-depot manager shifts regular nodes
down (`NodeToIndex` must be applied).

**Not in yet** (documented next steps): the explicit stability penalty
(`w_stab × moved + shifted`) and `fix` pinning — warm start alone keeps the
plan recognizable but GLS still wanders within the budget.

## Studio (local testing)

```bash
python -m core.studio --scenario full --seed 42 --port 8017
# → http://127.0.0.1:8017
```

Single-page UI (MapLibre GL — the product engine per D-16 — with keyless
OSM raster tiles): click the map to drop a new
work order (work type, window, strict/VIP), cancel requests, what-if weight
presets, day reset. Every mutation warm-starts the solver and the UI shows
the diff chips, the Gantt timeline (wait hatched), engineer workload bars
and the structured reasons panel per request. Tiles need internet; this is a
dev tool — the product API is `apps/api` (context/09 §3).

## Model

**Nodes/vehicles.** Each engineer is one vehicle with a private start and end
depot ("engineer from home" = own depot, never shared). Request nodes are
added in id-sorted order — determinism starts at node construction.

**Time dimension.** Integer seconds inside the model (AGENTS.md §9.2), local
city time, no timezone objects anywhere. Transit = travel + service at the
origin node; slack = waiting, capped at 240 min (the context/27 §3 snippet's
60 min would make requests with longer waits unassignable).

**Windows.** Service must *start* inside the window; `done_by = eta + service`
may run past the window close. Lower bound is always hard. Upper bound:
hard for `window_strict` or `priority == "vip"`, otherwise soft with a
per-minute penalty of `weights.sla` (linear; the context/04 §4 formula is
quadratic — accepted simplification, listed below).

**Shifts.** Departure fixed at `shift[0]`, return to end depot no later than
`shift[1]` (end-node cumul upper bound).

**Compatibility.** `prefilter()` assigns each request its candidate engineer
list: skills ⊇ required, equipment counts covered, vehicle class allowed
(`any` wildcard), window intersecting the shift. Candidates become
`VehicleVar.SetValues([vehicles…] + [-1])` — the 9.15 SWIG wrapper rejects
Python sequences in `SetAllowedVehiclesForIndex`, and `-1` preserves the
drop option. The same candidate lists feed the reasons layer.

**Objective (D-2 lexicographic via weights, context/04 §4).**

| Term | Penalty | Mechanism |
|---|---|---|
| unassigned request | 1 000 000 | disjunction penalty; **0** when nobody can ever serve it (free drop, no phantom cost) |
| late service start | `weights.sla` / minute | soft upper bound on the time cumul |
| travel | 1 / minute | arc cost (seconds), `weights.travel` implied |

The `balance` weight is not applied in the cost yet (balance is measured in
metrics only); overload and quadratic lateness shaping are next steps.

**Search.** `PARALLEL_CHEAPEST_INSERTION` + `GUIDED_LOCAL_SEARCH`, default
budget 1500 ms wall clock (context/07 §5). `solution_limit` gives a
deterministic stop for golden runs. Empirically plans repeat run-to-run even
under the pure time limit, but only `solution_limit` is *guaranteed* — demos
and tests must pin it.

## Reasons (context/11 §3, D-3)

Per request, structured JSON — never LLM, never hand-written:

- `assignment.factors` in importance order: `skill_match`, `equipment_ok`,
  `sla_margin`, `window_tight`, `travel_delta`, `load_balance` — each
  `{code, ok, value, detail}`;
- `assignment.alternatives` (up to 2): feasible engineers with travel-only
  insertion `cost_delta`, or blocked ones with `why_not` codes
  (`skill_missing` / `equipment_missing` / `vehicle_class` / `shift_window`);
- `sequence`: adjacent-swap deltas for the visit (travel-only);
- `unassigned.why`: `no_candidate: <label>` when prefilter found nobody,
  `window_conflict: …` when candidates exist but insertion failed.

Simplification: alternative/swap deltas ignore knock-on window effects.

## Metrics (context/14 §4 subset)

`requests_total, assigned, unassigned, sla_ok_pct, sla_at_risk,
late_total_min, travel_min_total, travel_min_mean_per_eng, workload_min,
balance_std_min, makespan_min, wait_min_total`.

Definitions that matter: **unassigned counts against `sla_ok_pct`** (an
unserved request is not OK); `travel_min_total` includes return legs to end
depots; `workload_min` is the occupied span (travel + wait + service);
`balance_std_min` is the population std-dev over all engineers, idle
included.

## Matrix caveats

Haversine × 1.35 road factor ÷ 28 km/h, times one traffic coefficient for
the whole matrix at the earliest shift-start hour (a pre-solve matrix cannot
depend on solver decisions). Absolute minutes are a proxy: fine for fitting
the model, swap to the OSRM cache backend (D-5) before trusting ETAs.

## Golden gate

`core/tests/golden/` holds the seed-42 mini input + reference plan.
`test_golden.py` fails on: run-to-run drift, plan ≠ snapshot, or
assigned < 10 / sla_ok_pct < 100. A PR that shifts the golden plan must
regenerate the snapshot and explain the delta in the commit body
(context/27 §10, determinism is sacred).

## Run

```bash
python -m venv core/.venv
core/.venv/Scripts/python -m pip install -r core/requirements.txt   # Windows
core/.venv/Scripts/python -m core.gen --scenario full --seed 42 --out data/full.json
core/.venv/Scripts/python -m core.solve --input data/full.json --output data/solution.json
core/.venv/Scripts/python -m pytest core/tests -q
```

Both CLIs must run from the repository root (so `core.types` does not shadow
the stdlib `types`); their `--out`/`--output` paths are confined to the
current working directory by `core.cli.resolve_output_path` and rejected with
exit code 2 otherwise.

## Reference numbers (2026-09-13, this machine)

- mini (5×10): 10/10 assigned, sla 100%, travel 642 min, ~180 ms;
- full (10×80): 71/80 assigned, sla 88.8%, late 0 min, 1.5 s budget; the 9
  unassigned are genuine capacity scarcity (3× CCTV against one qualifying
  engineer, splice-pair overload, afternoon fiber demand) — demo material
  for the reasons panel, not search failures.

## Next steps (in order)

1. Stability penalty (`w_stab`) + `fix` pinning on top of the warm start (D-4);
2. balance term in the objective (overload / imbalance penalties);
3. quadratic lateness shaping; lunch breaks via `SetBreakIntervalsOfVehicle`
   (context/21 §2, context/25 #8);
4. OSRM matrix backend + cache (D-5), per-arc departure-hour coefficients;
5. FastAPI wrapper on port 8100 (context/27 §1), then the move to
   `apps/solver`.
