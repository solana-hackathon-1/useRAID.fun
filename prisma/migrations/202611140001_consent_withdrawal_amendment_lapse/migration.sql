-- Additive: DEC-2026-11-14-07 (#275 item 4) append-only acceptance-consent withdrawal, and DEC-2026-11-14-13 (#269
-- item 1) a LAPSED amendment state. No existing row or applied migration is rewritten.
BEGIN;

-- 1. Withdrawing an unused consent only reduces commitment. It is an append-only row beside the immutable consent, so
--    the consent history stays intact. At most one withdrawal exists per consent.
CREATE TABLE "WorkAcceptanceConsentWithdrawal" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "consentId" uuid NOT NULL REFERENCES "WorkAcceptanceConsent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "participantId" uuid NOT NULL REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "withdrawnAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "WorkAcceptanceConsentWithdrawal_consentId_key" UNIQUE ("consentId")
);
CREATE INDEX "WorkAcceptanceConsentWithdrawal_participantId_idx" ON "WorkAcceptanceConsentWithdrawal"("participantId");
CREATE TRIGGER "WorkAcceptanceConsentWithdrawal_immutable" BEFORE UPDATE OR DELETE ON "WorkAcceptanceConsentWithdrawal" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();

-- A withdrawal locks the consent row FOR UPDATE, so it serializes with any acceptance that holds the same row FOR SHARE
-- (the engagement guard below, and the Root host's consent read). Whichever commits first wins: a used consent (one an
-- engagement's roster already names) cannot be withdrawn, and the statement after the lock wait sees the committed engagement.
CREATE FUNCTION raid_acceptance_consent_withdrawal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE consent record;
BEGIN
 SELECT "participantId","slotId" INTO consent FROM "WorkAcceptanceConsent" WHERE "id"=NEW."consentId" FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A withdrawal must name an existing consent' USING ERRCODE='23503', CONSTRAINT='WorkAcceptanceConsentWithdrawal_consentId_fkey';
 END IF;
 IF consent."participantId" IS DISTINCT FROM NEW."participantId" THEN
  RAISE EXCEPTION 'Only the consenting participant can withdraw a consent' USING ERRCODE='23514';
 END IF;
 IF EXISTS (
  SELECT 1 FROM "Engagement" e
  WHERE e."slotId"=consent."slotId" AND jsonb_typeof(e."acceptedTerms"->'roster')='array'
   AND e."acceptedTerms"->'roster' @> jsonb_build_array(jsonb_build_object('consentRef', NEW."consentId"::text))) THEN
  RAISE EXCEPTION 'A used consent cannot be withdrawn' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WorkAcceptanceConsentWithdrawal_guard" BEFORE INSERT ON "WorkAcceptanceConsentWithdrawal" FOR EACH ROW EXECUTE FUNCTION raid_acceptance_consent_withdrawal_guard();

-- Backstop for the other direction: an engagement whose roster names a withdrawn consent is refused. The consent row is
-- read FOR SHARE (after the listing and slot locks the acceptance already holds), so a concurrent withdrawal waits for the
-- engagement to commit, and one that committed first is seen here. Roster references that are not a consent id are left to
-- their host.
CREATE FUNCTION raid_engagement_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref text;
BEGIN
 IF jsonb_typeof(NEW."acceptedTerms"->'roster') IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
 FOR ref IN SELECT m->>'consentRef' FROM jsonb_array_elements(NEW."acceptedTerms"->'roster') m LOOP
  IF ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   PERFORM 1 FROM "WorkAcceptanceConsent" WHERE "id"=ref::uuid FOR SHARE;
   IF FOUND AND EXISTS (SELECT 1 FROM "WorkAcceptanceConsentWithdrawal" WHERE "consentId"=ref::uuid) THEN
    RAISE EXCEPTION 'A withdrawn consent cannot back an engagement' USING ERRCODE='23514';
   END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER "Engagement_consent_guard" BEFORE INSERT ON "Engagement" FOR EACH ROW EXECUTE FUNCTION raid_engagement_consent_guard();

-- 2. A proposal whose proposer lost Founder authority is recorded as LAPSED by the next valid proposal. LAPSED is a
--    final decided state like DECLINED/WITHDRAWN: decided by an account, no consent reference, never effective.
ALTER TABLE "EngagementAmendment" DROP CONSTRAINT "EngagementAmendment_state_check";
ALTER TABLE "EngagementAmendment" ADD CONSTRAINT "EngagementAmendment_state_check" CHECK ("state" IN ('PROPOSED','ACCEPTED','DECLINED','WITHDRAWN','LAPSED'));
ALTER TABLE "EngagementAmendment" DROP CONSTRAINT "EngagementAmendment_decision_check";
ALTER TABLE "EngagementAmendment" ADD CONSTRAINT "EngagementAmendment_decision_check" CHECK (
  ("state"='PROPOSED' AND "decidedAt" IS NULL AND "decidedByAccountId" IS NULL AND "consentRef" IS NULL)
  OR ("state"='ACCEPTED' AND "decidedAt" IS NOT NULL AND "decidedByAccountId" IS NOT NULL AND "consentRef" IS NOT NULL)
  OR ("state" IN ('DECLINED','WITHDRAWN','LAPSED') AND "decidedAt" IS NOT NULL AND "decidedByAccountId" IS NOT NULL AND "consentRef" IS NULL));

CREATE OR REPLACE FUNCTION raid_amendment_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE engagement_state text; dl jsonb;
BEGIN
 IF (to_jsonb(NEW)-'state'-'decidedByAccountId'-'consentRef'-'decidedAt') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'decidedByAccountId'-'consentRef'-'decidedAt') THEN
  RAISE EXCEPTION 'Amendment content is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."state"<>'PROPOSED' THEN RAISE EXCEPTION 'A decided amendment is final' USING ERRCODE='23514'; END IF;
 IF NEW."state"='WITHDRAWN' THEN
  IF NEW."decidedByAccountId" IS DISTINCT FROM NEW."proposedByAccountId" THEN
   RAISE EXCEPTION 'Only the proposer can withdraw a proposal' USING ERRCODE='23514';
  END IF;
 ELSIF NEW."state"='LAPSED' THEN
  -- Only the listing's Founder (never an affected member) can lapse a proposal, by making a new one.
  IF NOT EXISTS (SELECT 1 FROM "Engagement" e JOIN "RaidSlot" s ON s."id"=e."slotId" JOIN "WorkListing" l ON l."id"=s."listingId" WHERE e."id"=NEW."engagementId" AND l."creatorAccountId"=NEW."decidedByAccountId")
   OR EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=NEW."engagementId" AND p."accountId"=NEW."decidedByAccountId") THEN
   RAISE EXCEPTION 'Only the listing Founder can lapse an orphaned proposal' USING ERRCODE='23514';
  END IF;
 ELSIF NEW."state" IN ('ACCEPTED','DECLINED') THEN
  IF NOT EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=NEW."engagementId" AND p."accountId"=NEW."decidedByAccountId") THEN
   RAISE EXCEPTION 'Only an affected member can consent to or decline an amendment' USING ERRCODE='23514';
  END IF;
  IF NEW."state"='ACCEPTED' THEN
   SELECT "state" INTO STRICT engagement_state FROM "Engagement" WHERE "id"=NEW."engagementId" FOR SHARE;
   IF engagement_state NOT IN ('ACCESS_PENDING','IN_PROGRESS') THEN
    RAISE EXCEPTION 'Only pending or in-progress work can accept an amendment' USING ERRCODE='23514';
   END IF;
   dl:=NEW."snapshot"->'deadlines';
   IF NEW."expiresAt"<=clock_timestamp() OR (dl->>'submission')::timestamptz<=clock_timestamp() OR (dl->>'operationalClosure')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'The proposal or its amended deadlines have expired' USING ERRCODE='23514';
   END IF;
  END IF;
 ELSE
  RAISE EXCEPTION 'A proposal can only be accepted, declined, withdrawn or lapsed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
