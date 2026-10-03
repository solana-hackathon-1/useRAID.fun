import type { Prisma } from '@prisma/client';
import { CHECKED_STATES } from './states';

const COLUMNS = Object.entries(CHECKED_STATES).map(([name, allowed]) => {
  const [table, column] = name.replace(/_check$/, '').split('_');
  return { table, column, allowed: allowed as readonly string[] };
});

// Every distinct stored value of each CHECK-constrained column, so rows that predate (and would fail)
// the NOT VALID state checks are visible before the VALIDATE migration.
async function stateValues(tx: Prisma.TransactionClient) {
  const rows = [];
  for (const { table, column, allowed } of COLUMNS)
    for (const row of await tx.$queryRawUnsafe<{ value: string; count: string }[]>(
      `SELECT "${column}" AS value, count(*)::text AS count FROM "${table}" GROUP BY "${column}" ORDER BY "${column}"`,
    ))
      rows.push({ table, column, ...row, allowed: allowed.includes(row.value) });
  return rows;
}

export async function buildAuditReport(tx: Prisma.TransactionClient) {
  const states = await stateValues(tx);
  return {
    states,
    unexpectedStates: states.filter((row) => !row.allowed),
    raids: await tx.$queryRaw`SELECT status, count(*)::text AS count FROM "Raid" GROUP BY status`,
    legacyEnrollments: await tx.rewardEnrollment.count(),
    balances:
      await tx.$queryRaw`SELECT status, count(*)::text AS count, sum(lamports)::text AS lamports FROM "RewardPayout" GROUP BY status`,
    signedTransactions: await tx.financialTx.count({ where: { status: 'SIGNED' } }),
    unallocatedClaims:
      await tx.$queryRaw`SELECT count(*)::text AS count, sum("grossLamports")::text AS gross, sum("costLamports")::text AS costs FROM "FeeClaim" WHERE "roundId" IS NULL`,
    standaloneFunding: await tx.raid.groupBy({
      by: ['fundingStatus'],
      where: { fundingAsset: 'SOL', fundingStatus: { not: 'NOT_REQUIRED' } },
      _count: true,
    }),
    unpaidStandaloneAllocations: await tx.raidAllocation.count({ where: { paidAt: null } }),
    usdcBalances:
      await tx.$queryRaw`SELECT network, sum("availableDelta")::text AS available, sum("reservedDelta")::text AS reserved FROM "BalanceEntry" GROUP BY network ORDER BY network`,
    usdcTransfers:
      await tx.$queryRaw`SELECT network, kind, status, count(*)::text AS count, sum(amount)::text AS amount FROM "UsdcTransfer" GROUP BY network, kind, status ORDER BY network, kind, status`,
    unpaidUsdcAllocations:
      await tx.$queryRaw`SELECT count(*)::text AS count, coalesce(sum(a.amount), 0)::text AS amount FROM "UsdcAllocation" a LEFT JOIN "UsdcTransfer" t ON t."allocationId" = a.id AND t.status = 'PAID' WHERE t.id IS NULL`,
    studioRaids:
      await tx.$queryRaw`SELECT "fundingNetwork", status, "trackingPhase", count(*)::text AS count, sum("poolUnits")::text AS "poolUnits" FROM "Raid" WHERE "fundingAsset" = 'USDC' GROUP BY "fundingNetwork", status, "trackingPhase" ORDER BY "fundingNetwork", status, "trackingPhase"`,
  };
}
