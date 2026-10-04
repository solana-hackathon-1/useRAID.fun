ALTER TABLE "Session" ADD COLUMN "via" TEXT NOT NULL DEFAULT 'x';
ALTER TABLE "WalletChallenge" ADD COLUMN "userId" TEXT;
-- Wallet-issued admin sessions cannot be told apart from X ones, so administrators sign in with X again.
DELETE FROM "Session" s USING "User" u WHERE s."userId" = u."id" AND u."role" = 'ADMIN';
