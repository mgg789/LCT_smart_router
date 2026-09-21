-- The `client_eng` category (context/41 section 5, 2026-09-19 amendment) covers one key
-- speaking to both the client and the engineer contours. No stored row can hold it yet,
-- so adding the value now is safe; PostgreSQL only forbids *using* a value added in the
-- same transaction, not adding it.
ALTER TYPE "ApiTokenCategory" ADD VALUE IF NOT EXISTS 'client_eng';

-- Optional per-key expiry. NULL stays "never expires"; a passed date stops new calls the
-- same way a revocation does (context/41 section 4.2, 2026-09-19 amendment).
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" BIGINT;
