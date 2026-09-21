-- The customer's right to silence (card #65, 2026-09-20). Every existing account has
-- been reachable by letter until now, so the default keeps that state.
ALTER TABLE "accounts" ADD COLUMN "mail_notifications_enabled" BOOLEAN NOT NULL DEFAULT true;
