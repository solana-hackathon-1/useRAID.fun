-- DEC-2026-11-14-02 (#294 item 6): an accepted Guild ownership transfer stores the host's opaque re-verification
-- reference. Additive: one nullable column, two CHECKs and a replacement guard function. No row is rewritten.
BEGIN;

ALTER TABLE "GuildOwnershipTransfer" ADD COLUMN "verificationRef" TEXT;

-- The reference exists only on an ACCEPTED transfer and is 1-128 characters of [A-Za-z0-9._:-]. Every existing row has
-- a NULL reference, so this is valid for all of them and is validated now.
ALTER TABLE "GuildOwnershipTransfer" ADD CONSTRAINT "GuildOwnershipTransfer_verification_ref_check" CHECK (
 "verificationRef" IS NULL OR ("state"='ACCEPTED' AND "verificationRef" ~ '^[A-Za-z0-9._:-]{1,128}$'));

-- Every ACCEPTED transfer written from now on carries a reference. NOT VALID is deliberate: PostgreSQL then enforces the
-- CHECK on every later INSERT and UPDATE of any row but never scans or judges the rows that exist, so transfers accepted
-- before this migration stay untouched (they have no reference and are not rewritten). A trigger would need a cut-over
-- timestamp or id list to separate old rows from new ones; this needs none, and pg_dump/restore keep the constraint NOT
-- VALID. Never run VALIDATE CONSTRAINT on it: it would fail on those earlier rows by design. A decided transfer is
-- final (guard trigger), so an earlier ACCEPTED row is never updated and the CHECK never meets it again.
ALTER TABLE "GuildOwnershipTransfer" ADD CONSTRAINT "GuildOwnershipTransfer_verification_required_check" CHECK (
 "state"<>'ACCEPTED' OR "verificationRef" IS NOT NULL) NOT VALID;

-- Replaces the guard of 202610270009 with one change: the reference may be written together with the decision, so
-- `verificationRef` joins the columns a decision sets. It stays immutable afterwards (a decided transfer is final).
CREATE OR REPLACE FUNCTION raid_guild_transfer_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE founder text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Guild ownership transfers require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT "founderAccountId" INTO founder FROM "Guild" WHERE "id"=NEW."guildId";
  IF NEW."state"<>'PROPOSED' OR NEW."fromAccountId" IS DISTINCT FROM founder THEN
   RAISE EXCEPTION 'A Guild ownership transfer is proposed by the current Founder' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
 END IF;
 IF to_jsonb(NEW)-'state'-'decidedAt'-'decidedByAccountId'-'decideReceiptId'-'appliedAt'-'verificationRef'
    IS DISTINCT FROM to_jsonb(OLD)-'state'-'decidedAt'-'decidedByAccountId'-'decideReceiptId'-'appliedAt'-'verificationRef' THEN
  RAISE EXCEPTION 'Guild ownership transfer parties and window are immutable' USING ERRCODE='23000';
 END IF;
 IF OLD."state"='PROPOSED' AND NEW."state"<>'PROPOSED' AND NEW."appliedAt" IS NULL THEN RETURN NEW; END IF;
 IF OLD."state"='ACCEPTED' AND NEW."state"='ACCEPTED' AND OLD."appliedAt" IS NULL AND NEW."appliedAt" IS NOT NULL
    AND to_jsonb(NEW)-'appliedAt' = to_jsonb(OLD)-'appliedAt' THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A decided Guild ownership transfer is final' USING ERRCODE='23000';
END;
$$;
COMMIT;
