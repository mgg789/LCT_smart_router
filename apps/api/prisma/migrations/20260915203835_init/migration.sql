-- CreateEnum
CREATE TYPE "Role" AS ENUM ('client', 'engineer', 'dispatcher');

-- CreateEnum
CREATE TYPE "Skill" AS ENUM ('local', 'connection', 'emergency');

-- CreateEnum
CREATE TYPE "TransportType" AS ENUM ('car', 'walk', 'bike', 'transit');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('normal', 'urgent');

-- CreateEnum
CREATE TYPE "RequestLifecycle" AS ENUM ('draft', 'submitted', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "AssignmentState" AS ENUM ('pending', 'assigned', 'unassigned');

-- CreateEnum
CREATE TYPE "Availability" AS ENUM ('online', 'offline');

-- CreateEnum
CREATE TYPE "WindowOrigin" AS ENUM ('explicit', 'declared_full_day', 'missing_treated_as_full_day');

-- CreateEnum
CREATE TYPE "ControlMode" AS ENUM ('auto', 'manual');

-- CreateEnum
CREATE TYPE "PlanOrigin" AS ENUM ('auto', 'manual');

-- CreateEnum
CREATE TYPE "FactKind" AS ENUM ('arrived', 'arrived_blocked', 'started', 'finished', 'problem', 'lunch_started', 'lunch_finished');

-- CreateEnum
CREATE TYPE "StopKind" AS ENUM ('job', 'lunch', 'wait');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('info', 'warning', 'error');

-- CreateEnum
CREATE TYPE "ActorSource" AS ENUM ('ui', 'external_api', 'ai_run', 'system');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('account', 'api_token', 'system');

-- CreateEnum
CREATE TYPE "OperationState" AS ENUM ('applied', 'rejected', 'conflict', 'outcome_unknown');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('account_login_code', 'request_received', 'engineer_assigned', 'visit_change_required');

-- CreateEnum
CREATE TYPE "NotificationState" AS ENUM ('pending_submission', 'accepted_by_server', 'rejected', 'submission_unknown', 'expired_before_submission');

-- CreateEnum
CREATE TYPE "DataOrigin" AS ENUM ('import', 'manual', 'system_rule', 'synthesized');

-- CreateEnum
CREATE TYPE "ApiTokenCategory" AS ENUM ('client', 'eng', 'master');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_roles" (
    "accountId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "grantedAt" BIGINT NOT NULL,

    CONSTRAINT "account_roles_pkey" PRIMARY KEY ("accountId","role")
);

