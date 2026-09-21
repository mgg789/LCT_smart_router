ALTER TABLE "live_engineer_states"
  ADD COLUMN "route_origin_lat" DOUBLE PRECISION,
  ADD COLUMN "route_origin_lon" DOUBLE PRECISION,
  ADD COLUMN "route_origin_at" BIGINT,
  ADD COLUMN "active_lunch_started_at" BIGINT;

-- Imported and synthesized roster rows use the product default. Explicit dispatcher
-- workday settings are intentionally not rewritten by this migration.
UPDATE "engineer_days"
SET
  "lunch_duration_sec" = 1800,
  "updated_at" = EXTRACT(EPOCH FROM NOW())::bigint,
  "version" = "engineer_days"."version" + 1
FROM "engineers"
WHERE "engineers"."id" = "engineer_days"."engineer_id"
  AND "engineers"."origin" IN ('import', 'synthesized')
  AND "engineer_days"."lunch_enabled" = TRUE
  AND "engineer_days"."lunch_duration_sec" = 2700;
