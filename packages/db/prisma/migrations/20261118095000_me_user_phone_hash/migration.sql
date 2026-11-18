-- A phone belongs to one person: the hash a linked account carries (the owner
-- bootstrap's OWNER_PHONE or the signed-in link), set also when phone sign-in
-- creates a person. Only the door's HMAC is stored, never the number.
-- Additive: email-only accounts simply have no phone yet.
ALTER TABLE "user" ADD COLUMN     "phoneHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "user_phoneHash_key" ON "user"("phoneHash");
