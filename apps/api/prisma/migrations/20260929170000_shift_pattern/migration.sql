-- Field crews default to the 2/2 window. Existing profiles are backfilled by the default.
CREATE TYPE "ShiftPattern" AS ENUM ('two_two', 'five_two');

ALTER TABLE "engineers"
ADD COLUMN "shift_pattern" "ShiftPattern" NOT NULL DEFAULT 'two_two';

-- Today's opened shifts move to the 2/2 clocks (10:00–22:00 Europe/Moscow).
-- Earlier days stay as they were recorded.
UPDATE "engineer_days"
SET
  "shift_start_at" = (EXTRACT(EPOCH FROM (("work_date"::date + TIME '10:00') AT TIME ZONE 'Europe/Moscow')))::bigint,
  "shift_end_at" = (EXTRACT(EPOCH FROM (("work_date"::date + TIME '22:00') AT TIME ZONE 'Europe/Moscow')))::bigint
WHERE "work_date" = (NOW() AT TIME ZONE 'Europe/Moscow')::date::text;
