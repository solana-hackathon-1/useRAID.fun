-- AlterTable
ALTER TABLE "TokenLaunch" ADD COLUMN     "chainObservedAt" TIMESTAMP(3),
ADD COLUMN     "chainSnapshot" JSONB,
ADD COLUMN     "configuration" JSONB,
ADD COLUMN     "creatorAddress" TEXT,
ADD COLUMN     "dammPoolAddress" TEXT,
ADD COLUMN     "feeVaultAddress" TEXT,
ADD COLUMN     "migrationStatus" TEXT NOT NULL DEFAULT 'BONDING',
ADD COLUMN     "network" TEXT NOT NULL DEFAULT 'mainnet',
ADD COLUMN     "poolAddress" TEXT,
ADD COLUMN     "poolConfigAddress" TEXT,
ADD COLUMN     "positionAddress" TEXT,
ADD COLUMN     "positionNftAccount" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'PUMP',
ADD COLUMN     "setupSecrets" JSONB,
ADD COLUMN     "workerObservedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LaunchStep" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "transaction" TEXT,
    "messageHash" TEXT,
    "blockhash" TEXT,
    "lastValidBlockHeight" INTEGER,
    "signature" TEXT,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "LaunchStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaunchBalanceEntry" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "availableDelta" BIGINT NOT NULL,
    "reservedDelta" BIGINT NOT NULL,
    "raidId" TEXT,
    "signature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LaunchBalanceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaunchCampaignBudget" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "reservedUnits" BIGINT NOT NULL,
    "earnedUnits" BIGINT NOT NULL DEFAULT 0,
    "paidUnits" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "resultId" TEXT,

    CONSTRAINT "LaunchCampaignBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaunchCampaignPayout" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "xId" TEXT NOT NULL,
    "units" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "signature" TEXT,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "LaunchCampaignPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LaunchStep_signature_key" ON "LaunchStep"("signature");

-- CreateIndex
CREATE INDEX "LaunchStep_launchId_status_idx" ON "LaunchStep"("launchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LaunchStep_launchId_key_key" ON "LaunchStep"("launchId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "LaunchBalanceEntry_key_key" ON "LaunchBalanceEntry"("key");

-- CreateIndex
CREATE INDEX "LaunchBalanceEntry_launchId_network_asset_idx" ON "LaunchBalanceEntry"("launchId", "network", "asset");

-- CreateIndex
CREATE UNIQUE INDEX "LaunchCampaignBudget_raidId_asset_key" ON "LaunchCampaignBudget"("raidId", "asset");

-- CreateIndex
CREATE UNIQUE INDEX "LaunchCampaignPayout_signature_key" ON "LaunchCampaignPayout"("signature");

-- CreateIndex
CREATE INDEX "LaunchCampaignPayout_status_launchId_idx" ON "LaunchCampaignPayout"("status", "launchId");

-- CreateIndex
CREATE UNIQUE INDEX "LaunchCampaignPayout_raidId_asset_xId_key" ON "LaunchCampaignPayout"("raidId", "asset", "xId");

-- AddForeignKey
ALTER TABLE "LaunchStep" ADD CONSTRAINT "LaunchStep_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "TokenLaunch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaunchBalanceEntry" ADD CONSTRAINT "LaunchBalanceEntry_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "TokenLaunch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaunchCampaignBudget" ADD CONSTRAINT "LaunchCampaignBudget_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "TokenLaunch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaunchCampaignBudget" ADD CONSTRAINT "LaunchCampaignBudget_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaunchCampaignPayout" ADD CONSTRAINT "LaunchCampaignPayout_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "TokenLaunch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

