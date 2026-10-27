BEGIN;
-- Initialize on the first enabled event pass, not at migration time. State and markers commit atomically.
-- No watermark: an event from an older transaction that commits later must still be delivered.
CREATE TABLE "NotificationDispatchInitialization" (
 "key" text PRIMARY KEY CHECK ("key"='work.v1'),
 "initializedAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp()
);
-- Existing processed markers prove the previous dispatcher was active: retain its pending backlog.
INSERT INTO "NotificationDispatchInitialization" ("key")
 SELECT 'work.v1' WHERE EXISTS (SELECT 1 FROM "NotificationDispatch");
CREATE TRIGGER "NotificationDispatchInitialization_immutable" BEFORE UPDATE OR DELETE ON "NotificationDispatchInitialization" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();

CREATE FUNCTION raid_notification_payload_values_valid(payload jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF payload ? 'engagementId' AND (
  jsonb_typeof(payload->'engagementId') IS DISTINCT FROM 'string'
  OR (payload->>'engagementId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 ) THEN RETURN false; END IF;
 IF payload ? 'deadline' THEN
  IF jsonb_typeof(payload->'deadline') IS DISTINCT FROM 'string'
   OR (payload->>'deadline') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
   THEN RETURN false; END IF;
  RETURN isfinite((payload->>'deadline')::timestamptz);
 END IF;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
-- Existing rows must meet the same contract; fail migration rather than rewrite historical facts.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_payload_values_check" CHECK (raid_notification_payload_values_valid("payload"));
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_readAt_check" CHECK ("readAt" IS NULL OR "readAt">="createdAt");
COMMIT;
