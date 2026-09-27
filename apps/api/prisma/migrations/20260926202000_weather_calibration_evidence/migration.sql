ALTER TABLE "request_facts" ADD COLUMN "metadata" JSONB;

CREATE TABLE "weather_day_cache" (
    "region" TEXT NOT NULL,
    "work_date" TEXT NOT NULL,
    "location_hash" TEXT NOT NULL,
    "weather_code" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "fetched_at" BIGINT NOT NULL,

    CONSTRAINT "weather_day_cache_pkey" PRIMARY KEY ("region", "work_date")
);

CREATE INDEX "weather_day_cache_work_date_idx" ON "weather_day_cache"("work_date");
