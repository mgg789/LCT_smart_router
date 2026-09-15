-- Fingerprint of the task content, without the publication moment.
--
-- `input_hash` covers the whole published document including `planning_as_of`, which is
-- what a Router result is matched against. It cannot answer "did the task change",
-- because the timestamp inside it moves with every publication -- so the "nothing
-- changed, do not republish" rule silently never fired, and `planning_as_of` effectively
-- ticked, which context/33 section 7 forbids.
--
-- Existing rows get their own input_hash as a placeholder: they were published before the
-- distinction existed, and the first real comparison after this migration simply
-- republishes once.
ALTER TABLE "routing_snapshots" ADD COLUMN "task_fingerprint" TEXT;
UPDATE "routing_snapshots" SET "task_fingerprint" = "input_hash" WHERE "task_fingerprint" IS NULL;
ALTER TABLE "routing_snapshots" ALTER COLUMN "task_fingerprint" SET NOT NULL;
