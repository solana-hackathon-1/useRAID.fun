BEGIN;
-- A slot reservation and an amendment reservation are distinct funds. The BEFORE guards from 202610260006 read only
-- committed rows, so two READ COMMITTED writers handed the same reference could both pass. These AFTER triggers take a
-- transaction-scoped lock on the reference and then re-read, so the later writer sees the earlier one's committed row.
CREATE FUNCTION raid_amendment_funding_serialize() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."additionalFundingRef" IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('raid:funding-reference:'||NEW."additionalFundingRef",0));
  IF EXISTS (SELECT 1 FROM "RaidSlot" WHERE "fundingRef"=NEW."additionalFundingRef") THEN
   RAISE EXCEPTION 'Funding reference is already reserved for a slot' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER "EngagementAmendment_funding_serialize" AFTER INSERT ON "EngagementAmendment" FOR EACH ROW EXECUTE FUNCTION raid_amendment_funding_serialize();

CREATE FUNCTION raid_slot_funding_serialize() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."fundingRef" IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('raid:funding-reference:'||NEW."fundingRef",0));
  IF EXISTS (SELECT 1 FROM "EngagementAmendment" WHERE "additionalFundingRef"=NEW."fundingRef") THEN
   RAISE EXCEPTION 'Funding reference is already reserved for an amendment' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER "RaidSlot_funding_serialize" AFTER INSERT OR UPDATE OF "fundingRef" ON "RaidSlot" FOR EACH ROW EXECUTE FUNCTION raid_slot_funding_serialize();
COMMIT;
