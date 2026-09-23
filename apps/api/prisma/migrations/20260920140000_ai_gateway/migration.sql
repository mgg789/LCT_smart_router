-- AI gateway data model: chat-first assistant conversations, their model runs and event
-- streams, the confirmable operation cards they stage, the per-account spend ledger that
-- guards them, dispatcher handovers, and the curated knowledge corpus the assistant
-- retrieves from. New tables inherit sys_app's privileges from the ALTER DEFAULT
-- PRIVILEGES set up in 20260915203835_init, so no GRANT is added here.

-- CreateEnum
CREATE TYPE "AiRoleProfile" AS ENUM ('client', 'engineer', 'dispatcher_readonly', 'dispatcher_fix');
CREATE TYPE "AiConversationMode" AS ENUM ('ai', 'dispatcher');
CREATE TYPE "AiAssistMode" AS ENUM ('help', 'fix');
CREATE TYPE "AiMessageAuthor" AS ENUM ('user', 'assistant', 'dispatcher', 'system');
CREATE TYPE "AiMessageKind" AS ENUM ('text', 'text_action', 'text_action_cancel', 'text_confirmation');
CREATE TYPE "AiRunState" AS ENUM ('running', 'stopping', 'stopped', 'completed', 'failed');
CREATE TYPE "AiOperationState" AS ENUM ('prepared', 'awaiting_confirmation', 'running', 'applied', 'rejected', 'cancelled_before_apply', 'outcome_unknown');
CREATE TYPE "AiKnowledgeSegment" AS ENUM ('client', 'engineer', 'dispatcher');
CREATE TYPE "AiHandoffState" AS ENUM ('waiting', 'answered', 'closed');
CREATE TYPE "AiProviderKind" AS ENUM ('agents', 'openai_chat', 'replay');

-- CreateTable
CREATE TABLE "ai_conversations" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "role" "Role" NOT NULL,
  "role_profile" "AiRoleProfile" NOT NULL,
  "mode" "AiConversationMode" NOT NULL DEFAULT 'ai',
  "assist_mode" "AiAssistMode" NOT NULL DEFAULT 'help',
  "context_ref" JSONB,
  "title" TEXT,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "last_message_at" BIGINT NOT NULL,
  "closed_at" BIGINT,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "author" "AiMessageAuthor" NOT NULL,
  "kind" "AiMessageKind" NOT NULL DEFAULT 'text',
  "text" TEXT NOT NULL,
  "actions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "run_id" TEXT,
  "operation_id" TEXT,
  "author_account_id" TEXT,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_runs" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "quota_day" TEXT NOT NULL,
  "quota_account_id" TEXT NOT NULL,
  "role_profile" "AiRoleProfile" NOT NULL,
  "state" "AiRunState" NOT NULL DEFAULT 'running',
  "provider_kind" "AiProviderKind" NOT NULL,
  "model" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "used_fallback" BOOLEAN NOT NULL DEFAULT false,
  "prompt_tokens" INTEGER,
  "completion_tokens" INTEGER,
  "cost_micros" INTEGER NOT NULL DEFAULT 0,
  "reserved_micros" INTEGER NOT NULL,
  "last_event_seq" INTEGER NOT NULL DEFAULT 0,
  "stop_requested_at" BIGINT,
  "started_at" BIGINT NOT NULL,
  "finished_at" BIGINT,
  "error_code" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_run_events" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "ai_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_operations" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "run_id" TEXT,
  "account_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "target_ref" TEXT,
  "payload" JSONB NOT NULL,
  "payload_fingerprint" TEXT NOT NULL,
  "summary" JSONB NOT NULL,
  "expected_version" INTEGER,
  "requires_confirmation" BOOLEAN NOT NULL DEFAULT true,
  "state" "AiOperationState" NOT NULL DEFAULT 'awaiting_confirmation',
  "created_at" BIGINT NOT NULL,
  "expires_at" BIGINT NOT NULL,
  "confirmed_at" BIGINT,
  "completed_at" BIGINT,
  "result_operation_id" TEXT,
  "result" JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ai_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_budgets" (
  "quota_day" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "reserved_micros" INTEGER NOT NULL DEFAULT 0,
  "settled_micros" INTEGER NOT NULL DEFAULT 0,
  "message_count" INTEGER NOT NULL DEFAULT 0,
  "updated_at" BIGINT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ai_budgets_pkey" PRIMARY KEY ("quota_day","account_id")
);

