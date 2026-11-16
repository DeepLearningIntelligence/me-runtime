-- Account creation through the phone door is invite-only (the invitations
-- service owns admission): the door opened from the welcome page carries the
-- link's token, pre-flighted at start and redeemed in the same transaction
-- that creates the person at verify. Only the token's SHA-256 is stored.
-- Additive: existing doors simply opened without an invite.
ALTER TABLE "me_phone_signins" ADD COLUMN "inviteTokenHash" TEXT;
