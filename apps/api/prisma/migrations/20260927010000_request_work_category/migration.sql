CREATE TYPE "WorkCategory" AS ENUM ('emergency', 'connection', 'service');
ALTER TABLE "requests" ADD COLUMN "work_category" "WorkCategory" NOT NULL DEFAULT 'service';
ALTER TABLE "requests" ADD COLUMN "received_at" BIGINT;
UPDATE "requests" SET "work_category" = CASE
  WHEN "work_type_hd" IN ('outage', 'Авария') OR ("work_type_hd" IS NULL AND "priority" = 'urgent') THEN 'emergency'::"WorkCategory"
  WHEN "work_type_hd" IN ('connection_request', 'convergence', 'gigabit_switch',
    'Заявка на подключение', 'Конвергенция абонента', 'Переключение на Гбит/с')
    THEN 'connection'::"WorkCategory"
  ELSE 'service'::"WorkCategory" END;
-- Historical/factual execution durations stay immutable. Only pending catalogue emergencies
-- adopt the new on-site 100-minute rule; travel remains separate.
UPDATE "requests" SET "norm_profile_code" = 'network_emergency', "service_duration_sec" = 6000, "technical_duration_sec" = 6000,
  "documentation_duration_sec" = 0, "priority" = 'urgent', "version" = "version" + 1
WHERE "work_category" = 'emergency' AND "lifecycle" IN ('draft', 'submitted')
  AND "started_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "live_request_states" l WHERE l."request_id" = "requests"."id"
    AND (l."assumed_started_at" IS NOT NULL OR l."assumed_completed_at" IS NOT NULL
      OR l."reported_eta_at" IS NOT NULL));
