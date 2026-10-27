BEGIN;
-- Reward vectors use schema-validated strings/booleans/integer decimals and ASCII object keys.
-- Match the command-receipt canonical JSON without jsonb's presentation whitespace.
CREATE FUNCTION raid_work_reward_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||raid_work_reward_json(val),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) AS entries(key,val);
 WHEN 'array' THEN
  SELECT '['||coalesce(string_agg(raid_work_reward_json(val),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS entries(val,ordinal);
 ELSE result:=value::text;
 END CASE;
 RETURN result;
END $$;
CREATE FUNCTION raid_work_reward_digest(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(E'raid.command-receipts.v1\n'||raid_work_reward_json(value),'UTF8')),'hex')
$$;
ALTER TABLE "WorkSimulatedReservation" ADD COLUMN "fundingRef" text;
-- Existing audit rows prove only their recorded vector and the original built-in adapter's reference.
-- Refuse inconsistent/missing history instead of fabricating coverage for previously opened slots.
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM "RaidSlot" s LEFT JOIN "WorkSimulatedReservation" r ON r."slotId"=s."id"
  LEFT JOIN "TermsVersion" t ON t."id"=s."termsVersionId"
  WHERE s."fundingRef" IS NOT NULL AND (r."slotId" IS NULL OR s."fundingRef" IS DISTINCT FROM 'sim-reservation:'||s."id"::text
   OR r."legs" IS DISTINCT FROM t."snapshot"->'rewards' OR r."vectorDigest" IS DISTINCT FROM raid_work_reward_digest(r."legs"))
 ) OR EXISTS (SELECT 1 FROM "WorkSimulatedReservation" r JOIN "RaidSlot" s ON s."id"=r."slotId" WHERE s."fundingRef" IS NULL) THEN
  RAISE EXCEPTION 'Historical reservation binding requires reconciliation' USING ERRCODE='23514';
 END IF;
END $$;
DROP TRIGGER "WorkSimulatedReservation_immutable" ON "WorkSimulatedReservation";
UPDATE "WorkSimulatedReservation" r SET "fundingRef"=s."fundingRef" FROM "RaidSlot" s WHERE s."id"=r."slotId";
CREATE TRIGGER "WorkSimulatedReservation_immutable" BEFORE UPDATE OR DELETE ON "WorkSimulatedReservation" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
ALTER TABLE "WorkSimulatedReservation" ALTER COLUMN "fundingRef" SET NOT NULL;
ALTER TABLE "WorkSimulatedReservation" ADD CONSTRAINT "WorkSimulatedReservation_fundingRef_key" UNIQUE ("fundingRef");
ALTER TABLE "WorkSimulatedReservation" ADD CONSTRAINT "WorkSimulatedReservation_exactVector_check" CHECK ("vectorDigest"=raid_work_reward_digest("legs"));
CREATE FUNCTION raid_work_reservation_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='RaidSlot' THEN target:=NEW."id"; ELSE target:=NEW."slotId"; END IF;
 IF EXISTS (
  SELECT 1 FROM "RaidSlot" s LEFT JOIN "WorkSimulatedReservation" r ON r."slotId"=s."id"
  JOIN "TermsVersion" t ON t."id"=s."termsVersionId"
  WHERE s."id"=target AND (s."fundingRef" IS NOT NULL OR r."slotId" IS NOT NULL)
   AND (r."slotId" IS NULL OR s."fundingRef" IS DISTINCT FROM r."fundingRef"
    OR s."termsVersionId" IS DISTINCT FROM r."termsVersionId" OR r."legs" IS DISTINCT FROM t."snapshot"->'rewards')
 ) THEN RAISE EXCEPTION 'Exact reservation binding required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "RaidSlot_reservation_binding" AFTER INSERT OR UPDATE ON "RaidSlot" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_work_reservation_binding();
CREATE CONSTRAINT TRIGGER "WorkSimulatedReservation_binding" AFTER INSERT ON "WorkSimulatedReservation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_work_reservation_binding();
COMMIT;
