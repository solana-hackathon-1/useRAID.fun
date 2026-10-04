ALTER TABLE "Token" ADD COLUMN "metadataSource" TEXT NOT NULL DEFAULT 'CREATOR';
ALTER TABLE "Token" ADD COLUMN "metadataVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Token" ADD CONSTRAINT "Token_metadataSource_check" CHECK ("metadataSource" IN ('CREATOR', 'MARKET'));
