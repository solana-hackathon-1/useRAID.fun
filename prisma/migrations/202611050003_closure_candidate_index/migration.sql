-- Additive (#352 item 2): supports the scheduled closure pass's candidate selection; no data, guard or constraint
-- changes. Two partial indexes (plain CREATE INDEX inside the migration transaction, as in earlier index migrations)
-- and one read-only helper.
BEGIN;
-- The pass scans only active engagements, then reads each one's effective terms once.
CREATE INDEX "Engagement_active_idx" ON "Engagement"("id") WHERE "state" IN ('ACCESS_PENDING','IN_PROGRESS','SUBMITTED','REVISION_REQUESTED');
-- raid_effective_terms reads the newest ACCEPTED amendment of one engagement.
CREATE INDEX "EngagementAmendment_accepted_idx" ON "EngagementAmendment"("engagementId","sequence" DESC) WHERE "state"='ACCEPTED';
-- A stored deadline that is not a timestamp must not abort the whole candidate query: it yields NULL so the pass can
-- report that one engagement and keep selecting the rest. Same cast the closure guard uses for a valid value.
CREATE FUNCTION raid_try_timestamptz(raw text) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
BEGIN
 RETURN raw::timestamptz;
EXCEPTION WHEN data_exception THEN
 RETURN NULL;
END
$$;
COMMIT;
