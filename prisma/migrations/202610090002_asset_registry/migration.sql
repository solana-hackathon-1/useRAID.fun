-- T029 exact asset identity and separately versioned policy snapshots (blueprint 16.2, 25.5).
-- Additive and inert: no existing table is touched, nothing is backfilled and no asset is marked
-- supported (O07/G04 remain open). Legacy USDC bookkeeping is deliberately not mapped here.
-- Native SOL stores '' in mint and tokenProgram so one plain UNIQUE index covers every identity.
BEGIN;

CREATE TABLE "Asset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "chain" TEXT NOT NULL DEFAULT 'SOLANA',
  "networkIdentity" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "mint" TEXT NOT NULL DEFAULT '',
  "tokenProgram" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Asset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Asset_chain_check" CHECK ("chain" = 'SOLANA'),
  CONSTRAINT "Asset_kind_check" CHECK ("kind" IN ('NATIVE_SOL', 'TOKEN')),
  CONSTRAINT "Asset_network_check" CHECK (
    char_length("networkIdentity") BETWEEN 1 AND 200
    AND "networkIdentity" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  -- Shape only (base58 alphabet, 32..44 characters). The module decodes and checks 32 bytes.
  CONSTRAINT "Asset_identity_check" CHECK (
    ("kind" = 'NATIVE_SOL' AND "mint" = '' AND "tokenProgram" = '')
    OR (
      "kind" = 'TOKEN'
      AND "mint" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      AND "tokenProgram" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    )
  )
);

CREATE UNIQUE INDEX "Asset_identity_key"
  ON "Asset"("chain", "networkIdentity", "kind", "mint", "tokenProgram");

CREATE TABLE "AssetPolicySnapshot" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "assetId" UUID NOT NULL,
  "registryVersion" TEXT NOT NULL,
  "verifiedDecimals" SMALLINT NOT NULL,
  "observedAuthorities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "supportedExtensionProfile" TEXT NOT NULL,
  "observedAt" TIMESTAMPTZ(6) NOT NULL,
  "observedSlot" NUMERIC(20, 0) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssetPolicySnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssetPolicySnapshot_assetId_fkey" FOREIGN KEY ("assetId")
    REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssetPolicySnapshot_decimals_check" CHECK ("verifiedDecimals" BETWEEN 0 AND 255),
  CONSTRAINT "AssetPolicySnapshot_slot_check" CHECK (
    "observedSlot" >= 0 AND "observedSlot" <= 18446744073709551615
  ),
  CONSTRAINT "AssetPolicySnapshot_version_check" CHECK (
    char_length("registryVersion") BETWEEN 1 AND 200
    AND "registryVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "AssetPolicySnapshot_profile_check" CHECK (
    char_length("supportedExtensionProfile") BETWEEN 1 AND 200
    AND "supportedExtensionProfile" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  )
);

CREATE UNIQUE INDEX "AssetPolicySnapshot_assetId_registryVersion_key"
  ON "AssetPolicySnapshot"("assetId", "registryVersion");

-- Identity rows never change or disappear: reward obligations and claims will reference them.
CREATE FUNCTION raid_asset_immutable_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are immutable and cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '23000';
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_immutable_v1
BEFORE UPDATE OR DELETE ON "Asset"
FOR EACH ROW EXECUTE FUNCTION raid_asset_immutable_v1();

CREATE TRIGGER asset_policy_snapshot_immutable_v1
BEFORE UPDATE OR DELETE ON "AssetPolicySnapshot"
FOR EACH ROW EXECUTE FUNCTION raid_asset_immutable_v1();

-- A new policy version may not reinterpret recorded amounts: decimals are fixed per asset and
-- observations never move backwards. The asset row lock serializes concurrent versions.
CREATE FUNCTION raid_asset_policy_guard_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest_slot NUMERIC;
BEGIN
  PERFORM 1 FROM "Asset" WHERE "id" = NEW."assetId" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "AssetPolicySnapshot"
    WHERE "assetId" = NEW."assetId" AND "verifiedDecimals" <> NEW."verifiedDecimals"
  ) THEN
    RAISE EXCEPTION 'Asset decimals cannot change between policy versions'
      USING ERRCODE = '23000';
  END IF;
  SELECT max("observedSlot") INTO latest_slot
  FROM "AssetPolicySnapshot" WHERE "assetId" = NEW."assetId";
  IF latest_slot IS NOT NULL AND NEW."observedSlot" < latest_slot THEN
    RAISE EXCEPTION 'Policy observation cannot move backwards' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_policy_guard_v1
BEFORE INSERT ON "AssetPolicySnapshot"
FOR EACH ROW EXECUTE FUNCTION raid_asset_policy_guard_v1();

COMMIT;
