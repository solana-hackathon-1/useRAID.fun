-- In-flight authorizations must restart with the new callback and session binding.
DELETE FROM "OAuthAttempt";
ALTER TABLE "OAuthAttempt" ADD COLUMN "userId" TEXT,
ADD COLUMN "sessionHash" TEXT, ADD COLUMN "consumedAt" TIMESTAMP(3);
CREATE INDEX "OAuthAttempt_expiresAt_idx" ON "OAuthAttempt"("expiresAt");
CREATE INDEX "OAuthAttempt_userId_idx" ON "OAuthAttempt"("userId");
CREATE TABLE "XAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "xUserId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "profileImage" TEXT,
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "XAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "XAccount_userId_key" ON "XAccount"("userId");
CREATE UNIQUE INDEX "XAccount_xUserId_key" ON "XAccount"("xUserId");
ALTER TABLE "XAccount" ADD CONSTRAINT "XAccount_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
