-- Ledger links, money vocabularies, deferred conservation and append-only guards.
-- BalanceEntry is already append-only (balance_entry_immutable) and the four FKs owned by
-- 202610020001 are not repeated here.

ALTER TABLE "BalanceEntry" ADD CONSTRAINT "BalanceEntry_kind_check" CHECK ("kind" IN ('DEPOSIT','WITHDRAWAL','WITHDRAWAL_RESERVED','WITHDRAWAL_RELEASED','RAID_RESERVED','RAID_SETTLED','RAID_RELEASED','RAID_REWARD_CREDIT','TEST_FUNDS'));
ALTER TABLE "UsdcTransfer" ADD CONSTRAINT "UsdcTransfer_kind_check" CHECK ("kind" IN ('DEPOSIT','WITHDRAWAL','REWARD','REWARD_CREDIT'));
ALTER TABLE "UsdcTransfer" ADD CONSTRAINT "UsdcTransfer_status_check" CHECK ("status" IN ('AWAITING_TRANSFER','REQUESTED','PAID','REJECTED'));
ALTER TABLE "RaidAllocation" ADD CONSTRAINT "RaidAllocation_kind_check" CHECK ("kind" IN ('REWARD','REFUND'));

ALTER TABLE "BalanceEntry" ADD CONSTRAINT "BalanceEntry_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BalanceEntry" ADD CONSTRAINT "BalanceEntry_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "UsdcTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsdcTransfer" ADD CONSTRAINT "UsdcTransfer_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "UsdcAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsdcAllocation" ADD CONSTRAINT "UsdcAllocation_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "CampaignResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RaidAllocation" ADD CONSTRAINT "RaidAllocation_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "CampaignResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "BalanceEntry_raidId_idx" ON "BalanceEntry"("raidId");
CREATE INDEX "UsdcAllocation_resultId_idx" ON "UsdcAllocation"("resultId");
CREATE INDEX "RaidAllocation_resultId_idx" ON "RaidAllocation"("resultId");

CREATE FUNCTION check_balance_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  raid "Raid"%ROWTYPE;
  transfer "UsdcTransfer"%ROWTYPE;
  available numeric;
  reserved numeric;
  allocated numeric;
  expected text;
