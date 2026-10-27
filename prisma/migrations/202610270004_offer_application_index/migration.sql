-- Offer history and the RESTRICT foreign key to RaidApplication look offers up by application in every state;
-- the existing unique index covers only the single PENDING offer.
CREATE INDEX "RaidOffer_applicationId_idx" ON "RaidOffer"("applicationId");
