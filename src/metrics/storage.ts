import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import {
  MetricsError,
  ProductMetricsSchema,
  type ProductMetrics,
  type RatioMetric,
} from './contracts';

const NOT_MEASURED = [
  'paidVolume',
  'dollarValue',
  'settlementCompletion',
  'disputeBurden',
  'privateAccessReliability',
  'launchConversion',
  'fixtureExclusion',
  'knownAbuseExclusion',
  'duplicateExclusion',
  'reviewDelayExcludingPauses',
  'opportunityConcentration',
];
const NO_MARKERS =
  'Test fixtures, internal demonstrations and known abuse are not marked in the data, so are not excluded.';
const VERIFIED =
  'Work under a Guild id with no persisted (operator-activated) Guild is excluded and counted under `excluded`.';

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
       JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "Guild" g ON g."id"::text=l."guildId"
       WHERE s."fundingRef" IS NOT NULL),
     guild_outcomes AS (
       SELECT g."id"::text AS guild_id,count(*) AS outcomes FROM "EngagementClosure" c
       JOIN "Engagement" e ON e."id"=c."engagementId" JOIN "Guild" g ON g."id"::text=e."guildId"
       WHERE c."reason"='ACCEPTED' GROUP BY 1),
     engaged AS (
       SELECT m."participantId"::text AS participant_id,count(*) AS engagements FROM "EngagementMember" m
       JOIN "Engagement" e ON e."id"=m."engagementId" JOIN "Guild" g ON g."id"::text=e."guildId" GROUP BY 1),
     applied AS (
       SELECT a."participantId"::text AS participant_id FROM "RaidApplication" a
       JOIN "RaidSlot" s ON s."id"=a."slotId" JOIN "WorkListing" l ON l."id"=s."listingId"
       JOIN "Guild" g ON g."id"::text=l."guildId"),
     participant_outcomes AS (
       SELECT m."participantId"::text AS participant_id,count(*) AS outcomes FROM "EngagementMember" m
       JOIN "EngagementClosure" c ON c."engagementId"=m."engagementId" AND c."reason"='ACCEPTED'
       JOIN "Engagement" e ON e."id"=m."engagementId" JOIN "Guild" g ON g."id"::text=e."guildId" GROUP BY 1)
     SELECT
      (SELECT count(*) FROM "Guild")::int AS guilds,
      (SELECT count(*) FROM funded)::int AS guilds_funded,
      (SELECT count(*) FROM guild_outcomes)::int AS guilds_with_outcome,
      (SELECT count(*) FROM guild_outcomes WHERE outcomes>=2)::int AS guilds_repeat,
      (SELECT count(*) FROM (SELECT participant_id FROM engaged UNION SELECT participant_id FROM applied) u)::int AS raiders,
      (SELECT count(*) FROM engaged)::int AS raiders_engaged,
      (SELECT count(*) FROM participant_outcomes)::int AS raiders_with_outcome,
      (SELECT count(*) FROM participant_outcomes WHERE outcomes>=2)::int AS raiders_repeat,
      (SELECT count(*) FROM "WorkListing" l WHERE NOT EXISTS (SELECT 1 FROM "Guild" g WHERE g."id"::text=l."guildId"))::int AS listings_unverified,
      (SELECT count(*) FROM "Engagement" e WHERE NOT EXISTS (SELECT 1 FROM "Guild" g WHERE g."id"::text=e."guildId"))::int AS engagements_unverified`,
    [],
  );
  const guildBasis = 'Persisted (operator-activated) Guilds.';
  return ProductMetricsSchema.parse({
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
    timings: {
      guildToFirstFundedOffering: await timing(
        tx,
        `SELECT extract(epoch FROM f.first_at-g."createdAt") AS seconds FROM "Guild" g JOIN (
           SELECT l."guildId" AS guild_id,min(s."createdAt") AS first_at FROM "RaidSlot" s
           JOIN "WorkListing" l ON l."id"=s."listingId" WHERE s."fundingRef" IS NOT NULL GROUP BY 1) f
         ON f.guild_id=g."id"::text`,
      ),
      guildToFirstOutcome: await timing(
        tx,
        `SELECT extract(epoch FROM a.first_at-g."createdAt") AS seconds FROM "Guild" g JOIN (
           SELECT e."guildId" AS guild_id,min(c."closedAt") AS first_at FROM "EngagementClosure" c
           JOIN "Engagement" e ON e."id"=c."engagementId" WHERE c."reason"='ACCEPTED' GROUP BY 1) a
         ON a.guild_id=g."id"::text`,
      ),
      raiderToFirstOutcome: await timing(
        tx,
        `SELECT extract(epoch FROM a.first_at-p."createdAt") AS seconds FROM "Participant" p JOIN (
           SELECT m."participantId" AS participant_id,min(c."closedAt") AS first_at FROM "EngagementMember" m
           JOIN "EngagementClosure" c ON c."engagementId"=m."engagementId" AND c."reason"='ACCEPTED'
           JOIN "Engagement" e ON e."id"=m."engagementId" JOIN "Guild" g ON g."id"::text=e."guildId" GROUP BY 1) a
         ON a.participant_id=p."id"`,
      ),
    },
    excluded: {
      listingsWithoutVerifiedGuild: n.listings_unverified,
      engagementsWithoutVerifiedGuild: n.engagements_unverified,
    },
    notMeasured: NOT_MEASURED,
  });
}
