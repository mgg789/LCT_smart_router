ALTER TYPE "StopKind" ADD VALUE 'delivery';
ALTER TYPE "StopKind" ADD VALUE 'office_pickup';
ALTER TABLE "applied_plan_stops" ADD COLUMN "logistics" JSONB;

CREATE TYPE "EquipmentLogisticsKind" AS ENUM ('donor_delivery', 'office_pickup');
CREATE TYPE "EquipmentLogisticsStatus" AS ENUM ('searching', 'assigned', 'none', 'completed', 'cancelled', 'error');
CREATE TABLE "equipment_logistics" (
  "id" TEXT PRIMARY KEY,
  "work_date" TEXT NOT NULL,
  "kind" "EquipmentLogisticsKind" NOT NULL,
  "status" "EquipmentLogisticsStatus" NOT NULL,
  "request_id" TEXT NOT NULL,
  "equipment_type" "EquipmentType" NOT NULL,
  "donor_engineer_id" TEXT,
  "receiver_engineer_id" TEXT NOT NULL,
  "depot_id" TEXT,
  "lat" DOUBLE PRECISION NOT NULL,
  "lon" DOUBLE PRECISION NOT NULL,
  "expected_at" BIGINT,
  "actual_at" BIGINT,
  "failure_code" TEXT,
  "retry_at" BIGINT,
  "baseline_completion_at" BIGINT,
  "wait_started_at" BIGINT,
  "consumed_at" BIGINT,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "equipment_logistics_work_date_request_id_key" UNIQUE ("work_date", "request_id")
);
CREATE INDEX "equipment_logistics_work_date_receiver_engineer_id_status_idx"
  ON "equipment_logistics"("work_date", "receiver_engineer_id", "status");
