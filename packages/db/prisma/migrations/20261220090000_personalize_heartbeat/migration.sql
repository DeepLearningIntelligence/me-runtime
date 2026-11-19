-- The PersonalizeME heartbeat is a routine row carrying its marker, like a follow-up.
ALTER TABLE "routines" ADD COLUMN "personalize" JSONB;

-- The heartbeat is its own toggle; the default keeps it on.
ALTER TABLE "notification_preferences" ADD COLUMN "heartbeats" BOOLEAN NOT NULL DEFAULT true;
