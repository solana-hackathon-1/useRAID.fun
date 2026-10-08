-- Host-owned legacy payout wallet table (shape the RAID application already has).
CREATE TABLE "WalletIdentity" (
  "address" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE CASCADE,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "previousAddress" TEXT,
  "rotatedAt" TIMESTAMP(3)
);
