CREATE TYPE "EquipmentType" AS ENUM ('router', 'set_top_box', 'smart_speaker');

ALTER TABLE "engineer_days"
  ADD COLUMN "equipment_router" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "equipment_set_top_box" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "equipment_smart_speaker" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "equipment_issued_at" BIGINT;

ALTER TABLE "requests"
  ADD COLUMN "required_equipment" "EquipmentType";

ALTER TABLE "engineer_days"
  ADD CONSTRAINT "engineer_days_equipment_nonnegative"
  CHECK (
    "equipment_router" >= 0
    AND "equipment_set_top_box" >= 0
    AND "equipment_smart_speaker" >= 0
  );