BEGIN
  SELECT COALESCE(SUM("availableDelta"), 0), COALESCE(SUM("reservedDelta"), 0)
    INTO available, reserved
    FROM "BalanceEntry" WHERE "userId" = NEW."userId" AND "network" = NEW."network";
  IF available < 0 OR reserved < 0 THEN
    RAISE EXCEPTION 'Ledger entry % would leave a negative balance for user % on %', NEW."key", NEW."userId", NEW."network"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."kind" IN ('RAID_RESERVED', 'RAID_SETTLED', 'RAID_RELEASED', 'RAID_REWARD_CREDIT') THEN
    IF NEW."raidId" IS NULL THEN
      RAISE EXCEPTION 'Ledger entry % requires a raid', NEW."key" USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO raid FROM "Raid" WHERE "id" = NEW."raidId";
  END IF;

  IF NEW."kind" IN ('RAID_RESERVED', 'RAID_SETTLED', 'RAID_RELEASED') THEN
    IF raid."poolUnits" IS NULL OR raid."creatorId" <> NEW."userId" OR raid."fundingNetwork" <> NEW."network" THEN
      RAISE EXCEPTION 'Ledger entry % does not match the funded pool of raid %', NEW."key", NEW."raidId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."kind" = 'RAID_RESERVED' THEN
    IF NEW."reservedDelta" <> raid."poolUnits" OR NEW."availableDelta" <> -raid."poolUnits" THEN
      RAISE EXCEPTION 'Raid reservation % must move exactly the pool', NEW."key" USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'RAID_SETTLED' THEN
    SELECT COALESCE(SUM("amount"), 0) INTO allocated FROM "UsdcAllocation" WHERE "raidId" = NEW."raidId";
    IF NEW."reservedDelta" <> -raid."poolUnits" OR NEW."availableDelta" + allocated <> raid."poolUnits" THEN
      RAISE EXCEPTION 'Raid settlement % does not conserve the pool', NEW."key" USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" = 'RAID_RELEASED' THEN
    IF NEW."reservedDelta" <> -raid."poolUnits" OR NEW."availableDelta" <> raid."poolUnits"
       OR EXISTS (SELECT 1 FROM "UsdcAllocation" WHERE "raidId" = NEW."raidId") THEN
      RAISE EXCEPTION 'Raid release % must return the whole unallocated pool', NEW."key" USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."kind" IN ('RAID_SETTLED', 'RAID_RELEASED') AND
     (SELECT count(*) FROM "BalanceEntry" WHERE "raidId" = NEW."raidId" AND "kind" IN ('RAID_SETTLED', 'RAID_RELEASED')) <> 1 THEN
    RAISE EXCEPTION 'Raid % can release its pool only once', NEW."raidId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'RAID_RESERVED' AND
     (SELECT count(*) FROM "BalanceEntry" WHERE "raidId" = NEW."raidId" AND "kind" = 'RAID_RESERVED') <> 1 THEN
    RAISE EXCEPTION 'Raid % can reserve its pool only once', NEW."raidId" USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."kind" = 'RAID_REWARD_CREDIT' THEN
    SELECT * INTO transfer FROM "UsdcTransfer" WHERE "id" = NEW."transferId";
    SELECT COALESCE(SUM(t."amount"), 0) INTO allocated
      FROM "UsdcTransfer" t JOIN "UsdcAllocation" a ON a."id" = t."allocationId"
      WHERE t."kind" = 'REWARD_CREDIT' AND a."raidId" = NEW."raidId" AND a."userId" = NEW."userId";
    IF transfer."id" IS NULL OR transfer."kind" <> 'REWARD_CREDIT' OR transfer."userId" <> NEW."userId"
       OR transfer."network" <> NEW."network" OR NEW."reservedDelta" <> 0 OR NEW."availableDelta" <> allocated THEN
      RAISE EXCEPTION 'Reward credit % must equal the credited allocations', NEW."key" USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."kind" IN ('DEPOSIT', 'WITHDRAWAL', 'WITHDRAWAL_RESERVED', 'WITHDRAWAL_RELEASED') THEN
    IF NEW."transferId" IS NULL THEN
      IF NEW."kind" <> 'DEPOSIT' OR NEW."network" <> 'sandbox' OR NEW."availableDelta" <= 0 OR NEW."reservedDelta" <> 0 THEN
        RAISE EXCEPTION 'Ledger entry % requires a transfer', NEW."key" USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT * INTO transfer FROM "UsdcTransfer" WHERE "id" = NEW."transferId";
      expected := 'WITHDRAWAL';
      IF NEW."kind" = 'DEPOSIT' THEN expected := 'DEPOSIT'; END IF;
      IF transfer."userId" <> NEW."userId" OR transfer."network" <> NEW."network"
         OR transfer."kind" <> expected
         OR (NEW."kind" = 'DEPOSIT' AND (NEW."availableDelta" <> transfer."amount" OR NEW."reservedDelta" <> 0))
         OR (NEW."kind" = 'WITHDRAWAL' AND (NEW."availableDelta" <> 0 OR NEW."reservedDelta" <> -transfer."amount"))
         OR (NEW."kind" = 'WITHDRAWAL_RESERVED' AND (NEW."availableDelta" <> -transfer."amount" OR NEW."reservedDelta" <> transfer."amount"))
         OR (NEW."kind" = 'WITHDRAWAL_RELEASED' AND (NEW."availableDelta" <> transfer."amount" OR NEW."reservedDelta" <> -transfer."amount")) THEN
        RAISE EXCEPTION 'Ledger entry % does not match transfer %', NEW."key", NEW."transferId" USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."kind" = 'TEST_FUNDS' THEN
    IF NEW."network" <> 'sandbox' OR NEW."transferId" IS NOT NULL OR NEW."availableDelta" <= 0 OR NEW."reservedDelta" <> 0 THEN
      RAISE EXCEPTION 'Test funds exist only on the sandbox network' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balance_entry_conserved AFTER INSERT ON "BalanceEntry"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balance_entry();

CREATE FUNCTION reject_money_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER usdc_allocation_append_only BEFORE DELETE ON "UsdcAllocation"
FOR EACH ROW EXECUTE FUNCTION reject_money_mutation();
CREATE TRIGGER usdc_allocation_immutable BEFORE UPDATE ON "UsdcAllocation"
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION reject_money_mutation();
CREATE TRIGGER moderation_event_append_only BEFORE DELETE ON "ModerationEvent"
FOR EACH ROW EXECUTE FUNCTION reject_money_mutation();
CREATE TRIGGER moderation_event_immutable BEFORE UPDATE ON "ModerationEvent"
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION reject_money_mutation();
CREATE TRIGGER raid_enrollment_append_only BEFORE DELETE ON "RaidEnrollment"
FOR EACH ROW EXECUTE FUNCTION reject_money_mutation();
CREATE TRIGGER raid_enrollment_immutable BEFORE UPDATE ON "RaidEnrollment"
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION reject_money_mutation();
CREATE TRIGGER raid_allocation_append_only BEFORE DELETE ON "RaidAllocation"
FOR EACH ROW EXECUTE FUNCTION reject_money_mutation();

