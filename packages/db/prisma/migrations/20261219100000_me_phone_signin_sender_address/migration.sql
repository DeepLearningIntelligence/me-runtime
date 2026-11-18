-- The sender's WhatsApp address, sealed with the secret-store cipher, rides
-- with the bound sign-in row until the code is consumed (ME-RUN-005).
-- Additive: every row simply carries null until the next `ME-` message binds.
ALTER TABLE "me_phone_signins" ADD COLUMN     "senderAddress" TEXT;
