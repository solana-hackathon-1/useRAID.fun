-- Independent host's minimal declared account/session tables; no RAID application state.
CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "suspended" BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE "Session" (
 "tokenHash" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id"),
 "expiresAt" TIMESTAMP(3) NOT NULL, "via" TEXT NOT NULL DEFAULT 'wallet'
);