-- CreateTable
CREATE TABLE "login_codes" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedAt" BIGINT NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" BIGINT,

    CONSTRAINT "login_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "revokedAt" BIGINT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ApiTokenCategory" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "revokedAt" BIGINT,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engineers" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "displayName" TEXT NOT NULL,
    "inputOrder" INTEGER NOT NULL,
    "skills" "Skill"[],
    "transportType" "TransportType" NOT NULL,
    "depotId" TEXT,
    "homeLat" DOUBLE PRECISION,
    "homeLon" DOUBLE PRECISION,
    "region" TEXT,
    "origin" "DataOrigin" NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "archivedAt" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "engineers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engineer_days" (
    "id" TEXT NOT NULL,
    "engineerId" TEXT NOT NULL,
    "workDate" TEXT NOT NULL,
    "shiftStartAt" BIGINT NOT NULL,
    "shiftEndAt" BIGINT NOT NULL,
    "availability" "Availability" NOT NULL DEFAULT 'online',
    "expectedOnlineAt" BIGINT,
    "lunchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lunchDurationSec" INTEGER,
    "lunchWindowStartAt" BIGINT,
    "lunchWindowEndAt" BIGINT,
    "lunchRequired" BOOLEAN NOT NULL DEFAULT false,
    "lunchTaken" BOOLEAN NOT NULL DEFAULT false,
    "lunchStartedAt" BIGINT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "engineer_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depots" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "addressText" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "origin" "DataOrigin" NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "depots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requests" (
    "id" TEXT NOT NULL,
    "clientAccountId" TEXT,
    "arrivalOrder" INTEGER NOT NULL,
    "addressText" TEXT NOT NULL,
    "district" TEXT,
    "region" TEXT,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "needsGeocoding" BOOLEAN NOT NULL DEFAULT true,
    "serviceDurationSec" INTEGER NOT NULL,
    "windowStartAt" BIGINT NOT NULL,
    "windowEndAt" BIGINT NOT NULL,
    "windowOrigin" "WindowOrigin" NOT NULL DEFAULT 'explicit',
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "requiredSkill" "Skill" NOT NULL,
    "requiredTransport" "TransportType",
    "workTypeHd" TEXT,
    "lifecycle" "RequestLifecycle" NOT NULL DEFAULT 'draft',
    "assignmentState" "AssignmentState" NOT NULL DEFAULT 'pending',
    "origin" "DataOrigin" NOT NULL,
    "problemText" TEXT,
    "contactName" TEXT,
    "createdAt" BIGINT NOT NULL,
    "submittedAt" BIGINT,
    "startedAt" BIGINT,
    "completedAt" BIGINT,
    "cancelledAt" BIGINT,
    "updatedAt" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_condition_history" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "changedAt" BIGINT NOT NULL,
    "operationId" TEXT,
    "previous" JSONB NOT NULL,
    "reason" TEXT,

    CONSTRAINT "request_condition_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_facts" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "engineerId" TEXT,
    "kind" "FactKind" NOT NULL,
    "occurredAt" BIGINT NOT NULL,
    "recordedAt" BIGINT NOT NULL,
    "note" TEXT,
    "operationId" TEXT,

    CONSTRAINT "request_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gps_observations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "observedAt" BIGINT NOT NULL,
    "recordedAt" BIGINT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "gps_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_snapshots" (
    "id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "planningAsOf" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "trigger" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "diagnostics" JSONB NOT NULL,

    CONSTRAINT "routing_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_current" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "snapshotId" TEXT NOT NULL,
    "pointerVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "routing_current_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "router_results" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "routerContextVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "planningAsOf" BIGINT,
    "computedAt" BIGINT,
    "receivedAt" BIGINT NOT NULL,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "rejectionCode" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "router_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applied_plans" (
    "id" TEXT NOT NULL,
    "revision" SERIAL NOT NULL,
    "origin" "PlanOrigin" NOT NULL,
    "routerResultId" TEXT,
    "planAsOf" BIGINT NOT NULL,
    "appliedAt" BIGINT NOT NULL,
    "createdBy" TEXT,
    "note" TEXT,

    CONSTRAINT "applied_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applied_plan_current" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "planId" TEXT NOT NULL,
    "pointerVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "applied_plan_current_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applied_plan_routes" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "engineerId" TEXT NOT NULL,
    "startLat" DOUBLE PRECISION NOT NULL,
    "startLon" DOUBLE PRECISION NOT NULL,
    "startAt" BIGINT,
    "finishAt" BIGINT,
    "distanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "travelTimeSec" INTEGER NOT NULL DEFAULT 0,
    "workTimeSec" INTEGER NOT NULL DEFAULT 0,
    "waitingTimeSec" INTEGER NOT NULL DEFAULT 0,
    "lunchTimeSec" INTEGER NOT NULL DEFAULT 0,
    "assignedCount" INTEGER NOT NULL DEFAULT 0,
    "lunchStatus" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,

    CONSTRAINT "applied_plan_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applied_plan_stops" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "StopKind" NOT NULL,
    "requestId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "arrivalAt" BIGINT NOT NULL,
    "startAt" BIGINT NOT NULL,
    "endAt" BIGINT NOT NULL,

    CONSTRAINT "applied_plan_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applied_plan_assignments" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" "AssignmentState" NOT NULL,
    "engineerId" TEXT,
    "stopId" TEXT,
    "reasons" JSONB NOT NULL,

    CONSTRAINT "applied_plan_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" "ControlMode" NOT NULL DEFAULT 'auto',
    "modeVersion" INTEGER NOT NULL DEFAULT 1,
    "changedAt" BIGINT NOT NULL,
    "changedBy" TEXT,
    "frozenPlanId" TEXT,

    CONSTRAINT "control_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "policyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "parameters" JSONB NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("policyId")
);

-- CreateTable
CREATE TABLE "active_policy" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "policyId" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "changedAt" BIGINT NOT NULL,
    "changedBy" TEXT,

    CONSTRAINT "active_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "engineerIds" TEXT[],
    "requestIds" TEXT[],
    "reasons" JSONB NOT NULL,
    "restoreOption" JSONB,
    "sourceResultId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "seenAt" BIGINT,
    "resolvedAt" BIGINT,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operations" (
    "operationId" TEXT NOT NULL,
    "actorKind" "ActorKind" NOT NULL,
    "actorId" TEXT,
    "source" "ActorSource" NOT NULL,
    "action" TEXT NOT NULL,
    "targetRef" TEXT,
    "payloadFingerprint" TEXT NOT NULL,
    "state" "OperationState" NOT NULL,
    "response" JSONB,
    "createdAt" BIGINT NOT NULL,
    "completedAt" BIGINT,

    CONSTRAINT "operations_pkey" PRIMARY KEY ("operationId")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "at" BIGINT NOT NULL,
    "actorKind" "ActorKind" NOT NULL,
    "actorId" TEXT,
    "source" "ActorSource" NOT NULL,
    "action" TEXT NOT NULL,
    "targetRef" TEXT,
    "operationId" TEXT,
    "details" JSONB NOT NULL,
    "retainUntil" BIGINT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_intents" (
    "id" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "businessEventKey" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" "NotificationState" NOT NULL DEFAULT 'pending_submission',
    "createdAt" BIGINT NOT NULL,
    "submittedAt" BIGINT,
    "error" TEXT,

    CONSTRAINT "notification_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_state" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "app_state_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "import_packages" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "appliedAt" BIGINT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "summary" JSONB NOT NULL,

    CONSTRAINT "import_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_id_map" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "internalId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "external_id_map_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

-- CreateIndex
CREATE INDEX "login_codes_email_expiresAt_idx" ON "login_codes"("email", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_accountId_idx" ON "sessions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "engineers_accountId_key" ON "engineers"("accountId");

-- CreateIndex
CREATE INDEX "engineers_inputOrder_idx" ON "engineers"("inputOrder");

-- CreateIndex
CREATE UNIQUE INDEX "engineer_days_engineerId_workDate_key" ON "engineer_days"("engineerId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "depots_region_key" ON "depots"("region");

-- CreateIndex
CREATE INDEX "requests_lifecycle_assignmentState_idx" ON "requests"("lifecycle", "assignmentState");

-- CreateIndex
CREATE INDEX "requests_arrivalOrder_idx" ON "requests"("arrivalOrder");

-- CreateIndex
CREATE INDEX "request_condition_history_requestId_changedAt_idx" ON "request_condition_history"("requestId", "changedAt");

-- CreateIndex
CREATE INDEX "request_facts_requestId_occurredAt_idx" ON "request_facts"("requestId", "occurredAt");

-- CreateIndex
CREATE INDEX "gps_observations_accountId_observedAt_idx" ON "gps_observations"("accountId", "observedAt");

-- CreateIndex
CREATE INDEX "routing_snapshots_inputHash_idx" ON "routing_snapshots"("inputHash");

-- CreateIndex
CREATE INDEX "routing_snapshots_createdAt_idx" ON "routing_snapshots"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "routing_current_snapshotId_key" ON "routing_current"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "router_results_resultId_key" ON "router_results"("resultId");

-- CreateIndex
CREATE INDEX "router_results_inputHash_idx" ON "router_results"("inputHash");

-- CreateIndex
CREATE UNIQUE INDEX "applied_plans_revision_key" ON "applied_plans"("revision");

-- CreateIndex
CREATE UNIQUE INDEX "applied_plan_current_planId_key" ON "applied_plan_current"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "applied_plan_routes_planId_engineerId_key" ON "applied_plan_routes"("planId", "engineerId");

-- CreateIndex
CREATE UNIQUE INDEX "applied_plan_stops_routeId_sequence_key" ON "applied_plan_stops"("routeId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "applied_plan_assignments_planId_requestId_key" ON "applied_plan_assignments"("planId", "requestId");

-- CreateIndex
CREATE INDEX "alerts_createdAt_idx" ON "alerts"("createdAt");

-- CreateIndex
CREATE INDEX "operations_createdAt_idx" ON "operations"("createdAt");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- CreateIndex
CREATE INDEX "audit_log_targetRef_idx" ON "audit_log"("targetRef");

-- CreateIndex
CREATE UNIQUE INDEX "notification_intents_businessEventKey_key" ON "notification_intents"("businessEventKey");

-- CreateIndex
CREATE INDEX "notification_intents_state_idx" ON "notification_intents"("state");

-- CreateIndex
CREATE UNIQUE INDEX "import_packages_source_checksum_key" ON "import_packages"("source", "checksum");

-- CreateIndex
CREATE INDEX "external_id_map_internalId_idx" ON "external_id_map"("internalId");

-- CreateIndex
CREATE UNIQUE INDEX "external_id_map_source_entityType_externalId_key" ON "external_id_map"("source", "entityType", "externalId");

-- AddForeignKey
ALTER TABLE "account_roles" ADD CONSTRAINT "account_roles_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engineers" ADD CONSTRAINT "engineers_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engineers" ADD CONSTRAINT "engineers_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engineer_days" ADD CONSTRAINT "engineer_days_engineerId_fkey" FOREIGN KEY ("engineerId") REFERENCES "engineers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requests" ADD CONSTRAINT "requests_clientAccountId_fkey" FOREIGN KEY ("clientAccountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_condition_history" ADD CONSTRAINT "request_condition_history_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_facts" ADD CONSTRAINT "request_facts_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_facts" ADD CONSTRAINT "request_facts_engineerId_fkey" FOREIGN KEY ("engineerId") REFERENCES "engineers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_observations" ADD CONSTRAINT "gps_observations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_current" ADD CONSTRAINT "routing_current_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "routing_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_plans" ADD CONSTRAINT "applied_plans_routerResultId_fkey" FOREIGN KEY ("routerResultId") REFERENCES "router_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_plan_current" ADD CONSTRAINT "applied_plan_current_planId_fkey" FOREIGN KEY ("planId") REFERENCES "applied_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_plan_routes" ADD CONSTRAINT "applied_plan_routes_planId_fkey" FOREIGN KEY ("planId") REFERENCES "applied_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_plan_stops" ADD CONSTRAINT "applied_plan_stops_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "applied_plan_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_plan_stops" ADD CONSTRAINT "applied_plan_stops_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_plan_assignments" ADD CONSTRAINT "applied_plan_assignments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "applied_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_plan_assignments" ADD CONSTRAINT "applied_plan_assignments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Privilege model (context/43 section 5.1).
--
-- Two group roles, created NOLOGIN and without passwords: this migration defines *what*
-- each connection may touch, while a deployment creates the login users and grants them
-- these roles. Secrets therefore never enter the repository.
--
--   sys_app          the application writer -- all business data
--   router_readonly  Router Core -- the published sector and nothing else
--
-- Permissions are real GRANTs, not a naming convention: context/37 section 3.4 requires
-- that separating the areas actually restrict access.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sys_app') THEN
    CREATE ROLE sys_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'router_readonly') THEN
    CREATE ROLE router_readonly NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO sys_app, router_readonly;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sys_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sys_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sys_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sys_app;

-- Read-only on exactly the two tables that carry the published task. Router must not be
-- able to read sessions, chats, contacts or the optional GPS observations
-- (context/37 section 4.4). No default privileges are granted, so a table added later
-- stays invisible to Router until someone grants it deliberately.
GRANT SELECT ON TABLE "routing_snapshots", "routing_current" TO router_readonly;
