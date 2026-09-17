-- Keep existing plans readable while adding Router leg geometry/provenance.
ALTER TABLE "applied_plan_routes"
ADD COLUMN "legs" JSONB NOT NULL DEFAULT '[]'::jsonb;
