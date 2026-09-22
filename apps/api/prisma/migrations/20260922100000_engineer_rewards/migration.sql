-- Unified engineer rewards ledger. Existing passport points remain auditable and are
-- copied into the new ledger before new reward writes are enabled.
CREATE TYPE "EngineerRewardCategory" AS ENUM ('arrival', 'completion', 'passport', 'penalty');

ALTER TABLE "live_request_states"
  ADD COLUMN "reported_eta_recorded_at" BIGINT,
  ADD COLUMN "reported_eta_baseline_at" BIGINT,
  ADD COLUMN "promised_finish_at" BIGINT,
  ADD COLUMN "promised_finish_recorded_at" BIGINT,
  ADD COLUMN "promised_finish_baseline_at" BIGINT;

CREATE TABLE "engineer_rewards" (
  "id" TEXT NOT NULL,
  "engineer_id" TEXT NOT NULL,
  "request_id" TEXT,
  "workday_id" TEXT,
  "category" "EngineerRewardCategory" NOT NULL,
  "points" INTEGER NOT NULL,
  "operation_id" TEXT NOT NULL,
  "dedup_key" TEXT NOT NULL,
  "awarded_at" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  CONSTRAINT "engineer_rewards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "engineer_rewards_operation_id_key" ON "engineer_rewards"("operation_id");
CREATE UNIQUE INDEX "engineer_rewards_dedup_key_key" ON "engineer_rewards"("dedup_key");
CREATE INDEX "engineer_rewards_engineer_id_awarded_at_idx" ON "engineer_rewards"("engineer_id", "awarded_at");
CREATE INDEX "engineer_rewards_workday_id_idx" ON "engineer_rewards"("workday_id");

INSERT INTO "engineer_rewards" (
  "id", "engineer_id", "category", "points", "operation_id", "dedup_key", "awarded_at", "reason", "evidence"
)
SELECT
  md5('legacy-passport:' || "operation_id"),
  "engineer_id",
  'passport'::"EngineerRewardCategory",
  "points",
  'legacy-passport:' || "operation_id",
  'passport:legacy-passport:' || "operation_id",
  "awarded_at",
  'Legacy object passport reward migrated to the unified ledger',
  jsonb_build_object('legacy', true, 'source', 'engineer_passport_points', 'operationId', "operation_id")
FROM "engineer_passport_points";

ALTER TABLE "engineer_rewards"
  ADD CONSTRAINT "engineer_rewards_engineer_id_fkey"
  FOREIGN KEY ("engineer_id") REFERENCES "engineers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engineer_rewards"
  ADD CONSTRAINT "engineer_rewards_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
