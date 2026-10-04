-- State vocabularies mirror src/lib/states.ts. NOT VALID: new writes are checked now, existing
-- rows are validated by a later migration after the production audit (npm run tracking:audit).
ALTER TABLE "Raid" ADD CONSTRAINT "Raid_status_check" CHECK ("status" IN ('DRAFT','SCHEDULED','ACTIVE','ENDED')) NOT VALID;
ALTER TABLE "Raid" ADD CONSTRAINT "Raid_trackingPhase_check" CHECK ("trackingPhase" IN ('COLLECTING','FINALIZING','REVIEW','APPROVED','ALLOCATED','HELD','HELD_RESOLVED')) NOT VALID;
ALTER TABLE "Raid" ADD CONSTRAINT "Raid_fundingStatus_check" CHECK ("fundingStatus" IN ('NOT_REQUIRED','PENDING','VERIFIED')) NOT VALID;
ALTER TABLE "Raid" ADD CONSTRAINT "Raid_fundingAsset_check" CHECK ("fundingAsset" IN ('SOL','USDC','LAUNCH')) NOT VALID;
ALTER TABLE "Post" ADD CONSTRAINT "Post_qualification_check" CHECK ("qualification" IN ('LEGACY','QUALIFIED','EXCLUDED','DATA_INCOMPLETE')) NOT VALID;
ALTER TABLE "Post" ADD CONSTRAINT "Post_availability_check" CHECK ("availability" IN ('AVAILABLE','DATA_INCOMPLETE','UNAVAILABLE')) NOT VALID;
ALTER TABLE "Post" ADD CONSTRAINT "Post_reviewStatus_check" CHECK ("reviewStatus" IN ('CLEAR','FLAGGED','CLEARED')) NOT VALID;
