-- Independent host's minimal declared account/session tables; no RAID application state.
CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "suspended" BOOLEAN NOT NULL DEFAULT false);
-- `via` is 'wallet' or 'x' (the production default is 'x'); the host records how each session was established.
CREATE TABLE "Session" (
 "tokenHash" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id"),
 "expiresAt" TIMESTAMP(3) NOT NULL, "via" TEXT NOT NULL DEFAULT 'x'
);
