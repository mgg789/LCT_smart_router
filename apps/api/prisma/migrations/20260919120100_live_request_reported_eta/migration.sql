-- Compatibility no-op for databases where the initial LIVE migration already carried
-- this column while it was being applied. Fresh installations receive it from the first
-- migration; older in-flight local databases receive it here.
ALTER TABLE "live_request_states" ADD COLUMN IF NOT EXISTS "reported_eta_at" BIGINT;
