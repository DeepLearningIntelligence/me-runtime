-- A link door records the signed-in person who opened it, so verify redeems
-- the link for that person and nobody else: the row is the authority.
-- Additive: sign-in doors simply carry null.
ALTER TABLE "me_phone_signins" ADD COLUMN     "linkUserId" TEXT;