-- CreateTable
CREATE TABLE "ai_handoffs" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "requested_by_account_id" TEXT NOT NULL,
  "actor_role" "Role" NOT NULL,
  "request_ids" TEXT[],
  "engineer_ids" TEXT[],
  "state" "AiHandoffState" NOT NULL DEFAULT 'waiting',
  "created_at" BIGINT NOT NULL,
  "first_reply_at" BIGINT,
  "closed_at" BIGINT,
  "closed_by_account_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ai_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_documents" (
  "id" TEXT NOT NULL,
  "segment" "AiKnowledgeSegment" NOT NULL,
  "slug" TEXT NOT NULL,
  "section" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "tags" TEXT[],
  "actions" TEXT[],
  "checksum" TEXT NOT NULL,
  "source_path" TEXT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "ai_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: "my chats" and the dispatcher handover queue.
CREATE INDEX "ai_conversations_account_id_last_message_at_idx" ON "ai_conversations"("account_id", "last_message_at");
CREATE INDEX "ai_conversations_mode_last_message_at_idx" ON "ai_conversations"("mode", "last_message_at");

-- CreateIndex: the paging cursor for `?afterSeq=` reads within one conversation --
-- `created_at` alone cannot order two messages written in the same second.
CREATE UNIQUE INDEX "ai_messages_conversation_id_seq_key" ON "ai_messages"("conversation_id", "seq");

-- CreateIndex: the startup sweep of runs orphaned by a restart.
CREATE INDEX "ai_runs_state_started_at_idx" ON "ai_runs"("state", "started_at");

-- CreateIndex: the cursor that makes `?afterSeq=` resumption a range scan instead of a
-- sort of the whole run.
CREATE UNIQUE INDEX "ai_run_events_run_id_seq_key" ON "ai_run_events"("run_id", "seq");

-- CreateIndex: the card list and the expiry sweep.
CREATE INDEX "ai_operations_conversation_id_state_idx" ON "ai_operations"("conversation_id", "state");
CREATE INDEX "ai_operations_state_expires_at_idx" ON "ai_operations"("state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_documents_slug_section_key" ON "ai_documents"("slug", "section");
CREATE INDEX "ai_documents_segment_idx" ON "ai_documents"("segment");

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_run_events" ADD CONSTRAINT "ai_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ai_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_handoffs" ADD CONSTRAINT "ai_handoffs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The following three constraints cannot be expressed in schema.prisma (expression
-- indexes and partial unique indexes are outside Prisma's DSL). They are written here by
-- hand; a later `prisma migrate dev` does not know about them and will not regenerate
-- them, so any startup check that asserts required indexes must know their names too.
-- ---------------------------------------------------------------------------

-- Lexical knowledge search over the curated corpus. No embeddings and no pgvector: the
-- extension stays unused by deliberate decision (infra/docker-compose.yml), the image
-- merely keeps that door open. Prisma cannot declare an expression index, so this one is
-- written by hand and asserted at startup instead of being silently lost.
-- The whole expression needs its own parentheses: an index element may be a bare column
-- or function call, but anything built with an operator has to be wrapped, or the parser
-- stops at the first `||`.
CREATE INDEX "ai_documents_fts" ON "ai_documents" USING GIN ((
  setweight(to_tsvector('russian', "title"), 'A') ||
  setweight(to_tsvector('russian', "summary"), 'B') ||
  setweight(to_tsvector('russian', "body"), 'C')
));

-- One open handover per conversation: a repeated call_dispatch_helper() must return the
-- existing request rather than open a second tab. Enforced by the database, not by a
-- read-then-write that can race.
CREATE UNIQUE INDEX "ai_handoffs_one_open_per_conversation"
  ON "ai_handoffs" ("conversation_id") WHERE "state" <> 'closed';

-- One live run per conversation: two browser tabs must not stream two generations into
-- one chat.
CREATE UNIQUE INDEX "ai_runs_one_live_per_conversation"
  ON "ai_runs" ("conversation_id") WHERE "state" IN ('running', 'stopping');
