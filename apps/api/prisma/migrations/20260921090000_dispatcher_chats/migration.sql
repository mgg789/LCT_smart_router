-- Person-to-person chat between the dispatcher and a client or an engineer.
--
-- Until now a handover could only ever start from the assistant's side: someone typed to
-- the AI, the AI called `call_dispatch_helper`, and a row appeared in the dispatcher's
-- queue. The dispatcher had no way to open a dialogue themselves, and every row they had
-- already dealt with vanished from the list the moment they closed it.
--
-- Four columns fix both halves of that, without a second table: the handover records
-- which side opened it, how far the dispatcher has read, and where in the dialogue it
-- began and ended -- which is what lets a closed one keep showing the conversation as it
-- stood when it was closed, instead of quietly growing messages nobody on that row ever
-- saw.

CREATE TYPE "AiHandoffOrigin" AS ENUM ('user', 'dispatcher');

-- Existing rows all came from `call_dispatch_helper`, which is exactly what `user` means
-- here, so the default backfills them correctly and no data migration is needed.
ALTER TABLE "ai_handoffs"
  ADD COLUMN "initiated_by" "AiHandoffOrigin" NOT NULL DEFAULT 'user',
  ADD COLUMN "dispatcher_last_read_seq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "start_seq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "end_seq" INTEGER;

-- `start_seq = 0` is right for every existing row too: a handover opened by
-- `call_dispatch_helper` is meant to show the dispatcher everything said before it, and 0
-- is "from the first message". `end_seq` stays NULL on rows closed before this migration
-- -- an unknown boundary is read as "no boundary", which shows the whole conversation, the
-- same thing those rows showed yesterday.

-- The list is "open handovers first, then the closed ones, newest first" and it now scans
-- closed rows too, so ordering by `state` and `created_at` together is the access path
-- rather than an optimisation of one.
CREATE INDEX "ai_handoffs_state_created_at_idx" ON "ai_handoffs" ("state", "created_at");
