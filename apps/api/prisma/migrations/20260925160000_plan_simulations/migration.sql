CREATE TABLE "plan_simulations" (
  "id" TEXT PRIMARY KEY,
  "base_hash" TEXT NOT NULL,
  "context_version" TEXT NOT NULL,
  "patch_hash" TEXT NOT NULL,
  "patch" JSONB NOT NULL,
  "method" TEXT NOT NULL,
  "summary" JSONB NOT NULL,
  "routes" JSONB NOT NULL,
  "delta" JSONB NOT NULL,
  "created_at" BIGINT NOT NULL
);
CREATE UNIQUE INDEX "plan_simulations_base_hash_context_version_patch_hash_key"
  ON "plan_simulations"("base_hash", "context_version", "patch_hash");
CREATE INDEX "plan_simulations_base_hash_created_at_idx"
  ON "plan_simulations"("base_hash", "created_at");
