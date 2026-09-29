-- The 100-minute emergency duration landed without widening windows that were
-- shorter than the new service time, so those drafts could not be scheduled.
UPDATE "requests"
SET
  "window_end_at" = "window_start_at" + "service_duration_sec",
  "version" = "version" + 1
WHERE "work_category" = 'emergency'
  AND "lifecycle" IN ('draft', 'submitted')
  AND "started_at" IS NULL
  AND "service_duration_sec" >= 6000
  AND "window_end_at" < "window_start_at" + "service_duration_sec";
