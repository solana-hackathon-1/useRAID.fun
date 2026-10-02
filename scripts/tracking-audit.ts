import 'dotenv/config';
import { db } from '../src/lib/db';
if (!process.env.DATABASE_URL) {
  console.error('Audit unavailable: DATABASE_URL is not configured. No deployment was contacted.');
  process.exitCode = 1;
} else {
  try {
    const report = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return {
        raids:
          await tx.$queryRaw`SELECT status, count(*)::text AS count FROM "Raid" GROUP BY status`,
        legacyEnrollments: await tx.rewardEnrollment.count(),
        balances:
          await tx.$queryRaw`SELECT status, count(*)::text AS count, sum(lamports)::text AS lamports FROM "RewardPayout" GROUP BY status`,
        signedTransactions: await tx.financialTx.count({ where: { status: 'SIGNED' } }),
        unallocatedClaims:
          await tx.$queryRaw`SELECT count(*)::text AS count, sum("grossLamports")::text AS gross, sum("costLamports")::text AS costs FROM "FeeClaim" WHERE "roundId" IS NULL`,
        standaloneFunding: await tx.raid.groupBy({
          by: ['fundingStatus'],
          where: { mint: null },
          _count: true,
        }),
        unpaidStandaloneAllocations: await tx.raidAllocation.count({ where: { paidAt: null } }),
      };
    });
    console.log(JSON.stringify({ auditedAt: new Date().toISOString(), ...report }, null, 2));
  } catch (error) {
    console.error('Read-only deployment audit failed. Check connectivity and migration state.');
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
