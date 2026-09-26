ALTER TYPE "StopKind" ADD VALUE 'handoff';
ALTER TABLE "applied_plan_stops" ADD COLUMN "handoff" JSONB;
CREATE TABLE "equipment_handoffs" (
  "id" TEXT PRIMARY KEY, "work_date" TEXT NOT NULL,
  "donor_engineer_id" TEXT NOT NULL, "receiver_engineer_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL, "items" JSONB NOT NULL,
  "lat" DOUBLE PRECISION NOT NULL, "lon" DOUBLE PRECISION NOT NULL,
  "meeting_at" BIGINT NOT NULL, "donor_confirmed_at" BIGINT,
  "receiver_confirmed_at" BIGINT, "completed_at" BIGINT, "created_at" BIGINT NOT NULL
);
CREATE INDEX "equipment_handoffs_work_date_completed_at_idx" ON "equipment_handoffs"("work_date", "completed_at");
