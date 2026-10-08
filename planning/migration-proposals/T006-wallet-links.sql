-- PROPOSED / NOT REVIEWED / NOT APPLIED.
-- Review docs/tasks/T006-wallet-link-plan.md before copying this into a forward
-- Prisma migration (later prefix: 202610090003_wallet_links). This file lives
-- outside prisma/migrations deliberately: ordinary CI must not execute unapproved
-- DDL while the contract is pending.
--
-- Purpose: let one canonical account hold additional VERIFIED wallet credentials
-- (login/identity links) without changing the legacy "WalletIdentity" row, which
-- remains the single payout/funding-bound wallet (blueprint 16.13). Wallet address
-- is a credential, never a person ID. Linking moves no money and no destination.
--
-- Additive only: no existing table is dropped or rewritten; no existing row is
-- touched; no backfill. The 19 applied migrations (including
-- 202610080001_participant_mapping) are preserved byte-for-byte.
--
-- Depends on: "User", "Participant" (202610080001), "WalletIdentity" (legacy),
-- and pgcrypto-free gen_random_uuid() (PostgreSQL >= 13, already used there).
--
-- Isolation contract for callers: READ COMMITTED. The exclusivity trigger relies on
-- a per-statement snapshot after taking a transaction-scoped advisory lock; under
-- REPEATABLE READ/SERIALIZABLE it could miss a concurrently committed row, so the
-- application port must reject those isolation levels (as identity-storage v1 does).
BEGIN;

-- 1. Composite-FK anchor: a link's participant must be that same account's own
--    participant. Participant rows are immutable, so this index never changes.
CREATE UNIQUE INDEX "Participant_id_accountId_key"
  ON "Participant" ("id", "accountId");

