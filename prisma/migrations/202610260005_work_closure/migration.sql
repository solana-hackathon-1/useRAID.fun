BEGIN;
-- One immutable closure record per closed engagement. Closing ends the work duty and capacity; it never settles money.
CREATE TABLE "EngagementClosure" (
 "engagementId" uuid PRIMARY KEY REFERENCES "Engagement"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "reason" text NOT NULL CHECK ("reason" IN ('ACCEPTED','ACCESS_TIMEOUT','SUBMISSION_TIMEOUT','REVIEW_TIMEOUT','REVISION_TIMEOUT')),
 "finalState" text NOT NULL CHECK ("finalState" IN ('ACCEPTED','TERMINATED')),
 "closedByAccountId" text NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "financialResolution" text NOT NULL DEFAULT 'OPEN' CHECK ("financialResolution"='OPEN'),
 "closedAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "EngagementClosure_reason_state_check" CHECK (("reason"='ACCEPTED')=("finalState"='ACCEPTED'))
);
CREATE TRIGGER "EngagementClosure_immutable" BEFORE UPDATE OR DELETE ON "EngagementClosure" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
CREATE OR REPLACE FUNCTION raid_engagement_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Engagement history is immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'state'-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'revision') THEN
  RAISE EXCEPTION 'Accepted engagement terms and identity are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."revision"<>OLD."revision"+1 THEN
  RAISE EXCEPTION 'Engagement revision must advance exactly once per transition' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM (VALUES ('ACCESS_PENDING','IN_PROGRESS'),('IN_PROGRESS','SUBMITTED'),('REVISION_REQUESTED','SUBMITTED'),('SUBMITTED','REVISION_REQUESTED'),('SUBMITTED','ACCEPTED'),('ACCESS_PENDING','TERMINATED'),('IN_PROGRESS','TERMINATED'),('SUBMITTED','TERMINATED'),('REVISION_REQUESTED','TERMINATED')) AS allowed("fromState","toState") WHERE allowed."fromState"=OLD."state" AND allowed."toState"=NEW."state") THEN
  RAISE EXCEPTION 'Engagement transition % -> % is not permitted', OLD."state", NEW."state" USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
-- The closure is written while the engagement still holds its pre-closure state; the state change follows in the same transaction.
CREATE FUNCTION raid_closure_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; expected text;
BEGIN
 SELECT "state","acceptedTerms" INTO STRICT e FROM "Engagement" WHERE "id"=NEW."engagementId" FOR SHARE;
 expected:=CASE NEW."reason" WHEN 'ACCEPTED' THEN 'SUBMITTED' WHEN 'ACCESS_TIMEOUT' THEN 'ACCESS_PENDING' WHEN 'SUBMISSION_TIMEOUT' THEN 'IN_PROGRESS' WHEN 'REVIEW_TIMEOUT' THEN 'SUBMITTED' ELSE 'REVISION_REQUESTED' END;
 IF e."state" IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'Closure reason % does not match engagement state %', NEW."reason", e."state" USING ERRCODE='23514';
 END IF;
 IF NEW."reason"='ACCEPTED' THEN
  IF NOT EXISTS (SELECT 1 FROM "WorkReview" r JOIN "WorkSubmission" s ON s."id"=r."submissionId" WHERE s."engagementId"=NEW."engagementId" AND r."decision"='ACCEPT' AND s."submissionNumber"=(SELECT max("submissionNumber") FROM "WorkSubmission" WHERE "engagementId"=NEW."engagementId")) THEN
   RAISE EXCEPTION 'Acceptance closure requires an ACCEPT review of the latest submission' USING ERRCODE='23514';
  END IF;
 ELSIF clock_timestamp()<(e."acceptedTerms"->'deadlines'->>'operationalClosure')::timestamptz THEN
  RAISE EXCEPTION 'Timeout closure is not due before the accepted operational deadline' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "EngagementClosure_insert_guard" BEFORE INSERT ON "EngagementClosure" FOR EACH ROW EXECUTE FUNCTION raid_closure_insert_guard();
-- Terminal state and closure record commit together, in both directions.
CREATE FUNCTION raid_closure_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; actual text;
BEGIN
 IF TG_TABLE_NAME='Engagement' THEN target:=NEW."id"; ELSE target:=NEW."engagementId"; END IF;
 SELECT "state" INTO STRICT actual FROM "Engagement" WHERE "id"=target;
 IF actual IN ('ACCEPTED','TERMINATED') AND NOT EXISTS (SELECT 1 FROM "EngagementClosure" WHERE "engagementId"=target AND "finalState"=actual) THEN
  RAISE EXCEPTION 'A closed engagement requires its matching closure record' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='EngagementClosure' THEN
  -- NEW is a closure row only in this branch; plpgsql resolves record fields per table, so keep it nested.
  PERFORM 1 FROM "EngagementClosure" c WHERE c."engagementId"=target AND c."finalState"=actual;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Closure record and engagement state must commit together' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Engagement_closure_state_guard" AFTER UPDATE OF "state" ON "Engagement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_closure_state_guard();
CREATE CONSTRAINT TRIGGER "EngagementClosure_state_guard" AFTER INSERT ON "EngagementClosure" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_closure_state_guard();
COMMIT;
