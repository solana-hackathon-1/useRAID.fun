ALTER TABLE "Raid" ALTER COLUMN "mint" DROP NOT NULL;
ALTER TABLE "Raid" ADD COLUMN "projectName" TEXT NOT NULL DEFAULT '',
 ADD COLUMN "projectSymbol" TEXT NOT NULL DEFAULT '',
 ADD COLUMN "fundingStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
 ADD COLUMN "fundingRequest" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Post" ADD COLUMN "views" INTEGER;
ALTER TABLE "MetricObservation" ADD COLUMN "views" INTEGER;
ALTER TABLE "Raid" ADD COLUMN "impressionTarget" INTEGER,
 ADD COLUMN "fundingLamports" TEXT,
 ADD COLUMN "fundingRecipient" TEXT,
 ADD COLUMN "fundingSignature" TEXT,
 ADD COLUMN "fundedAt" TIMESTAMP(3),
 ADD COLUMN "targetReachedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Raid_fundingSignature_key" ON "Raid"("fundingSignature");
CREATE TABLE "RaidBriefPost" (
 "id" TEXT NOT NULL PRIMARY KEY, "raidId" TEXT NOT NULL, "postId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RaidBriefPost_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RaidBriefPost_raidId_postId_key" ON "RaidBriefPost"("raidId", "postId");
ALTER TABLE "Raid" ADD COLUMN "fundingWallet" TEXT;
CREATE TABLE "RaidAllocation" (
 "id" TEXT NOT NULL PRIMARY KEY, "raidId" TEXT NOT NULL, "resultId" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "xId" TEXT, "walletAddress" TEXT NOT NULL, "lamports" TEXT NOT NULL,
 "signature" TEXT, "paidAt" TIMESTAMP(3),
 CONSTRAINT "RaidAllocation_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RaidAllocation_signature_key" ON "RaidAllocation"("signature");
CREATE UNIQUE INDEX "RaidAllocation_raidId_kind_walletAddress_key" ON "RaidAllocation"("raidId", "kind", "walletAddress");