CREATE FUNCTION guard_raid_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."signature" IS NOT NULL OR NEW."signature" IS NULL OR NEW."paidAt" IS NULL OR OLD."paidAt" IS NOT NULL
     OR (NEW."id", NEW."raidId", NEW."resultId", NEW."kind", NEW."xId", NEW."walletAddress", NEW."lamports")
        IS DISTINCT FROM (OLD."id", OLD."raidId", OLD."resultId", OLD."kind", OLD."xId", OLD."walletAddress", OLD."lamports") THEN
    RAISE EXCEPTION 'RaidAllocation is immutable except for its first payment record'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER raid_allocation_guard BEFORE UPDATE ON "RaidAllocation"
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION guard_raid_allocation();

CREATE FUNCTION guard_usdc_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'AWAITING_TRANSFER' THEN
      RAISE EXCEPTION 'Only an unpaid deposit intent can be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."id", NEW."userId", NEW."kind", NEW."amount", NEW."walletAddress", NEW."recipient", NEW."network", NEW."mint", NEW."allocationId", NEW."createdAt", NEW."expiresAt")
       IS DISTINCT FROM (OLD."id", OLD."userId", OLD."kind", OLD."amount", OLD."walletAddress", OLD."recipient", OLD."network", OLD."mint", OLD."allocationId", OLD."createdAt", OLD."expiresAt")
     OR (OLD."status" <> NEW."status" AND NOT (OLD."status" IN ('AWAITING_TRANSFER', 'REQUESTED') AND NEW."status" IN ('PAID', 'REJECTED')))
     OR (OLD."signature" IS NOT NULL AND NEW."signature" IS DISTINCT FROM OLD."signature")
     OR (OLD."paidAt" IS NOT NULL AND NEW."paidAt" IS DISTINCT FROM OLD."paidAt") THEN
    RAISE EXCEPTION 'UsdcTransfer identity and settled state are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER usdc_transfer_delete_guard BEFORE DELETE ON "UsdcTransfer"
FOR EACH ROW EXECUTE FUNCTION guard_usdc_transfer();
CREATE TRIGGER usdc_transfer_update_guard BEFORE UPDATE ON "UsdcTransfer"
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION guard_usdc_transfer();

CREATE FUNCTION guard_raid_money() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous integer;
BEGIN
  IF OLD."fundingStatus" = 'VERIFIED' AND
     (NEW."poolUnits", NEW."quoteRate", NEW."fundingAsset", NEW."fundingNetwork", NEW."fundingRecipient", NEW."fundingLamports", NEW."fundingWallet", NEW."fundingSignature", NEW."impressionTarget", NEW."authorCapBps", NEW."creatorId")
     IS DISTINCT FROM
     (OLD."poolUnits", OLD."quoteRate", OLD."fundingAsset", OLD."fundingNetwork", OLD."fundingRecipient", OLD."fundingLamports", OLD."fundingWallet", OLD."fundingSignature", OLD."impressionTarget", OLD."authorCapBps", OLD."creatorId") THEN
    RAISE EXCEPTION 'The funding terms of a verified Raid are frozen' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."trackingPhase" IN ('ALLOCATED', 'HELD_RESOLVED') AND
     (NEW."trackingPhase", NEW."activeResultId") IS DISTINCT FROM (OLD."trackingPhase", OLD."activeResultId") THEN
    RAISE EXCEPTION 'A settled Raid cannot change phase or result' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."activeResultId" IS NOT NULL AND NEW."activeResultId" IS DISTINCT FROM OLD."activeResultId" THEN
    SELECT "version" INTO previous FROM "CampaignResult" WHERE "id" = OLD."activeResultId";
    IF NOT EXISTS (
      SELECT 1 FROM "CampaignResult" WHERE "id" = NEW."activeResultId" AND "raidId" = NEW."id"
        AND ("version" > previous OR previous IS NULL)
    ) THEN
      RAISE EXCEPTION 'The active result must be a newer result of the same Raid' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER raid_money_guard BEFORE UPDATE ON "Raid"
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION guard_raid_money();
