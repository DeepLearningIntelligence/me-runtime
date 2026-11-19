-- One inbound messaging message's receipt, queryable by the GPS tool. Add-only,
-- so a deploy that overlaps the previous release keeps working.
CREATE TABLE "messaging_receipts" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "medium" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "label" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messaging_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "messaging_receipts_provider_handle_key" ON "messaging_receipts"("provider", "handle");
CREATE INDEX "messaging_receipts_spaceId_capturedAt_idx" ON "messaging_receipts"("spaceId", "capturedAt");
