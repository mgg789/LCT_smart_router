ALTER TABLE "live_request_states"
  ADD COLUMN "replan_pending_engineer_id" TEXT,
  ADD COLUMN "replan_pending_plan_revision" INTEGER,
  ADD COLUMN "replan_requested_at" BIGINT;
