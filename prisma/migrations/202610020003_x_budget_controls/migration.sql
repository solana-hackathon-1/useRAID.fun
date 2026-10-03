ALTER TABLE "Settings" ADD COLUMN "identityDailyLimit" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "Raid" ADD COLUMN "searchQuery" TEXT;
CREATE INDEX "Event_type_visitor_at_idx" ON "Event"("type", "visitor", "at");
