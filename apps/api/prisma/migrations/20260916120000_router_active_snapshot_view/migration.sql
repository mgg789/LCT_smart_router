-- The read contract Router Core executes against the published sector.
--
-- Router V2 (D-22) reads the active publication itself, with a SELECT-only role, in a
-- short read-only transaction, and issues exactly this query (core/runtime.py,
-- PostgresSnapshotSource):
--
--   SELECT publication_id, publication_seq, payload_utf8, payload_sha256,
--          published_at_epoch FROM router_active_snapshot
--
-- It then fetches two rows and fails unless exactly one came back. The view is therefore
-- a projection of the singleton pointer, not of the snapshot history: publishing swaps
-- the pointer, so the "active row" is always one or none, never two.
--
-- The column names belong to Router's contract (docs/data.md section 8) and the internal
-- names belong to this schema. Mapping them here, in a view, is what lets either side be
-- renamed without breaking the other.
CREATE OR REPLACE VIEW "router_active_snapshot" AS
SELECT
  -- Immutable identity of this publication.
  s."id"              AS "publication_id",
  -- Monotonic and non-negative: the pointer version increases by one on every swap, so a
  -- lower value than the one Router already saw really is a rollback.
  c."pointer_version" AS "publication_seq",
  -- Exact bytes that were hashed. Text, not jsonb, for that reason.
  s."payload"         AS "payload_utf8",
  s."input_hash"      AS "payload_sha256",
  -- Publication metadata, outside the hashed payload.
  s."created_at"      AS "published_at_epoch"
FROM "routing_current" c
JOIN "routing_snapshots" s ON s."id" = c."snapshot_id";

COMMENT ON VIEW "router_active_snapshot" IS
  'Router Core read contract: the one active publication. See docs/data.md section 8.';

GRANT SELECT ON "router_active_snapshot" TO router_readonly;
