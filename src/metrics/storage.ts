import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { assetKey } from '../contracts/assets';
import {
  DELAY_BUCKETS,
  MetricsError,
  ProductMetricsSchema,
  type ProductMetrics,
  type RatioMetric,
} from './contracts';

const NOT_MEASURED = [
  'paidVolume',
  'dollarValue',
  'timeToSettlement',
  'disputeResolution',
  'disputeCategoryAndFinding',
  'privateAccessReliability',
  'tokenLaunchConversion',
  'challengeOutcomes',
  'reviewDelayExcludingPauses',
  'opportunityConcentration',
];
const NO_MARKERS =
  'Records an operator marked excluded (MetricsExclusion) are left out. Unmarked fixtures, demonstrations, duplicates and abuse are not detected, so are not excluded.';
const VERIFIED =
  'Work under a Guild id with no persisted (operator-activated) Guild is excluded and counted under `excluded`.';

const UNVALUED =
  'Amounts are base units per asset, never summed across assets and never valued: no dated approved price methodology exists, and unpriced project tokens are not dollars.';
const TERMINATED_NOT_DUE =
  'Terminated engagements are not due: closing the work duty decides no money and no fault, so their preserved claims are not counted.';
const PAUSES =
  'Documented pauses are not recorded, so none are excluded: the delay includes any pause and is not the delay excluding pauses.';

function ratio(
  numerator: number,
  denominator: number,
  denominatorDefinition: string,
  exclusions: string[],
): RatioMetric {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    denominatorDefinition,
    exclusions,
  };
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
interface AssetRow {
  asset: unknown;
  min_decimals: number;
  max_decimals: number;
  all_engagements: number;
  all_amount: string;
  subset_engagements: number;
  subset_amount: string;
}
/**
 * One row per full asset identity. A decimals disagreement across legs of one asset is a storage fault, never
 * averaged away.
 */
