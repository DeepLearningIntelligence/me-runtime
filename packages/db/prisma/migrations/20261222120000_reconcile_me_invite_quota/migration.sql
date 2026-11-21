BEGIN;

-- Freeze invite and quota writes while taking the reconciliation snapshot.
LOCK TABLE "me_invite_quotas", "me_invitations" IN SHARE ROW EXCLUSIVE MODE;

-- Withdrawals before slot recredit shipped left grantedCount inflated.
-- Issued links (including expired ones) and redeemed links still occupy slots.
WITH invite_counts AS (
  SELECT "inviterId",
         count(*) FILTER (WHERE status IN ('issued', 'redeemed'))::integer AS occupied,
         count(*) FILTER (WHERE status = 'redeemed')::integer AS redeemed,
         count(*) FILTER (WHERE status = 'revoked')::integer AS revoked
  FROM "me_invitations"
  GROUP BY "inviterId"
)
UPDATE "me_invite_quotas" AS quota
SET "grantedCount" = invite_counts.occupied
FROM invite_counts
WHERE quota."userId" = invite_counts."inviterId"
  AND quota."grantedCount" > invite_counts.occupied
  AND quota."redeemedCount" = invite_counts.redeemed
  AND quota."grantedCount" - invite_counts.occupied <= invite_counts.revoked;

COMMIT;
