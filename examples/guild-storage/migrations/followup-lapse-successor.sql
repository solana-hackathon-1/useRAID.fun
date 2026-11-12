-- Additive Guild ownership hardening from review follow-up #438 item 1. No table, column or data change. Applied
-- migrations are untouched (202611130001 stays as released): the commit-time guard is replaced with CREATE OR REPLACE.
BEGIN;

-- A lapse recorded by the Founder's next proposal must be recorded by a successor proposed at or after the lapsed
-- transfer's expiry. Before, any other proposal of the same Founder in the same Guild, including an older one, satisfied
-- the guard. Otherwise unchanged from 202611130001. Existing rows are not re-validated.
CREATE OR REPLACE FUNCTION raid_guild_transfer_applied_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
 SELECT * INTO t FROM "GuildOwnershipTransfer" WHERE "id"=NEW."id";
 IF t."state"='ACCEPTED' AND (t."appliedAt" IS NULL OR NOT EXISTS (SELECT 1 FROM "Guild" g WHERE g."id"=t."guildId" AND g."founderAccountId"=t."toAccountId")) THEN
  RAISE EXCEPTION 'An accepted Guild ownership transfer must be applied to the Guild' USING ERRCODE='23000';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "CommandReceipt" c WHERE c."id"=t."proposeReceiptId" AND c."actorId"=t."fromAccountId"
     AND c."commandKind"='ProposeOwnershipTransfer' AND c."resultRef"=t."id"::text) THEN
  RAISE EXCEPTION 'A Guild ownership transfer needs its proposing Founder''s command receipt' USING ERRCODE='23000';
 END IF;
 IF t."state"<>'PROPOSED' AND NOT EXISTS (SELECT 1 FROM "CommandReceipt" c WHERE c."id"=t."decideReceiptId" AND c."actorId"=t."decidedByAccountId"
     AND ((c."commandKind"='RespondOwnershipTransfer' AND c."resultRef"=t."id"::text)
       OR (t."state"='EXPIRED' AND c."commandKind"='ProposeOwnershipTransfer' AND c."actorId"=t."fromAccountId"
           AND EXISTS (SELECT 1 FROM "GuildOwnershipTransfer" n WHERE n."id"<>t."id" AND n."id"::text=c."resultRef" AND n."guildId"=t."guildId" AND n."proposeReceiptId"=c."id"
               AND n."proposedAt">=t."expiresAt")))) THEN
  RAISE EXCEPTION 'A Guild ownership transfer decision needs the deciding account''s command receipt' USING ERRCODE='23000';
 END IF;
 RETURN NULL;
END;
$$;
COMMIT;
