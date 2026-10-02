-- Align the Creator Studio foreign keys with prisma/schema.prisma (RESTRICT / CASCADE)
-- and add the missing UsdcAllocation.userId relation. Raid.mint stays ON DELETE RESTRICT:
-- the schema now declares it instead of the implicit SET NULL.
ALTER TABLE "BalanceEntry" DROP CONSTRAINT "BalanceEntry_userId_fkey";
ALTER TABLE "BalanceEntry" ADD CONSTRAINT "BalanceEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UsdcTransfer" DROP CONSTRAINT "UsdcTransfer_userId_fkey";
ALTER TABLE "UsdcTransfer" ADD CONSTRAINT "UsdcTransfer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UsdcAllocation" DROP CONSTRAINT "UsdcAllocation_raidId_fkey";
ALTER TABLE "UsdcAllocation" ADD CONSTRAINT "UsdcAllocation_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "Raid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UsdcAllocation" ADD CONSTRAINT "UsdcAllocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "UsdcAllocation" VALIDATE CONSTRAINT "UsdcAllocation_userId_fkey";
