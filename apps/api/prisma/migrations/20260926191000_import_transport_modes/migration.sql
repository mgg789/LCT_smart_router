-- Explicit transport sources may distinguish a walking-only crew from one that can use transit.
-- Existing profiles retain the historic metro-capable walking behavior.
ALTER TABLE "engineers"
ADD COLUMN "transit_eligible" BOOLEAN NOT NULL DEFAULT true;
