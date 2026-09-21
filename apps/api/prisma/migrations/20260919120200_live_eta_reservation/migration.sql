ALTER TABLE "live_request_states" ADD COLUMN "reserved_engineer_id" TEXT;
CREATE INDEX "live_request_states_reserved_engineer_id_idx" ON "live_request_states"("reserved_engineer_id");
