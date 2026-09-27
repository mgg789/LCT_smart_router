CREATE TABLE "import_preparations" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "owner_kind" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "immutable_batch_hash" TEXT NOT NULL,
    "versions" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "findings" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,
    "expires_at" BIGINT NOT NULL,
    "confirmed_at" BIGINT,
    "cancelled_at" BIGINT,
    "operation_id" TEXT,
    "response" TEXT,

    CONSTRAINT "import_preparations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_preparations_status_check" CHECK ("status" IN ('prepared', 'confirmed', 'cancelled'))
);

CREATE UNIQUE INDEX "import_preparations_operation_id_key" ON "import_preparations"("operation_id");
CREATE INDEX "import_preparations_owner_kind_owner_id_status_idx" ON "import_preparations"("owner_kind", "owner_id", "status");
CREATE INDEX "import_preparations_expires_at_idx" ON "import_preparations"("expires_at");
