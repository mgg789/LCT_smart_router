ALTER TABLE "live_workdays"
  ADD COLUMN "finished_at" BIGINT,
  ADD COLUMN "completion_reason" TEXT;

ALTER TABLE "live_engineer_states"
  ADD COLUMN "route_anchor_request_id" TEXT,
  ADD COLUMN "route_anchor_reached_at" BIGINT,
  ADD COLUMN "route_anchor_departed_at" BIGINT,
  ADD COLUMN "active_lunch_lat" DOUBLE PRECISION,
  ADD COLUMN "active_lunch_lon" DOUBLE PRECISION;

CREATE INDEX "live_engineer_states_route_anchor_request_id_idx"
  ON "live_engineer_states"("route_anchor_request_id");
