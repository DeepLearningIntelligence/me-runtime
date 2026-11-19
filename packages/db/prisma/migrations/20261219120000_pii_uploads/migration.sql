-- Credentials uploaded through the authenticated PII tunnel. Only the sealed
-- ciphertext is stored, with the record id its authenticated data binds to.
CREATE TABLE "pii_uploads" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pii_uploads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pii_uploads_userId_createdAt_idx" ON "pii_uploads"("userId", "createdAt");

ALTER TABLE "pii_uploads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY pii_uploads_tenant ON "pii_uploads"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY pii_uploads_system ON "pii_uploads"
  USING (current_setting('app.rls_bypass', true) = 'on');
