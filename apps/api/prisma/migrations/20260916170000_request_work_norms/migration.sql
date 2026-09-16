-- Preserve the normative breakdown separately from route travel. The official workbook
-- describes a 20-minute reference journey, while service_duration_sec is on-site work
-- only so Router cannot charge travel twice.
ALTER TABLE "requests"
  ADD COLUMN "norm_profile_code" TEXT,
  ADD COLUMN "normative_travel_duration_sec" INTEGER,
  ADD COLUMN "technical_duration_sec" INTEGER,
  ADD COLUMN "documentation_duration_sec" INTEGER,
  ADD COLUMN "expected_completion_at" BIGINT,
  ADD COLUMN "continuation_available_at" BIGINT,
  ADD COLUMN "overrun_detected_at" BIGINT;

UPDATE "requests"
SET
  "norm_profile_code" = CASE
    WHEN "work_type_hd" IN ('connection_request', 'convergence', 'gigabit_switch')
      THEN 'connection_base'
    WHEN "work_type_hd" IN ('outage', 'no_link', 'disconnects', 'low_speed', 'port_errors', 'ip_169')
      THEN 'outage_tkd'
    WHEN "work_type_hd" IN ('equipment_order', 'router_replacement', 'stb_replacement')
      THEN 'equipment_order'
    ELSE 'local_repair'
  END,
  "normative_travel_duration_sec" = 1200,
  "technical_duration_sec" = CASE
    WHEN "work_type_hd" IN ('connection_request', 'convergence', 'gigabit_switch') THEN 3600
    WHEN "work_type_hd" IN ('outage', 'no_link', 'disconnects', 'low_speed', 'port_errors', 'ip_169') THEN 4800
    WHEN "work_type_hd" IN ('equipment_order', 'router_replacement', 'stb_replacement') THEN 600
    ELSE 1800
  END,
  "documentation_duration_sec" = CASE
    WHEN "work_type_hd" IN ('connection_request', 'convergence', 'gigabit_switch') THEN 600
    WHEN "work_type_hd" IN ('equipment_order', 'router_replacement', 'stb_replacement') THEN 600
    ELSE 0
  END,
  "service_duration_sec" = CASE
    WHEN "work_type_hd" IN ('connection_request', 'convergence', 'gigabit_switch') THEN 4200
    WHEN "work_type_hd" IN ('outage', 'no_link', 'disconnects', 'low_speed', 'port_errors', 'ip_169') THEN 4800
    WHEN "work_type_hd" IN ('equipment_order', 'router_replacement', 'stb_replacement') THEN 1200
    ELSE 1800
  END;

ALTER TABLE "requests"
  ALTER COLUMN "norm_profile_code" SET NOT NULL,
  ALTER COLUMN "normative_travel_duration_sec" SET NOT NULL,
  ALTER COLUMN "technical_duration_sec" SET NOT NULL,
  ALTER COLUMN "documentation_duration_sec" SET NOT NULL;

ALTER TABLE "requests"
  ADD CONSTRAINT "requests_normative_travel_duration_sec_nonnegative"
    CHECK ("normative_travel_duration_sec" >= 0),
  ADD CONSTRAINT "requests_technical_duration_sec_nonnegative"
    CHECK ("technical_duration_sec" >= 0),
  ADD CONSTRAINT "requests_documentation_duration_sec_nonnegative"
    CHECK ("documentation_duration_sec" >= 0),
  ADD CONSTRAINT "requests_service_duration_matches_components"
    CHECK ("service_duration_sec" = "technical_duration_sec" + "documentation_duration_sec");
