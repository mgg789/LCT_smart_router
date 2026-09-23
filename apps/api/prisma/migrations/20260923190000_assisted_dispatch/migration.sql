-- Assisted editing keeps the automatic planner active while the dispatcher pins decisions.
ALTER TYPE "ControlMode" ADD VALUE 'assisted';

ALTER TABLE "control_state"
  ADD COLUMN "dispatcher_constraints" JSONB NOT NULL DEFAULT '{"assignments":[],"orders":[]}',
  ADD COLUMN "constraints_version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "dispatch_plan_proposals" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "actor_id" TEXT,
  "state" TEXT NOT NULL DEFAULT 'prepared',
  "payload_fingerprint" TEXT NOT NULL,
  "review_fingerprint" TEXT NOT NULL,
  "source_mode_version" INTEGER NOT NULL,
  "source_plan_revision" INTEGER NOT NULL,
  "source_constraints_version" INTEGER NOT NULL,
  "source_generation" INTEGER NOT NULL,
  "source_task_fingerprint" TEXT NOT NULL,
  "context_version" TEXT NOT NULL,
  "change" JSONB NOT NULL,
  "constraints" JSONB NOT NULL,
  "candidate" JSONB NOT NULL,
  "input_payload" TEXT NOT NULL,
  "impact" JSONB NOT NULL,
  "requires_confirmation" BOOLEAN NOT NULL,
  "result_key" TEXT,
  "created_at" BIGINT NOT NULL,
  "expires_at" BIGINT NOT NULL,
  "applied_at" BIGINT,
  "applied_plan_revision" INTEGER,
  CONSTRAINT "dispatch_plan_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dispatch_plan_proposals_source_check" CHECK ("source" IN ('dispatcher', 'automatic')),
  CONSTRAINT "dispatch_plan_proposals_state_check" CHECK ("state" IN ('prepared', 'blocked', 'applied', 'cancelled', 'superseded'))
);
CREATE UNIQUE INDEX "dispatch_plan_proposals_result_key_key" ON "dispatch_plan_proposals"("result_key");
CREATE INDEX "dispatch_plan_proposals_source_state_created_at_idx" ON "dispatch_plan_proposals"("source", "state", "created_at");
CREATE INDEX "dispatch_plan_proposals_actor_id_created_at_idx" ON "dispatch_plan_proposals"("actor_id", "created_at");
GRANT SELECT, INSERT, UPDATE, DELETE ON "dispatch_plan_proposals" TO sys_app;
