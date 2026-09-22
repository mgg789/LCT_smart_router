-- Arrival/completion are once per request and category; manual penalties are once
-- per linked fact, so a second documented violation on one request remains billable.
ALTER TABLE "engineer_rewards" ADD COLUMN IF NOT EXISTS "dedup_key" TEXT;

UPDATE "engineer_rewards"
SET "dedup_key" = CASE
  WHEN "category" IN ('arrival', 'completion') AND "request_id" IS NOT NULL
    THEN "request_id" || ':' || "category"::text
  WHEN "category" = 'penalty' AND "request_id" IS NOT NULL AND ("evidence" ? 'factId')
    THEN "request_id" || ':penalty:' || ("evidence" ->> 'factId')
  ELSE "category"::text || ':' || "operation_id"
END;

ALTER TABLE "engineer_rewards" ALTER COLUMN "dedup_key" SET NOT NULL;
DROP INDEX IF EXISTS "engineer_rewards_request_id_category_key";
CREATE UNIQUE INDEX IF NOT EXISTS "engineer_rewards_dedup_key_key" ON "engineer_rewards"("dedup_key");
