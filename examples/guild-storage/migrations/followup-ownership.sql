-- Additive Guild ownership hardening from review follow-up #294 item 11. No table, column or data change. Applied
-- migrations are untouched: the decision CHECK is replaced and the commit-time guard is replaced with CREATE OR REPLACE.
BEGIN;

-- The decision CHECK stated one identical clause for EXPIRED and another for ACCEPTED/DECLINED/WITHDRAWN. Same rule,
-- stated once: a decided transfer records when, by whom and under which command receipt.
ALTER TABLE "GuildOwnershipTransfer" DROP CONSTRAINT "GuildOwnershipTransfer_decision_check";
ALTER TABLE "GuildOwnershipTransfer" ADD CONSTRAINT "GuildOwnershipTransfer_decision_check" CHECK (
 ("state"='PROPOSED' AND "decidedAt" IS NULL AND "decidedByAccountId" IS NULL AND "decideReceiptId" IS NULL)
 OR ("state" IN ('ACCEPTED','DECLINED','WITHDRAWN','EXPIRED') AND "decidedAt" IS NOT NULL AND "decidedByAccountId" IS NOT NULL AND "decideReceiptId" IS NOT NULL));

-- A lapse recorded by the Founder's next proposal is attributed to that proposal: the receipt must be the proposing
-- Founder's own and must have created a successor transfer in the same Guild. Before, any ProposeOwnershipTransfer
-- receipt of the account (including the lapsed proposal's own) satisfied the guard. Otherwise unchanged from 202610270009.
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
           AND EXISTS (SELECT 1 FROM "GuildOwnershipTransfer" n WHERE n."id"<>t."id" AND n."id"::text=c."resultRef" AND n."guildId"=t."guildId" AND n."proposeReceiptId"=c."id")))) THEN
  RAISE EXCEPTION 'A Guild ownership transfer decision needs the deciding account''s command receipt' USING ERRCODE='23000';
 END IF;
 RETURN NULL;
END;
$$;
COMMIT;
