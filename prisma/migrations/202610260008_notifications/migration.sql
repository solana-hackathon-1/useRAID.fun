BEGIN;
-- In-app notifications: identifier-only, append-only apart from the first read. Text is generated from the kind at
-- read time, so no private subject matter, bearer link or free text is ever stored.
CREATE TABLE "Notification" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "accountId" text NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "kind" text NOT NULL CHECK ("kind" IN ('ENGAGEMENT_ACCEPTED','RAID_ACCEPTED','SUBMISSION_RECEIVED','REVIEW_DECIDED','WORK_CLOSED','RAID_CLOSED','AMENDMENT_PROPOSED','AMENDMENT_DECIDED','AMENDMENT_WITHDRAWN','DEADLINE_APPROACHING','REVIEW_DEADLINE_APPROACHING')),
 "category" text NOT NULL CHECK ("category" IN ('TRANSACTIONAL','PROMOTIONAL')),
 "dedupeKey" text NOT NULL UNIQUE,
 "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
 "createdAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 "readAt" timestamptz(6),
 CONSTRAINT "Notification_payload_check" CHECK (jsonb_typeof("payload")='object' AND ("payload"-'engagementId'-'deadline')='{}'::jsonb)
);
CREATE INDEX "Notification_accountId_createdAt_idx" ON "Notification"("accountId","createdAt" DESC);
CREATE FUNCTION raid_notification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Notification is append-only' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'readAt') IS DISTINCT FROM (to_jsonb(OLD)-'readAt') OR (OLD."readAt" IS NOT NULL AND NEW."readAt" IS DISTINCT FROM OLD."readAt") THEN
  RAISE EXCEPTION 'Notification is append-only apart from its first read' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Notification_guard" BEFORE UPDATE OR DELETE ON "Notification" FOR EACH ROW EXECUTE FUNCTION raid_notification_guard();
-- Optional discovery/promotional messages are opt-in; transactional work notifications are not preferences.
CREATE TABLE "NotificationPreference" (
 "accountId" text PRIMARY KEY REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "promotional" boolean NOT NULL DEFAULT false,
 "updatedAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp()
);
-- Marks each outbox event as handled. Missing markers are safe: the notification dedupe key still prevents duplicates.
CREATE TABLE "NotificationDispatch" (
 "outboxEventId" uuid PRIMARY KEY REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "processedAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp()
);
COMMIT;