function perAsset(rows: AssetRow[]) {
  const byKey = new Map<string, AssetRow & { key: string }>();
  for (const row of rows) {
    const key = assetKey(row.asset as Parameters<typeof assetKey>[0]);
    if (byKey.has(key) || row.min_decimals !== row.max_decimals)
      throw new MetricsError('STORAGE_CONTRACT');
    byKey.set(key, { ...row, key });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}
/**
 * Records an operator has marked excluded (DEC-2026-11-13-10): each fragment is the table without its effectively
 * excluded rows, used wherever the report reads that table. A marker is effective while it is an EXCLUDE that no later
 * marker supersedes; a RELEASE (or any superseding marker) ends the earlier one. An excluded Guild leaves every figure;
 * an excluded listing leaves the funnel, funding and its engagements; an excluded engagement leaves outcomes,
 * settlement, disputes and review delay; an excluded participant leaves participant measures only. Raw tables are
 * kept only where a record must still count as "without a verified Guild" (those counts are not marker exclusions).
 */
const EXCLUDED = (type: string, idExpression: string) =>
  `EXISTS (SELECT 1 FROM "MetricsExclusion" mx WHERE mx."subjectType"='${type}' AND mx."subjectId"=${idExpression} AND mx."effect"='EXCLUDE' AND NOT EXISTS (SELECT 1 FROM "MetricsExclusion" nx WHERE nx."supersedesMarkerId"=mx."id"))`;
const G = `(SELECT gx.* FROM "Guild" gx WHERE NOT ${EXCLUDED('GUILD', 'gx."id"::text')})`;
const L = `(SELECT lx.* FROM "WorkListing" lx WHERE NOT ${EXCLUDED('WORK_LISTING', 'lx."id"::text')})`;
const P = `(SELECT px.* FROM "Participant" px WHERE NOT ${EXCLUDED('PARTICIPANT', 'px."id"::text')})`;
const E = `(SELECT ex.* FROM "Engagement" ex WHERE NOT ${EXCLUDED('ENGAGEMENT', 'ex."id"::text')} AND NOT EXISTS (SELECT 1 FROM "RaidSlot" sx WHERE sx."id"=ex."slotId" AND ${EXCLUDED('WORK_LISTING', 'sx."listingId"::text')}))`;
/**
 * Verified work: a listing or engagement whose Guild id is a persisted Guild. "Work accepted" is an engagement closed
 * with reason ACCEPTED; accepting work is not payment and nothing here measures money.
 */
/** Operator product metrics over existing tables. Read only; the host decides who may call it. */
export async function readProductMetrics(tx: Tx): Promise<ProductMetrics> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    throw new MetricsError('STORAGE_CONTRACT');
  const [now] = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now', []);
  const [n] = await tx.query<Record<string, number>>(
    `WITH funded AS (
       SELECT DISTINCT g."id"::text AS guild_id FROM "RaidSlot" s
       JOIN ${L} l ON l."id"=s."listingId" JOIN ${G} g ON g."id"::text=l."guildId"
       WHERE s."fundingRef" IS NOT NULL),
     guild_outcomes AS (
       SELECT g."id"::text AS guild_id,count(*) AS outcomes FROM "EngagementClosure" c
       JOIN ${E} e ON e."id"=c."engagementId" JOIN ${G} g ON g."id"::text=e."guildId"
       WHERE c."reason"='ACCEPTED' GROUP BY 1),
     engaged AS (
       SELECT m."participantId"::text AS participant_id,count(*) AS engagements FROM "EngagementMember" m
       JOIN ${P} p ON p."id"::text=m."participantId"::text
       JOIN ${E} e ON e."id"=m."engagementId" JOIN ${G} g ON g."id"::text=e."guildId" GROUP BY 1),
     applied AS (
       SELECT a."participantId"::text AS participant_id FROM "RaidApplication" a
       JOIN ${P} p ON p."id"::text=a."participantId"::text
       JOIN "RaidSlot" s ON s."id"=a."slotId" JOIN ${L} l ON l."id"=s."listingId"
       JOIN ${G} g ON g."id"::text=l."guildId"),
     participant_outcomes AS (
       SELECT m."participantId"::text AS participant_id,count(*) AS outcomes FROM "EngagementMember" m
       JOIN ${P} p ON p."id"::text=m."participantId"::text
       JOIN "EngagementClosure" c ON c."engagementId"=m."engagementId" AND c."reason"='ACCEPTED'
       JOIN ${E} e ON e."id"=m."engagementId" JOIN ${G} g ON g."id"::text=e."guildId" GROUP BY 1)
     SELECT
      (SELECT count(*) FROM ${G} g)::int AS guilds,
      (SELECT count(*) FROM funded)::int AS guilds_funded,
      (SELECT count(*) FROM guild_outcomes)::int AS guilds_with_outcome,
      (SELECT count(*) FROM guild_outcomes WHERE outcomes>=2)::int AS guilds_repeat,
      (SELECT count(*) FROM (SELECT participant_id FROM engaged UNION SELECT participant_id FROM applied) u)::int AS raiders,
      (SELECT count(*) FROM engaged)::int AS raiders_engaged,
      (SELECT count(*) FROM participant_outcomes)::int AS raiders_with_outcome,
      (SELECT count(*) FROM participant_outcomes WHERE outcomes>=2)::int AS raiders_repeat,
      (SELECT count(*) FROM ${L} l WHERE NOT EXISTS (SELECT 1 FROM "Guild" g WHERE g."id"::text=l."guildId"))::int AS listings_unverified,
      (SELECT count(*) FROM ${E} e WHERE NOT EXISTS (SELECT 1 FROM "Guild" g WHERE g."id"::text=e."guildId"))::int AS engagements_unverified`,
    [],
  );
  const [funnel] = await tx.query<Record<string, number>>(
    `WITH verified AS (
       SELECT l."id" FROM ${L} l JOIN ${G} g ON g."id"::text=l."guildId"),
     funded AS (
       SELECT DISTINCT s."listingId" AS id FROM "RaidSlot" s JOIN verified v ON v."id"=s."listingId"
       WHERE s."fundingRef" IS NOT NULL),
     accepted AS (
       SELECT DISTINCT s."listingId" AS id FROM ${E} e JOIN "RaidSlot" s ON s."id"=e."slotId"
       JOIN funded f ON f.id=s."listingId" WHERE s."fundingRef" IS NOT NULL),
     work_accepted AS (
       SELECT DISTINCT s."listingId" AS id FROM ${E} e JOIN "RaidSlot" s ON s."id"=e."slotId"
       JOIN accepted a ON a.id=s."listingId"
       JOIN "EngagementClosure" c ON c."engagementId"=e."id" AND c."reason"='ACCEPTED')
     SELECT (SELECT count(*) FROM verified)::int AS drafted,(SELECT count(*) FROM funded)::int AS funded,
      (SELECT count(*) FROM accepted)::int AS accepted,(SELECT count(*) FROM work_accepted)::int AS work_accepted`,
    [],
  );
  const dueRows = await tx.query<AssetRow>(
    `SELECT r->'policy'->'assetId' AS asset,
      min((r->'policy'->>'verifiedDecimals')::int) AS min_decimals,max((r->'policy'->>'verifiedDecimals')::int) AS max_decimals,
      count(DISTINCT d.id)::int AS all_engagements,sum((r->>'amount')::numeric)::text AS all_amount,
      (count(DISTINCT d.id) FILTER (WHERE d.resolved))::int AS subset_engagements,
      COALESCE(sum((r->>'amount')::numeric) FILTER (WHERE d.resolved),0)::text AS subset_amount
     FROM (
      SELECT e."id",c."financialResolution"<>'OPEN' AS resolved,raid_effective_terms(e."id") AS terms FROM ${E} e
       JOIN ${G} g ON g."id"::text=e."guildId"
       JOIN "EngagementClosure" c ON c."engagementId"=e."id" AND c."reason"='ACCEPTED') d,
      jsonb_array_elements(d.terms->'rewards') r GROUP BY 1`,
    [],
  );
  const disputedRows = await tx.query<AssetRow>(
    `SELECT r->'policy'->'assetId' AS asset,
      min((r->'policy'->>'verifiedDecimals')::int) AS min_decimals,max((r->'policy'->>'verifiedDecimals')::int) AS max_decimals,
      count(DISTINCT d.id)::int AS all_engagements,sum((r->>'amount')::numeric)::text AS all_amount,
      (count(DISTINCT d.id) FILTER (WHERE d.is_open))::int AS subset_engagements,
      COALESCE(sum((r->>'amount')::numeric) FILTER (WHERE d.is_open),0)::text AS subset_amount
     FROM (
      SELECT e."id",e."state"='SUBMITTED' AS is_open,raid_effective_terms(e."id") AS terms FROM ${E} e
       JOIN ${G} g ON g."id"::text=e."guildId"
       WHERE EXISTS (SELECT 1 FROM "WorkReview" w WHERE w."engagementId"=e."id" AND w."decision"='DISPUTE')) d,
      jsonb_array_elements(d.terms->'rewards') r GROUP BY 1`,
    [],
  );
  const [disputeCounts] = await tx.query<{ raised: number; open: number }>(
    `SELECT count(*)::int AS raised,(count(*) FILTER (WHERE e."state"='SUBMITTED'))::int AS open FROM ${E} e
      JOIN ${G} g ON g."id"::text=e."guildId"
      WHERE EXISTS (SELECT 1 FROM "WorkReview" w WHERE w."engagementId"=e."id" AND w."decision"='DISPUTE')`,
    [],
  );
  const [delay] = await tx.query<Record<string, number>>(
    `SELECT count(*)::int AS submissions,count(r."submissionId")::int AS decided,
      (SELECT count(*) FROM "WorkSubmission" x JOIN ${E} e ON e."id"=x."engagementId"
        WHERE NOT EXISTS (SELECT 1 FROM "Guild" g WHERE g."id"::text=e."guildId"))::int AS unverified,
      (count(*) FILTER (WHERE extract(epoch FROM r."createdAt"-w."createdAt")<=3600))::int AS le_1h,
      (count(*) FILTER (WHERE extract(epoch FROM r."createdAt"-w."createdAt")>3600 AND extract(epoch FROM r."createdAt"-w."createdAt")<=14400))::int AS le_4h,
      (count(*) FILTER (WHERE extract(epoch FROM r."createdAt"-w."createdAt")>14400 AND extract(epoch FROM r."createdAt"-w."createdAt")<=86400))::int AS le_1d,
      (count(*) FILTER (WHERE extract(epoch FROM r."createdAt"-w."createdAt")>86400 AND extract(epoch FROM r."createdAt"-w."createdAt")<=259200))::int AS le_3d,
      (count(*) FILTER (WHERE extract(epoch FROM r."createdAt"-w."createdAt")>259200))::int AS gt_3d
     FROM "WorkSubmission" w JOIN ${E} e ON e."id"=w."engagementId" JOIN ${G} g ON g."id"::text=e."guildId"
     LEFT JOIN "WorkReview" r ON r."submissionId"=w."id"`,
    [],
  );
  const guildBasis = 'Persisted (operator-activated) Guilds.';
  const listingBasis =
    'Work listings under a persisted (operator-activated) Guild, in any state, including drafts that were never published.';
  const FUNDED =
    'Funded means a slot of the listing holds a simulated funding reference; no live balance is implied.';
  const page = {
    version: 'v1',
    generatedAt: now.now.toISOString(),
    fundingMode: 'SIMULATED',
    definitions: 'DEFAULT_NOT_OWNER_POLICY',
    guildActivation: ratio(
      n.guilds_funded,
      n.guilds,
      guildBasis +
        ' Numerator: Guilds with a published slot holding a simulated funding reference.',
      [VERIFIED, NO_MARKERS, 'Simulated funding only: no live balance or payment is implied.'],
    ),
    guildFirstOutcome: ratio(
      n.guilds_with_outcome,
      n.guilds,
      guildBasis + ' Numerator: Guilds with at least one engagement closed as work accepted.',
      [VERIFIED, NO_MARKERS, 'Work accepted is not payment.'],
    ),
    guildRepeat: ratio(
      n.guilds_repeat,
      n.guilds_with_outcome,
      'Guilds with at least one work-accepted engagement. Numerator: Guilds with two or more (a default meaning of returning for another valid engagement).',
      [VERIFIED, NO_MARKERS, 'Engagements not accepted do not count as valid.'],
    ),
    raiderActivation: ratio(
      n.raiders_engaged,
      n.raiders,
      'Distinct participants who applied to, or are a member of an engagement on, a verified-Guild slot. Numerator: those who hold or held an engagement.',
      [
        VERIFIED,
        NO_MARKERS,
        'Participants with no application or engagement are not in the denominator.',
      ],
    ),
    raiderFirstOutcome: ratio(
      n.raiders_with_outcome,
      n.raiders_engaged,
      'Distinct participants who hold or held a verified-Guild engagement. Numerator: those with at least one work-accepted engagement.',
      [VERIFIED, NO_MARKERS, 'Work accepted is not payment.'],
    ),
    raiderRepeat: ratio(
      n.raiders_repeat,
      n.raiders_with_outcome,
      'Distinct participants with at least one work-accepted engagement. Numerator: those with two or more.',
      [VERIFIED, NO_MARKERS, 'Each member of a shared engagement is counted once per engagement.'],
    ),
    workListingFunnel: {
      unit: 'WORK_LISTING',
      drafted: {
        count: funnel.drafted,
        definition: listingBasis,
        exclusions: [VERIFIED, NO_MARKERS],
      },
      fundedFromDrafted: ratio(
        funnel.funded,
        funnel.drafted,
        listingBasis + ' Numerator: those with a funded slot. ' + FUNDED,
        [VERIFIED, NO_MARKERS, 'Each listing counts once however many slots it has.'],
      ),
      acceptedFromFunded: ratio(
        funnel.accepted,
        funnel.funded,
        'Funded listings under a persisted Guild. Numerator: those with at least one accepted (committed) engagement on a funded slot.',
        [VERIFIED, NO_MARKERS, 'Accepting an engagement is not work accepted and not payment.'],
      ),
      workAcceptedFromAccepted: ratio(
        funnel.work_accepted,
        funnel.accepted,
        'Listings with an accepted engagement under a persisted Guild. Numerator: those with at least one engagement closed as work accepted.',
        [VERIFIED, NO_MARKERS, 'Work accepted is not payment; submitted-only work is not counted.'],
      ),
      workAcceptedFromDrafted: ratio(
        funnel.work_accepted,
        funnel.drafted,
        listingBasis + ' Numerator: those with at least one engagement closed as work accepted.',
        [VERIFIED, NO_MARKERS, 'The whole funnel from draft; paid is not measured.'],
      ),
      paid: null,
    },
    settlement: {
      definition:
        'Due: engagements closed as work accepted under a persisted Guild, with the reward legs of their effective (amended) terms, per asset. Resolved: those whose closure financial resolution is no longer OPEN.',
      exclusions: [VERIFIED, NO_MARKERS, TERMINATED_NOT_DUE, UNVALUED],
      valuation: 'NOT_VALUED',
      byAsset: perAsset(dueRows).map((row) => ({
        assetKey: row.key,
        assetId: row.asset,
        decimals: row.max_decimals,
        dueEngagements: row.all_engagements,
        dueAmount: row.all_amount,
        resolvedEngagements: row.subset_engagements,
        resolvedAmount: row.subset_amount,
      })),
    },
    disputes: {
      definition:
        'Raised: engagements under a persisted Guild with a review decision of dispute. Open: those still awaiting a decision (not closed). Amounts are the reward legs of their effective terms at stake, per asset.',
      exclusions: [
        VERIFIED,
        NO_MARKERS,
        'No dispute category, finding or resolution is recorded, so none is reported; a closed dispute is only "not open".',
        UNVALUED,
      ],
      valuation: 'NOT_VALUED',
      raised: disputeCounts.raised,
      open: disputeCounts.open,
      byAsset: perAsset(disputedRows).map((row) => ({
        assetKey: row.key,
        assetId: row.asset,
        decimals: row.max_decimals,
        raisedEngagements: row.all_engagements,
        raisedAmount: row.all_amount,
        openEngagements: row.subset_engagements,
        openAmount: row.subset_amount,
      })),
    },
    reviewDelay: {
      decided: ratio(
        delay.decided,
        delay.submissions,
        'Work submissions of engagements under a persisted Guild. Numerator: those with a substantive review decision (accept, revision or dispute).',
        [
          VERIFIED,
          NO_MARKERS,
          PAUSES,
          'Undecided submissions are not in the distribution, so it understates the wait while reviews are outstanding.',
        ],
      ),
      timing: await timing(
        tx,
        `SELECT extract(epoch FROM r."createdAt"-w."createdAt") AS seconds FROM "WorkSubmission" w
         JOIN ${E} e ON e."id"=w."engagementId" JOIN ${G} g ON g."id"::text=e."guildId"
         JOIN "WorkReview" r ON r."submissionId"=w."id"`,
      ),
      distribution: DELAY_BUCKETS.map((bucket) => ({
        bucket,
        count: delay[bucket.toLowerCase()],
      })),
    },
    timings: {
      guildToFirstFundedOffering: await timing(
        tx,
        `SELECT extract(epoch FROM f.first_at-g."createdAt") AS seconds FROM ${G} g JOIN (
           SELECT l."guildId" AS guild_id,min(s."createdAt") AS first_at FROM "RaidSlot" s
           JOIN ${L} l ON l."id"=s."listingId" WHERE s."fundingRef" IS NOT NULL GROUP BY 1) f
         ON f.guild_id=g."id"::text`,
      ),
      guildToFirstOutcome: await timing(
        tx,
        `SELECT extract(epoch FROM a.first_at-g."createdAt") AS seconds FROM ${G} g JOIN (
           SELECT e."guildId" AS guild_id,min(c."closedAt") AS first_at FROM "EngagementClosure" c
           JOIN ${E} e ON e."id"=c."engagementId" WHERE c."reason"='ACCEPTED' GROUP BY 1) a
         ON a.guild_id=g."id"::text`,
      ),
      raiderToFirstOutcome: await timing(
        tx,
        `SELECT extract(epoch FROM a.first_at-p."createdAt") AS seconds FROM ${P} p JOIN (
           SELECT m."participantId" AS participant_id,min(c."closedAt") AS first_at FROM "EngagementMember" m
           JOIN "EngagementClosure" c ON c."engagementId"=m."engagementId" AND c."reason"='ACCEPTED'
           JOIN ${E} e ON e."id"=m."engagementId" JOIN ${G} g ON g."id"::text=e."guildId" GROUP BY 1) a
         ON a.participant_id=p."id"`,
      ),
    },
    excluded: {
      listingsWithoutVerifiedGuild: n.listings_unverified,
      engagementsWithoutVerifiedGuild: n.engagements_unverified,
      submissionsWithoutVerifiedGuild: delay.unverified,
    },
    notMeasured: NOT_MEASURED,
  };
  // DEC-2026-11-13-10(b): `launchConversion` is the deprecated one-version alias of the work-listing funnel.
  return ProductMetricsSchema.parse({ ...page, launchConversion: page.workListingFunnel });
}
