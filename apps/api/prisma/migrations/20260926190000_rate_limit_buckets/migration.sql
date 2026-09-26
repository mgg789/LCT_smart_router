-- Shared API request budgets. The guard increments this row with one atomic
-- INSERT ... ON CONFLICT statement, so concurrent API instances cannot bypass a limit.
CREATE TABLE "rate_limit_buckets" (
  "scope" TEXT NOT NULL,
  "client_key" TEXT NOT NULL,
  "window_start" BIGINT NOT NULL,
  "count" INTEGER NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("scope", "client_key", "window_start")
);

CREATE INDEX "rate_limit_buckets_window_start_idx"
  ON "rate_limit_buckets"("window_start");
