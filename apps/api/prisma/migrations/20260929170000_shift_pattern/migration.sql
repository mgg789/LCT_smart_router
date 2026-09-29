-- Field crews default to the 2/2 window. Existing profiles are backfilled by the default.
-- Shift clocks already stored on engineer_days are left untouched.
CREATE TYPE "ShiftPattern" AS ENUM ('two_two', 'five_two');

ALTER TABLE "engineers"
ADD COLUMN "shift_pattern" "ShiftPattern" NOT NULL DEFAULT 'two_two';
