import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { assetKey } from '../contracts/assets';
import { WorkError } from './contracts';
import { WorkMetricsSchema, type WorkMetrics } from './metrics-contracts';

const NOT_MEASURED = [
  'paidVolume',
  'settlementCompletion',
  'disputeBurden',
  'privateAccessReliability',
  'repeatParticipation',
  'fixtureExclusion',
];
async function counts(tx: Tx, table: string, column: string) {
  // Table and column names are constants of this module, never caller input.
  const rows = await tx.query<{ key: string; n: number }>(
    `SELECT "${column}" AS key,count(*)::int AS n FROM "${table}" GROUP BY 1`,
    [],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.n]));
}
async function timing(tx: Tx, from: string) {
  const [row] = await tx.query<{ n: number; median: number | null; p90: number | null }>(
    `SELECT count(*)::int AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float AS median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds)::float AS p90
     FROM (${from}) samples`,
    [],
  );
  return { samples: row.n, medianSeconds: row.median, p90Seconds: row.p90 };
}
/** Operator metrics for the simulated work loop. Read only; the host decides who may call it. */
export async function readWorkMetrics(tx: Tx): Promise<WorkMetrics> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    throw new WorkError('STORAGE_CONTRACT');
  const [now] = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now', []);
  const [submissions] = await tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM "WorkSubmission"',
    [],
  );
  const volumes = await tx.query<{
    bucket: string;
    asset: unknown;
    decimals: number;
    total: string;
  }>(
    `SELECT x.bucket,r->'policy'->'assetId' AS asset,(r->'policy'->>'verifiedDecimals')::int AS decimals,
      sum((r->>'amount')::numeric)::text AS total
     FROM (
      SELECT 'openFunded' AS bucket,t."snapshot" AS terms
       FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=s."termsVersionId"
       WHERE s."state"='AVAILABLE' AND s."fundingRef" IS NOT NULL AND l."state"='OPEN'
      UNION ALL
      SELECT 'committed',raid_effective_terms(e."id") FROM "Engagement" e
       WHERE e."state" IN ('ACCESS_PENDING','IN_PROGRESS','SUBMITTED','REVISION_REQUESTED')
      UNION ALL
      SELECT 'workAccepted',raid_effective_terms(e."id") FROM "Engagement" e WHERE e."state"='ACCEPTED'
     ) x, jsonb_array_elements(x.terms->'rewards') r
     GROUP BY 1,2,3`,
    [],
  );
  const byAsset = new Map<string, WorkMetrics['volumes'][number]>();
  for (const row of volumes) {
    const key = assetKey(row.asset as Parameters<typeof assetKey>[0]);
    const entry =
      byAsset.get(key) ??
      ({
        assetKey: key,
        assetId: row.asset,
        decimals: row.decimals,
        openFunded: '0',
        committed: '0',
        workAccepted: '0',
        paid: null,
      } as WorkMetrics['volumes'][number]);
    (entry as unknown as Record<string, unknown>)[row.bucket] = row.total;
    byAsset.set(key, entry);
  }
  return WorkMetricsSchema.parse({
    version: 'v1',
    generatedAt: now.now.toISOString(),
    fundingMode: 'SIMULATED',
    listings: await counts(tx, 'WorkListing', 'state'),
    slots: await counts(tx, 'RaidSlot', 'state'),
    applications: await counts(tx, 'RaidApplication', 'state'),
    offers: await counts(tx, 'RaidOffer', 'state'),
    engagements: await counts(tx, 'Engagement', 'state'),
    closures: await counts(tx, 'EngagementClosure', 'reason'),
    reviews: await counts(tx, 'WorkReview', 'decision'),
    submissions: submissions.n,
    timings: {
      matching: await timing(
        tx,
        `SELECT extract(epoch FROM e."createdAt"-s."createdAt") AS seconds FROM "Engagement" e JOIN "RaidSlot" s ON s."id"=e."slotId"`,
      ),
      review: await timing(
        tx,
        `SELECT extract(epoch FROM r."createdAt"-w."createdAt") AS seconds FROM "WorkReview" r JOIN "WorkSubmission" w ON w."id"=r."submissionId"`,
      ),
    },
    volumes: [...byAsset.values()].sort((a, b) => a.assetKey.localeCompare(b.assetKey)),
    notMeasured: NOT_MEASURED,
  });
}
