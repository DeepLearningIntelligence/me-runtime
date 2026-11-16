-- Person-to-person invitations (me.io): the only door into the product for new
-- people. Tokens are stored hashed; a redeem claims the row in one transaction;
-- each person's link counts live in their quota row. Additive: the org "invitation"
-- and "space_invites" tables are unrelated and stay as they are.

CREATE TABLE "me_invite_quotas" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "allocation" INTEGER NOT NULL,
  "grantedCount" INTEGER NOT NULL DEFAULT 0,
  "redeemedCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "me_invite_quotas_allocation_positive" CHECK ("allocation" >= 1),
  CONSTRAINT "me_invite_quotas_counts_nonnegative"
    CHECK ("grantedCount" >= 0 AND "redeemedCount" >= 0),
  CONSTRAINT "me_invite_quotas_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "me_invitations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "inviterId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'issued',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "redeemedAt" TIMESTAMP(3),
  "redeemedByUserId" TEXT,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "me_invitations_inviterId_fkey" FOREIGN KEY ("inviterId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "me_invitations_redeemedByUserId_fkey" FOREIGN KEY ("redeemedByUserId")
    REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "me_invitations_tokenHash_key" ON "me_invitations"("tokenHash");
CREATE INDEX "me_invitations_inviterId_createdAt_idx"
  ON "me_invitations"("inviterId", "createdAt");

-- An invite is cross-person by design (the redeemer is not the inviter), so the
-- service reads and claims rows as system. The tenant policy is defence in
-- depth: the inviter's own rows are visible to their own tenant context, and
-- everything else refuses without the bypass.
ALTER TABLE "me_invite_quotas" ENABLE ROW LEVEL SECURITY;
CREATE POLICY me_invite_quotas_tenant ON "me_invite_quotas"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY me_invite_quotas_system ON "me_invite_quotas"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "me_invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY me_invitations_tenant ON "me_invitations"
  USING ("inviterId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY me_invitations_system ON "me_invitations"
  USING (current_setting('app.rls_bypass', true) = 'on');
