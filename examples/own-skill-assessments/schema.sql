-- Explicit independent host account/session dependency; no hidden RAID global.
CREATE TABLE "User" ("id" TEXT PRIMARY KEY,"suspended" BOOLEAN NOT NULL DEFAULT false,"role" TEXT NOT NULL,"xId" TEXT UNIQUE);
CREATE TABLE "Session" ("tokenHash" TEXT PRIMARY KEY,"userId" TEXT NOT NULL REFERENCES "User"("id"),"expiresAt" TIMESTAMP(3) NOT NULL,"via" TEXT NOT NULL DEFAULT 'wallet');
