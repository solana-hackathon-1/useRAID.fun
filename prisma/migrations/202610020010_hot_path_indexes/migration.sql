CREATE INDEX "RaidEnrollment_xId_joinedAt_idx" ON "RaidEnrollment"("xId", "joinedAt");
CREATE INDEX "Raid_creatorId_createdAt_idx" ON "Raid"("creatorId", "createdAt");
CREATE INDEX "Raid_mint_idx" ON "Raid"("mint");
CREATE INDEX "BalanceEntry_userId_network_idx" ON "BalanceEntry"("userId", "network");
