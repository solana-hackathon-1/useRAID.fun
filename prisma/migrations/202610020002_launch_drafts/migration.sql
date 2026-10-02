-- Preserve campaign draft amounts without reserving funds before start.
ALTER TABLE "Raid" ADD COLUMN "launchDraft" JSONB;