-- 2. Additional verified wallet links. WalletIdentity (legacy, one per account,
--    payout-bound) is NOT mirrored here; this table holds ADDITIONAL links only.
CREATE TABLE "WalletLink" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" TEXT NOT NULL,
  "participantId" UUID NOT NULL,
  "networkIdentity" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "proofRef" TEXT NOT NULL,
  "verifiedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMPTZ(6),
  "linkActorAccountId" TEXT NOT NULL,
  "linkRequestId" TEXT NOT NULL,
  CONSTRAINT "WalletLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletLink_network_check" CHECK (
    char_length("networkIdentity") BETWEEN 1 AND 200
    AND "networkIdentity" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  -- Base58 Solana public key text length; exact 32-byte decode stays in the
  -- application (shared SolanaAddress contract). Defence in depth only.
  CONSTRAINT "WalletLink_address_check" CHECK (
    "address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  ),
  CONSTRAINT "WalletLink_status_check" CHECK ("status" IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT "WalletLink_revoked_check" CHECK (
    ("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)
  ),
  CONSTRAINT "WalletLink_proof_check" CHECK (
    char_length("proofRef") BETWEEN 1 AND 200
    AND "proofRef" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "WalletLink_actor_check" CHECK ("linkActorAccountId" = "accountId"),
  CONSTRAINT "WalletLink_request_check" CHECK (
    char_length("linkRequestId") BETWEEN 1 AND 200
    AND "linkRequestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "WalletLink_accountId_fkey" FOREIGN KEY ("accountId")
    REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "WalletLink_participant_fkey" FOREIGN KEY ("participantId", "accountId")
    REFERENCES "Participant" ("id", "accountId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- One account owns a given address, ever. Conservative on purpose: uniqueness is on
-- address alone (legacy WalletIdentity.address is also network-less). A REVOKED row
-- keeps the subject reserved so a removed wallet cannot be silently reassigned
-- (D13). Relaxing this later is a migration; tightening later is not safe.
CREATE UNIQUE INDEX "WalletLink_address_key" ON "WalletLink" ("address");
-- One verified proof creates at most one link: durable replay barrier that survives
-- the pruning of consumed WalletChallenge rows (no FK to that table on purpose).
CREATE UNIQUE INDEX "WalletLink_proofRef_key" ON "WalletLink" ("proofRef");
CREATE INDEX "WalletLink_accountId_status_idx" ON "WalletLink" ("accountId", "status");

-- 3. Row guard: links are never deleted; the only permitted mutation is
--    ACTIVE -> REVOKED (with revokedAt) leaving every other column unchanged.
--    No-op updates are allowed. Reactivation is a separate, undefined recovery
--    process (O11) and is therefore impossible here.
CREATE FUNCTION raid_wallet_link_guard_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Wallet link requires reviewed recovery or retention'
      USING ERRCODE = '23000';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'ACTIVE'
     AND NEW."status" = 'REVOKED'
     AND NEW."revokedAt" IS NOT NULL
     AND (NEW."id", NEW."accountId", NEW."participantId", NEW."networkIdentity",
          NEW."address", NEW."proofRef", NEW."verifiedAt",
          NEW."linkActorAccountId", NEW."linkRequestId")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."accountId", OLD."participantId", OLD."networkIdentity",
          OLD."address", OLD."proofRef", OLD."verifiedAt",
          OLD."linkActorAccountId", OLD."linkRequestId") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Wallet link is immutable except ACTIVE to REVOKED'
    USING ERRCODE = '23000';
END;
$$;

CREATE TRIGGER wallet_link_guard_v1
BEFORE UPDATE OR DELETE ON "WalletLink"
FOR EACH ROW EXECUTE FUNCTION raid_wallet_link_guard_v1();

-- 4. Cross-table address exclusivity between the legacy WalletIdentity (primary,
--    payout-bound) and WalletLink (additional). Both triggers take the SAME
--    transaction-scoped advisory lock key the application takes, then check the
--    other table in a fresh READ COMMITTED statement, so check-then-insert is
--    race-safe even for old application binaries that know nothing about links.
--    SQLSTATE 23505 + CONSTRAINT name let the adapter classify IDENTITY_CONFLICT.
CREATE FUNCTION raid_wallet_subject_exclusive_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('wallet-subject:' || NEW."address", 0));
  IF TG_TABLE_NAME = 'WalletLink' THEN
    IF EXISTS (SELECT 1 FROM "WalletIdentity" WHERE "address" = NEW."address") THEN
      RAISE EXCEPTION 'Wallet subject already belongs to an account'
        USING ERRCODE = '23505', CONSTRAINT = 'raid_wallet_subject_exclusive_v1';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "WalletLink" WHERE "address" = NEW."address") THEN
      RAISE EXCEPTION 'Wallet subject already belongs to an account'
        USING ERRCODE = '23505', CONSTRAINT = 'raid_wallet_subject_exclusive_v1';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_link_subject_exclusive_v1
BEFORE INSERT ON "WalletLink"
FOR EACH ROW EXECUTE FUNCTION raid_wallet_subject_exclusive_v1();

-- Fires on legacy sign-in creation, link and rotation. UPDATE OF "address" only:
-- the legacy account merge re-points "userId" and must not be slowed or blocked.
CREATE TRIGGER wallet_identity_subject_exclusive_v1
BEFORE INSERT OR UPDATE OF "address" ON "WalletIdentity"
FOR EACH ROW EXECUTE FUNCTION raid_wallet_subject_exclusive_v1();

COMMIT;

-- ROLLBACK LIMITS (documentation, intentionally not executed):
--   Application rollback MUST keep "WalletLink", its FKs and all three triggers once
--   any link has been acknowledged to a user. Dropping them is lossy (removes the
--   record of which extra wallets an account verified), reopens address reuse by a
--   different account, and strands sign-in for those wallets. Because links never
--   change the payout/funding wallet or any ledger row, no money is lost by either
--   keeping or dropping them. A lossy drop requires an owner-approved recovery plan
--   after exporting the table; the exclusivity trigger on "WalletIdentity" is a
--   fence and should be dropped last, never first.
--   DROP TRIGGER wallet_identity_subject_exclusive_v1 ON "WalletIdentity";
--   DROP TABLE "WalletLink";  -- cascades its triggers/indexes
--   DROP FUNCTION raid_wallet_subject_exclusive_v1();
--   DROP FUNCTION raid_wallet_link_guard_v1();
--   DROP INDEX "Participant_id_accountId_key";
