-- A one-shot follow-up is a routine row carrying its item and consent state.
ALTER TABLE "routines" ADD COLUMN "followUp" JSONB;

-- Delivery preferences for follow-ups; defaults keep quiet hours at 22:00 to 07:00 local.
ALTER TABLE "notification_preferences" ADD COLUMN "followUps" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "quietHoursStart" INTEGER NOT NULL DEFAULT 1320;
ALTER TABLE "notification_preferences" ADD COLUMN "quietHoursEnd" INTEGER NOT NULL DEFAULT 420;
ALTER TABLE "notification_preferences" ADD COLUMN "followUpDailyCap" INTEGER NOT NULL DEFAULT 1;
