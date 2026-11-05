-- Additive hardening of the acceptance-consent insert guard (#275 item 3). No table, column or data change; the guard
-- function from 202610270006 is replaced with CREATE OR REPLACE, so that applied migration is untouched.
--
-- 1. A consent that names no slot, or a slot on a different terms version, now fails like the composite foreign key it
--    stands in front of (SQLSTATE 23503, constraint WorkAcceptanceConsent_slot_fkey) instead of SELECT ... INTO STRICT's
--    no_data_found (P0002), which no caller could tell apart from a defect.
-- 2. The guard now holds WorkListing then RaidSlot FOR SHARE until the consent commits, the same listing-before-slot
--    order every slot writer uses (engagement insert guard, acceptance, amendments). A concurrent fill therefore waits for
--    the consent transaction and a consent that starts after the fill is refused (23514), so no consent commits for a slot
--    that was filled in between its check and its commit.
BEGIN;
CREATE OR REPLACE FUNCTION raid_acceptance_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; listing uuid;
BEGIN
 SELECT "listingId" INTO listing FROM "RaidSlot" WHERE "id"=NEW."slotId" AND "termsVersionId"=NEW."termsVersionId";
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Consent must name an existing slot on the exact terms version' USING ERRCODE='23503', CONSTRAINT='WorkAcceptanceConsent_slot_fkey';
 END IF;
 PERFORM 1 FROM "WorkListing" WHERE "id"=listing FOR SHARE;
 PERFORM 1 FROM "RaidSlot" WHERE "id"=NEW."slotId" FOR SHARE;
 SELECT s."state",l."state" AS "listingState",l."currentTermsVersionId",t."digest" INTO source
  FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=s."termsVersionId"
  WHERE s."id"=NEW."slotId" AND s."termsVersionId"=NEW."termsVersionId";
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Consent must name an existing slot on the exact terms version' USING ERRCODE='23503', CONSTRAINT='WorkAcceptanceConsent_slot_fkey';
 END IF;
 IF source."state"<>'AVAILABLE' OR source."listingState"<>'OPEN' OR source."currentTermsVersionId"<>NEW."termsVersionId" THEN
  RAISE EXCEPTION 'Consent requires an available slot on the current terms' USING ERRCODE='23514';
 END IF;
 IF source."digest" IS DISTINCT FROM NEW."termsDigest" THEN
  RAISE EXCEPTION 'Consent must name the exact stored terms digest' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
