-- AlterTable
ALTER TABLE "User" ALTER COLUMN "xId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Raid" ADD COLUMN     "coveredUntil" TIMESTAMP(3),
ADD COLUMN     "tokenLaunchId" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "launchPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "operatorAddress" TEXT,
ADD COLUMN     "payoutPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutWorkerAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WalletIdentity" (
    "address" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletIdentity_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "WalletChallenge" (
    "digest" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "WalletChallenge_pkey" PRIMARY KEY ("digest")
);

-- CreateTable
CREATE TABLE "TokenLaunch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadataUri" TEXT NOT NULL,
    "imageUri" TEXT NOT NULL,
    "bannerUri" TEXT,
    "feeAddress" TEXT NOT NULL,
    "feeSecret" TEXT NOT NULL,
    "mintSecret" TEXT NOT NULL,
    "preparedTx" TEXT,
    "signedTx" TEXT,
    "preparedHash" TEXT,
    "blockhash" TEXT,
    "lastValidBlockHeight" INTEGER,
    "signature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "reservationExpiresAt" TIMESTAMP(3),
    "error" TEXT,
    "raidId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenLaunch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeClaim" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "roundId" TEXT,
    "signature" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "grossLamports" BIGINT NOT NULL,
    "costLamports" BIGINT NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardEnrollment" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardRound" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "grossLamports" BIGINT NOT NULL DEFAULT 0,
    "costLamports" BIGINT NOT NULL DEFAULT 0,
    "platformLamports" BIGINT NOT NULL DEFAULT 0,
    "raiderLamports" BIGINT NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "RewardRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardPayout" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "payoutBatchRoundId" TEXT,
    "walletAddress" TEXT NOT NULL,
    "xId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "lamports" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "signature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "RewardPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialTx" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "roundId" TEXT,
    "kind" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "blockhash" TEXT NOT NULL,
    "lastValidBlockHeight" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SIGNED',
    "costLamports" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "FinancialTx_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletIdentity_userId_key" ON "WalletIdentity"("userId");

-- CreateIndex
CREATE INDEX "WalletChallenge_address_expiresAt_idx" ON "WalletChallenge"("address", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TokenLaunch_mint_key" ON "TokenLaunch"("mint");

-- CreateIndex
CREATE UNIQUE INDEX "TokenLaunch_feeAddress_key" ON "TokenLaunch"("feeAddress");

-- CreateIndex
CREATE UNIQUE INDEX "TokenLaunch_signature_key" ON "TokenLaunch"("signature");

-- CreateIndex
CREATE UNIQUE INDEX "TokenLaunch_raidId_key" ON "TokenLaunch"("raidId");

-- CreateIndex
CREATE INDEX "TokenLaunch_status_createdAt_idx" ON "TokenLaunch"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeeClaim_signature_key" ON "FeeClaim"("signature");

-- CreateIndex
CREATE INDEX "FeeClaim_launchId_roundId_claimedAt_idx" ON "FeeClaim"("launchId", "roundId", "claimedAt");

-- CreateIndex
CREATE INDEX "RewardEnrollment_launchId_userId_idx" ON "RewardEnrollment"("launchId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardEnrollment_launchId_xId_key" ON "RewardEnrollment"("launchId", "xId");

-- CreateIndex
CREATE INDEX "RewardRound_launchId_endsAt_idx" ON "RewardRound"("launchId", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "RewardRound_raidId_startsAt_key" ON "RewardRound"("raidId", "startsAt");

-- CreateIndex
CREATE INDEX "RewardPayout_walletAddress_status_idx" ON "RewardPayout"("walletAddress", "status");

-- CreateIndex
CREATE INDEX "RewardPayout_payoutBatchRoundId_status_idx" ON "RewardPayout"("payoutBatchRoundId", "status");

-- CreateIndex
CREATE INDEX "RewardPayout_signature_idx" ON "RewardPayout"("signature");

-- CreateIndex
CREATE UNIQUE INDEX "RewardPayout_roundId_xId_key" ON "RewardPayout"("roundId", "xId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTx_key_key" ON "FinancialTx"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTx_signature_key" ON "FinancialTx"("signature");

-- CreateIndex
CREATE INDEX "FinancialTx_launchId_status_idx" ON "FinancialTx"("launchId", "status");

-- CreateIndex
CREATE INDEX "Raid_tokenLaunchId_startsAt_idx" ON "Raid"("tokenLaunchId", "startsAt");

-- AddForeignKey
ALTER TABLE "WalletIdentity" ADD CONSTRAINT "WalletIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenLaunch" ADD CONSTRAINT "TokenLaunch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenLaunch" ADD CONSTRAINT "TokenLaunch_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeClaim" ADD CONSTRAINT "FeeClaim_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "TokenLaunch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardEnrollment" ADD CONSTRAINT "RewardEnrollment_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "TokenLaunch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardEnrollment" ADD CONSTRAINT "RewardEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardRound" ADD CONSTRAINT "RewardRound_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "TokenLaunch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardPayout" ADD CONSTRAINT "RewardPayout_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "TokenLaunch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Raid" ADD CONSTRAINT "Raid_tokenLaunchId_fkey" FOREIGN KEY ("tokenLaunchId") REFERENCES "TokenLaunch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

