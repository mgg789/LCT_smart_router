-- Existing imported working days must follow the same optional-lunch contract as new
-- packages. All supported v0 regions use the configured Moscow planning time zone.
UPDATE "engineer_days"
SET
  "lunch_enabled" = TRUE,
  "lunch_duration_sec" = 2700,
  "lunch_window_start_at" = EXTRACT(
    EPOCH FROM (("work_date" || ' 11:20:00 Europe/Moscow')::timestamptz)
  )::bigint,
  "lunch_window_end_at" = EXTRACT(
    EPOCH FROM (("work_date" || ' 15:00:00 Europe/Moscow')::timestamptz)
  )::bigint,
  "updated_at" = EXTRACT(EPOCH FROM NOW())::bigint,
  "version" = "engineer_days"."version" + 1
FROM "engineers"
WHERE "engineers"."id" = "engineer_days"."engineer_id"
  AND "engineers"."origin" IN ('import', 'synthesized')
  AND "engineer_days"."shift_end_at" > "engineer_days"."shift_start_at"
  AND (
    "engineer_days"."lunch_enabled" IS DISTINCT FROM TRUE
    OR "engineer_days"."lunch_duration_sec" IS DISTINCT FROM 2700
    OR "engineer_days"."lunch_window_start_at" IS DISTINCT FROM EXTRACT(
      EPOCH FROM (("engineer_days"."work_date" || ' 11:20:00 Europe/Moscow')::timestamptz)
    )::bigint
    OR "engineer_days"."lunch_window_end_at" IS DISTINCT FROM EXTRACT(
      EPOCH FROM (("engineer_days"."work_date" || ' 15:00:00 Europe/Moscow')::timestamptz)
    )::bigint
  );
