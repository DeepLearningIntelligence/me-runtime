-- Schema alignment: six foreign keys were declared inline in their CREATE
-- TABLE statements with only ON DELETE CASCADE, while every other foreign key
-- in the database and the Prisma schema (whose default referential action is
-- ON UPDATE CASCADE) carries both actions. prisma migrate diff flagged exactly
-- these six, so they are re-created with the action the schema declares. The
-- tables are small and the constraint names are unchanged, so a deploy that
-- overlaps the previous release keeps working.
--
-- billing_audit_events.id also appeared in the diff (the database carries a
-- gen_random_uuid()::text default the schema did not declare), but the default
-- is load-bearing: four SECURITY DEFINER trigger functions in
-- 20261023000300_billing_audit and 20261023000500_credit_expiration insert
-- audit rows without an id and rely on it. Dropping it here would break every
-- credit write, so the schema declares the default instead
-- (@default(dbgenerated(...)), same commit); no statement in this migration
-- touches the column. See FORK.d/P15.md.
ALTER TABLE "computer_updates" DROP CONSTRAINT "computer_updates_computerId_fkey";
ALTER TABLE "email_sends" DROP CONSTRAINT "email_sends_userId_fkey";
ALTER TABLE "model_credit_accounts" DROP CONSTRAINT "model_credit_accounts_organizationId_fkey";
ALTER TABLE "model_credit_entries" DROP CONSTRAINT "model_credit_entries_organizationId_fkey";
ALTER TABLE "model_credit_lots" DROP CONSTRAINT "model_credit_lots_organizationId_fkey";
ALTER TABLE "push_tokens" DROP CONSTRAINT "push_tokens_userId_fkey";
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_updates" ADD CONSTRAINT "computer_updates_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "model_credit_accounts" ADD CONSTRAINT "model_credit_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "model_credit_entries" ADD CONSTRAINT "model_credit_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "model_credit_accounts"("organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "model_credit_lots" ADD CONSTRAINT "model_credit_lots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "model_credit_accounts"("organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
