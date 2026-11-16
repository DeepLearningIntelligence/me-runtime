CREATE TABLE "me_phone_signins" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "nonceHash" TEXT NOT NULL,
  "phoneHash" TEXT,
  "codeHash" TEXT,
  "boundAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "me_phone_signins_nonceHash_key" ON "me_phone_signins"("nonceHash");
CREATE INDEX "me_phone_signins_ipAddress_createdAt_idx" ON "me_phone_signins"("ipAddress", "createdAt");
ALTER TABLE "me_phone_signins" ENABLE ROW LEVEL SECURITY;
CREATE POLICY me_phone_signins_system ON "me_phone_signins"
  USING ((SELECT app_rls_bypass()));

CREATE TABLE "me_phone_signin_messages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "me_phone_signin_messages_provider_providerMessageId_key" ON "me_phone_signin_messages"("provider", "providerMessageId");
ALTER TABLE "me_phone_signin_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY me_phone_signin_messages_system ON "me_phone_signin_messages"
  USING ((SELECT app_rls_bypass()));
