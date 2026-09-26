-- Created for the object-passport schema addition. Apply through `prisma migrate deploy`.
CREATE TYPE "ConnectionType" AS ENUM ('fiber', 'ethernet', 'dsl', 'radio', 'other');

CREATE TABLE "buildings" (
  "id" TEXT NOT NULL,
  "canonical_address" TEXT NOT NULL,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "buildings_canonical_address_key" ON "buildings"("canonical_address");

CREATE TABLE "reverse_geocode_cache" (
  "coordinate_key" TEXT NOT NULL,
  "canonical_address" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "resolved_at" BIGINT NOT NULL,
  CONSTRAINT "reverse_geocode_cache_pkey" PRIMARY KEY ("coordinate_key")
);

CREATE TABLE "object_passports" (
  "id" TEXT NOT NULL,
  "building_id" TEXT NOT NULL,
  "connection_type" "ConnectionType" NOT NULL,
  "difficulty" INTEGER NOT NULL,
  "equipment" TEXT,
  "access_notes" TEXT,
  "comment" TEXT,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "object_passports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "object_passports_building_id_key" ON "object_passports"("building_id");

CREATE TABLE "engineer_passport_points" (
  "id" TEXT NOT NULL,
  "engineer_id" TEXT NOT NULL,
  "operation_id" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  "awarded_at" BIGINT NOT NULL,
  CONSTRAINT "engineer_passport_points_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "engineer_passport_points_operation_id_key" ON "engineer_passport_points"("operation_id");
CREATE INDEX "engineer_passport_points_engineer_id_awarded_at_idx" ON "engineer_passport_points"("engineer_id", "awarded_at");

ALTER TABLE "object_passports" ADD CONSTRAINT "object_passports_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engineer_passport_points" ADD CONSTRAINT "engineer_passport_points_engineer_id_fkey" FOREIGN KEY ("engineer_id") REFERENCES "engineers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
