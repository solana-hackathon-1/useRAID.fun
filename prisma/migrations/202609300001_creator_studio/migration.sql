ALTER TABLE "Token" ADD COLUMN "imageUri" TEXT;
ALTER TABLE "Raid" ADD COLUMN "studioVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fundingAsset" TEXT NOT NULL DEFAULT 'SOL',
  ADD COLUMN "fundingNetwork" TEXT NOT NULL DEFAULT 'mainnet',
  ADD COLUMN "poolUnits" BIGINT, ADD COLUMN "quoteRate" BIGINT, ADD COLUMN "imageUri" TEXT;
ALTER TABLE "Post" ADD COLUMN "targetPostId" TEXT;
ALTER TABLE "RaidBriefPost" ADD COLUMN "preview" JSONB, ADD COLUMN "validatedAt" TIMESTAMP(3);
CREATE TABLE "BalanceEntry" (
  "id" TEXT PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, "userId" TEXT NOT NULL REFERENCES "User"("id"),
  "kind" TEXT NOT NULL, "network" TEXT NOT NULL DEFAULT 'mainnet', "availableDelta" BIGINT NOT NULL, "reservedDelta" BIGINT NOT NULL,
  "raidId" TEXT, "transferId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "BalanceEntry_userId_createdAt_idx" ON "BalanceEntry"("userId", "createdAt");
CREATE TABLE "UsdcTransfer" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id"), "kind" TEXT NOT NULL,
  "amount" BIGINT NOT NULL CHECK ("amount" > 0), "walletAddress" TEXT NOT NULL, "recipient" TEXT NOT NULL,
  "network" TEXT NOT NULL, "mint" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "signature" TEXT UNIQUE, "allocationId" TEXT UNIQUE, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3), "paidAt" TIMESTAMP(3)
);
CREATE INDEX "UsdcTransfer_userId_createdAt_idx" ON "UsdcTransfer"("userId", "createdAt");
CREATE INDEX "UsdcTransfer_status_kind_idx" ON "UsdcTransfer"("status", "kind");
CREATE TABLE "UsdcAllocation" (
  "id" TEXT PRIMARY KEY, "raidId" TEXT NOT NULL REFERENCES "Raid"("id"), "resultId" TEXT NOT NULL,
  "userId" TEXT NOT NULL, "xId" TEXT NOT NULL, "walletAddress" TEXT NOT NULL,
  "amount" BIGINT NOT NULL CHECK ("amount" > 0), UNIQUE ("raidId", "xId")
);
CREATE FUNCTION preserve_balance_entry() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Balance entries are append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER balance_entry_immutable BEFORE UPDATE OR DELETE ON "BalanceEntry"
FOR EACH ROW EXECUTE FUNCTION preserve_balance_entry();
