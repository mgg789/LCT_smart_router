# Router data boundary

## Special-sector input

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

## Output

Router publishes `RouterResult` through its own result memory/API. It does not write the
result into `routing_snapshots`. Sys may store an accepted full main+baseline result and
its evidence in Data Layer, linked by `result_id`, `input_publication_id`, `input_hash`
and `router_context_version`.

Sys applies a result only when the exact input hash and active Router context match,
AUTO is active, `main.is_usable` is true and current execution facts do not conflict.

## Import and enrichment ownership

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
