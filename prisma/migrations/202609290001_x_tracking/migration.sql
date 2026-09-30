-- AlterTable
ALTER TABLE "FeeClaim" ADD COLUMN     "raidId" TEXT;

-- AlterTable
ALTER TABLE "RewardRound" ADD COLUMN     "resultSnapshotId" TEXT,
ADD COLUMN     "settlementRaidId" TEXT;

-- AlterTable
ALTER TABLE "FinancialTx" ADD COLUMN     "raidId" TEXT;

-- AlterTable
ALTER TABLE "Raid" ADD COLUMN     "activeResultId" TEXT,
ADD COLUMN     "finalFeeSweepAt" TIMESTAMP(3),
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "officialHandle" TEXT NOT NULL DEFAULT 'useRAID',
ADD COLUMN     "reviewEndsAt" TIMESTAMP(3),
ADD COLUMN     "ruleVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "scoringVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "trackingPhase" TEXT NOT NULL DEFAULT 'COLLECTING',
ADD COLUMN     "trackingVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "adminExcluded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "availability" TEXT NOT NULL DEFAULT 'AVAILABLE',
ADD COLUMN     "contentExpiredAt" TIMESTAMP(3),
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "enrollmentId" TEXT,
ADD COLUMN     "lastObservationId" TEXT,
ADD COLUMN     "postType" TEXT NOT NULL DEFAULT 'ORIGINAL',
ADD COLUMN     "qualification" TEXT NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "reasonCode" TEXT,
ADD COLUMN     "reviewFingerprint" TEXT,
ADD COLUMN     "reviewStatus" TEXT NOT NULL DEFAULT 'CLEAR',
ADD COLUMN     "ruleVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'SEARCH';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RaidEnrollment" (
    "id" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaidEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostSubmission" (
    "id" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "reasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricObservation" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "sampleKey" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "likes" INTEGER NOT NULL,
    "replies" INTEGER NOT NULL,
    "reposts" INTEGER NOT NULL,
    "quotes" INTEGER NOT NULL,

    CONSTRAINT "MetricObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContributionDecision" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "actorId" TEXT,
    "qualification" TEXT NOT NULL,
    "reasonCode" TEXT,
    "ruleVersion" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContributionDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignResult" (
    "id" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RaidDispute" (
    "id" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "postId" TEXT,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "RaidDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XEndpointState" (
    "key" TEXT NOT NULL,
    "remaining" INTEGER,
    "resetAt" TIMESTAMP(3),
    "blockedUntil" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "XEndpointState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "RaidEnrollment_raidId_xId_key" ON "RaidEnrollment"("raidId", "xId");

-- CreateIndex
CREATE UNIQUE INDEX "RaidEnrollment_raidId_userId_key" ON "RaidEnrollment"("raidId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "RaidEnrollment_raidId_walletAddress_key" ON "RaidEnrollment"("raidId", "walletAddress");

-- CreateIndex
CREATE INDEX "PostSubmission_raidId_status_idx" ON "PostSubmission"("raidId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PostSubmission_raidId_enrollmentId_postId_key" ON "PostSubmission"("raidId", "enrollmentId", "postId");

-- CreateIndex
CREATE INDEX "MetricObservation_postId_observedAt_idx" ON "MetricObservation"("postId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetricObservation_postId_sampleKey_key" ON "MetricObservation"("postId", "sampleKey");

-- CreateIndex
CREATE INDEX "ContributionDecision_postId_at_idx" ON "ContributionDecision"("postId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignResult_raidId_version_key" ON "CampaignResult"("raidId", "version");

-- CreateIndex
CREATE INDEX "RaidDispute_raidId_status_idx" ON "RaidDispute"("raidId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RewardRound_resultSnapshotId_key" ON "RewardRound"("resultSnapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardRound_settlementRaidId_key" ON "RewardRound"("settlementRaidId");

-- AddForeignKey
ALTER TABLE "RewardRound" ADD CONSTRAINT "RewardRound_resultSnapshotId_fkey" FOREIGN KEY ("resultSnapshotId") REFERENCES "CampaignResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "RaidEnrollment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidEnrollment" ADD CONSTRAINT "RaidEnrollment_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidEnrollment" ADD CONSTRAINT "RaidEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSubmission" ADD CONSTRAINT "PostSubmission_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostSubmission" ADD CONSTRAINT "PostSubmission_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "RaidEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricObservation" ADD CONSTRAINT "MetricObservation_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionDecision" ADD CONSTRAINT "ContributionDecision_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignResult" ADD CONSTRAINT "CampaignResult_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidDispute" ADD CONSTRAINT "RaidDispute_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaidDispute" ADD CONSTRAINT "RaidDispute_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "RaidEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Score evidence is append-only. Corrections create new observations and result versions.
CREATE FUNCTION reject_tracking_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tracking evidence is append-only; create a new version';
END;
$$;
CREATE TRIGGER immutable_campaign_result BEFORE UPDATE OR DELETE ON "CampaignResult"
FOR EACH ROW EXECUTE FUNCTION reject_tracking_evidence_mutation();
CREATE TRIGGER immutable_metric_observation BEFORE UPDATE OR DELETE ON "MetricObservation"
FOR EACH ROW EXECUTE FUNCTION reject_tracking_evidence_mutation();
CREATE TRIGGER immutable_contribution_decision BEFORE UPDATE OR DELETE ON "ContributionDecision"
FOR EACH ROW EXECUTE FUNCTION reject_tracking_evidence_mutation();
