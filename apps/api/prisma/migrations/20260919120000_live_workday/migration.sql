-- Durable LIVE-session state. It deliberately does not alter Request lifecycle or
-- RequestFact: silent schedule progress is a product assumption, not a fabricated fact.
CREATE TYPE "LiveWorkdayStatus" AS ENUM ('pending', 'running', 'finished');
CREATE TYPE "LiveEngineerLineStatus" AS ENUM ('pending', 'online', 'no_show_offline', 'technical_break');
CREATE TYPE "LiveProblemKind" AS ENUM ('delay', 'missing_equipment', 'other', 'impossible');

CREATE TABLE "live_workdays" (
  "id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "work_date" TEXT NOT NULL,
  "status" "LiveWorkdayStatus" NOT NULL DEFAULT 'pending',
  "logical_start_at" BIGINT NOT NULL,
  "logical_end_at" BIGINT NOT NULL,
  "started_at_wall_sec" BIGINT,
  "speed_duration_sec" INTEGER,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "live_workdays_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_engineer_states" (
  "id" TEXT NOT NULL,
  "workday_id" TEXT NOT NULL,
  "engineer_id" TEXT NOT NULL,
  "line_status" "LiveEngineerLineStatus" NOT NULL DEFAULT 'pending',
  "line_started_at" BIGINT,
  "no_show_at" BIGINT,
  "technical_break_started_at" BIGINT,
  "technical_break_planned_end_at" BIGINT,
  "technical_break_overdue_at" BIGINT,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "live_engineer_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_request_states" (
  "id" TEXT NOT NULL,
  "workday_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "assumed_started_at" BIGINT,
  "assumed_completed_at" BIGINT,
  "reported_eta_at" BIGINT,
  "problem_kind" "LiveProblemKind",
  "problem_note" TEXT,
  "additional_duration_sec" INTEGER,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "live_request_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "live_workdays_generation_work_date_key" ON "live_workdays"("generation", "work_date");
CREATE INDEX "live_workdays_status_work_date_idx" ON "live_workdays"("status", "work_date");
CREATE UNIQUE INDEX "live_engineer_states_workday_id_engineer_id_key" ON "live_engineer_states"("workday_id", "engineer_id");
CREATE INDEX "live_engineer_states_engineer_id_idx" ON "live_engineer_states"("engineer_id");
CREATE UNIQUE INDEX "live_request_states_workday_id_request_id_key" ON "live_request_states"("workday_id", "request_id");
CREATE INDEX "live_request_states_request_id_idx" ON "live_request_states"("request_id");

ALTER TABLE "live_engineer_states" ADD CONSTRAINT "live_engineer_states_workday_id_fkey"
  FOREIGN KEY ("workday_id") REFERENCES "live_workdays"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_engineer_states" ADD CONSTRAINT "live_engineer_states_engineer_id_fkey"
  FOREIGN KEY ("engineer_id") REFERENCES "engineers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_request_states" ADD CONSTRAINT "live_request_states_workday_id_fkey"
  FOREIGN KEY ("workday_id") REFERENCES "live_workdays"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_request_states" ADD CONSTRAINT "live_request_states_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
