-- Dispatcher alert lifecycle: deduplication, resolution audit, day closure guard and
-- explicit attendance monitoring. Existing Router rows remain valid alerts.
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'engineer_attention_required';
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'plan_rebuilt';

ALTER TABLE "engineer_days"
  ADD COLUMN "attendance_opt_out" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "last_attendance_at" BIGINT,
  ADD COLUMN "attendance_grace_until" BIGINT;

ALTER TABLE "alerts"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'alert',
  ADD COLUMN "dedup_key" TEXT,
  ADD COLUMN "work_date" TEXT,
  ADD COLUMN "is_blocking" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "invalidated_at" BIGINT,
  ADD COLUMN "resolution_action" TEXT,
  ADD COLUMN "resolution_reason" TEXT,
  ADD COLUMN "resolution_delay_sec" INTEGER;

CREATE UNIQUE INDEX "alerts_dedup_key_key" ON "alerts"("dedup_key") WHERE "dedup_key" IS NOT NULL;
CREATE INDEX "alerts_work_date_resolved_at_invalidated_at_idx"
  ON "alerts"("work_date", "resolved_at", "invalidated_at");

CREATE TABLE "shift_closures" (
  "work_date" TEXT NOT NULL,
  "closed_at" BIGINT NOT NULL,
  "closed_by" TEXT,
  "operation_id" TEXT NOT NULL,
  CONSTRAINT "shift_closures_pkey" PRIMARY KEY ("work_date"),
  CONSTRAINT "shift_closures_operation_id_key" UNIQUE ("operation_id")
);
