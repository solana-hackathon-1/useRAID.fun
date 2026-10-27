BEGIN;
-- A person's explicit, append-only consent to the exact terms of one available slot (blueprint §10.2, §23.4).
-- It binds participant, slot, terms version and the stored terms digest, and grants nothing by itself: acceptance
-- still rechecks eligibility, funding, capacity and the offer under its own locks.
CREATE TABLE "WorkAcceptanceConsent" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "participantId" uuid NOT NULL REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "slotId" uuid NOT NULL,
 "termsVersionId" uuid NOT NULL,
 "termsDigest" text NOT NULL CHECK ("termsDigest" ~ '^[0-9a-f]{64}$'),
 "consentedAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "WorkAcceptanceConsent_slot_fkey" FOREIGN KEY ("slotId","termsVersionId") REFERENCES "RaidSlot"("id","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "WorkAcceptanceConsent_subject_key" UNIQUE ("participantId","slotId","termsVersionId")
);
CREATE INDEX "WorkAcceptanceConsent_slotId_idx" ON "WorkAcceptanceConsent"("slotId");
CREATE FUNCTION raid_acceptance_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record;
BEGIN
 SELECT s."state",l."state" AS "listingState",l."currentTermsVersionId",t."digest" INTO STRICT source
  FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=s."termsVersionId"
  WHERE s."id"=NEW."slotId" AND s."termsVersionId"=NEW."termsVersionId";
 IF source."state"<>'AVAILABLE' OR source."listingState"<>'OPEN' OR source."currentTermsVersionId"<>NEW."termsVersionId" THEN
  RAISE EXCEPTION 'Consent requires an available slot on the current terms' USING ERRCODE='23514';
 END IF;
 IF source."digest" IS DISTINCT FROM NEW."termsDigest" THEN
  RAISE EXCEPTION 'Consent must name the exact stored terms digest' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WorkAcceptanceConsent_guard" BEFORE INSERT ON "WorkAcceptanceConsent" FOR EACH ROW EXECUTE FUNCTION raid_acceptance_consent_guard();
CREATE TRIGGER "WorkAcceptanceConsent_immutable" BEFORE UPDATE OR DELETE ON "WorkAcceptanceConsent" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
COMMIT;
