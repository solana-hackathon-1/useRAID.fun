import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readProductMetrics } from './metrics/storage';
import { ProductMetricsSchema } from './metrics/contracts';
import {
  createProductMetricsHandlers,
  MetricsHttpError,
  type ProductMetricsHttpHost,
} from './metrics/http';

interface PgClient {
  query(sql: string, bindings?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}
const { Pool } = createRequire(import.meta.url)('pg') as {
  Pool: new (options: { connectionString: string }) => {
    connect(): Promise<PgClient>;
    end(): Promise<void>;
  };
};
const url = process.env.DATABASE_URL;
assert(
  url && new URL(url).pathname === '/raid_metrics_example',
  'Use the empty raid_metrics_example database.',
);
const pool = new Pool({ connectionString: url });

// The host's own minimal tables: only the columns the portable metrics read. A real host maps its own schema.
const SCHEMA = `
CREATE TABLE "Guild" ("id" uuid PRIMARY KEY, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "Participant" ("id" uuid PRIMARY KEY, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "WorkListing" ("id" uuid PRIMARY KEY, "guildId" text NOT NULL);
CREATE TABLE "RaidSlot" ("id" uuid PRIMARY KEY, "listingId" uuid NOT NULL, "fundingRef" text, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "Engagement" ("id" uuid PRIMARY KEY, "slotId" uuid NOT NULL, "guildId" text NOT NULL, "state" text NOT NULL, "terms" jsonb NOT NULL);
CREATE TABLE "EngagementClosure" ("engagementId" uuid PRIMARY KEY, "reason" text NOT NULL, "financialResolution" text NOT NULL DEFAULT 'OPEN', "closedAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "EngagementMember" ("engagementId" uuid NOT NULL, "participantId" uuid NOT NULL);
CREATE TABLE "RaidApplication" ("participantId" uuid NOT NULL, "slotId" uuid NOT NULL);
CREATE TABLE "WorkSubmission" ("id" uuid PRIMARY KEY, "engagementId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "WorkReview" ("submissionId" uuid PRIMARY KEY, "engagementId" uuid NOT NULL, "decision" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "MetricsExclusion" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "subjectType" text NOT NULL, "subjectId" text NOT NULL, "effect" text NOT NULL, "supersedesMarkerId" uuid);
-- The host's own rule for an engagement's current terms (here its stored terms; the application applies amendments).
CREATE FUNCTION raid_effective_terms(target uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT "terms" FROM "Engagement" WHERE "id"=target $$;`;
const SOL = { chain: 'SOLANA', networkIdentity: 'example', kind: 'NATIVE_SOL' };
const TOKEN = {
  chain: 'SOLANA',
  networkIdentity: 'example',
  kind: 'TOKEN',
  mint: 'So11111111111111111111111111111111111111112',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};
const leg = (assetId: object, decimals: number, amount: string) => ({
  policy: { assetId, verifiedDecimals: decimals },
  amount,
});

async function transaction<T>(work: (client: PgClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const insert = (client: PgClient, sql: string, ...bindings: unknown[]) =>
  client.query(sql, bindings);

try {
  await transaction(async (client) => {
    await client.query(SCHEMA);
    const [guildA, guildB] = [randomUUID(), randomUUID()];
    const [raider, newcomer] = [randomUUID(), randomUUID()];
    for (const id of [guildA, guildB])
      await insert(client, 'INSERT INTO "Guild" ("id") VALUES ($1)', id);
    for (const id of [raider, newcomer])
      await insert(client, 'INSERT INTO "Participant" ("id") VALUES ($1)', id);
    // Guild A has a funded offering and one accepted engagement; Guild B has nothing yet.
    const [listing, slot, engagement] = [randomUUID(), randomUUID(), randomUUID()];
    await insert(
      client,
      'INSERT INTO "WorkListing" ("id","guildId") VALUES ($1,$2)',
      listing,
      guildA,
    );
    await insert(
      client,
      'INSERT INTO "RaidSlot" ("id","listingId","fundingRef") VALUES ($1,$2,$3)',
      slot,
      listing,
      'synthetic:funding',
    );
    const engagementSql =
      'INSERT INTO "Engagement" ("id","slotId","guildId","state","terms") VALUES ($1,$2,$3,$4,$5::jsonb)';
    await insert(
      client,
      engagementSql,
      engagement,
      slot,
      guildA,
      'ACCEPTED',
      JSON.stringify({ rewards: [leg(SOL, 9, '100'), leg(TOKEN, 6, '5')] }),
    );
    await insert(client, 'INSERT INTO "EngagementMember" VALUES ($1,$2)', engagement, raider);
    await insert(
      client,
      `INSERT INTO "EngagementClosure" ("engagementId","reason") VALUES ($1,'ACCEPTED')`,
      engagement,
    );
    // A second funded slot whose engagement was submitted and disputed: still open, 7 of the token at stake.
    const [slot2, disputed, submission, submission2] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await insert(
      client,
      'INSERT INTO "RaidSlot" ("id","listingId","fundingRef") VALUES ($1,$2,$3)',
      slot2,
      listing,
      'synthetic:funding-2',
    );
    await insert(
      client,
      engagementSql,
      disputed,
      slot2,
      guildA,
      'SUBMITTED',
      JSON.stringify({ rewards: [leg(TOKEN, 6, '7')] }),
    );
    for (const [id, owner, decision] of [
      [submission, engagement, 'ACCEPT'],
      [submission2, disputed, 'DISPUTE'],
    ] as const) {
      await insert(
        client,
        `INSERT INTO "WorkSubmission" ("id","engagementId","createdAt") VALUES ($1,$2,clock_timestamp()-interval '2 hours')`,
        id,
        owner,
      );
      await insert(
        client,
        'INSERT INTO "WorkReview" ("submissionId","engagementId","decision") VALUES ($1,$2,$3)',
        id,
        owner,
        decision,
      );
    }
    // A listing that was only ever drafted.
    await insert(
      client,
      'INSERT INTO "WorkListing" ("id","guildId") VALUES ($1,$2)',
      randomUUID(),
      guildA,
    );
    await insert(client, 'INSERT INTO "RaidApplication" VALUES ($1,$2)', newcomer, slot);
    // Work under an unknown Guild id is left out of every figure and counted as excluded.
    const strayListing = randomUUID();
    await insert(
      client,
      'INSERT INTO "WorkListing" ("id","guildId") VALUES ($1,$2)',
      strayListing,
      'not-a-persisted-guild',
    );
  });

  const read = () =>
    transaction((client) =>
      readProductMetrics({
        dialect: 'POSTGRESQL',
        isolation: 'READ_COMMITTED',
        query: async <Row>(sql: string, bindings: readonly unknown[]) =>
          (await client.query(sql, bindings)).rows as Row[],
      } as Parameters<typeof readProductMetrics>[0]),
    );
  const metrics = ProductMetricsSchema.parse(await read());
  // The host's own marker rows (its writer is the application's): an effective EXCLUDE removes the Guild, a later
  // RELEASE of the same chain restores it.
  const guildCount = async () =>
    ProductMetricsSchema.parse(await read()).guildActivation.denominator;
  const marked = randomUUID();
  await transaction(async (client) => {
    await insert(
      client,
      'INSERT INTO "MetricsExclusion" ("id","subjectType","subjectId","effect") SELECT $1,\'GUILD\',"id"::text,\'EXCLUDE\' FROM "Guild" ORDER BY "id" LIMIT 1',
      marked,
    );
  });
  const guildsWhileMarked = await guildCount();
  await transaction(async (client) => {
    await insert(
      client,
      'INSERT INTO "MetricsExclusion" ("subjectType","subjectId","effect","supersedesMarkerId") SELECT "subjectType","subjectId",\'RELEASE\',"id" FROM "MetricsExclusion" WHERE "id"=$1',
      marked,
    );
  });
  const guildsAfterRelease = await guildCount();

  // The host owns the flag and operator authority; the module owns the contract and the refusals.
  let enabled = false;
  let operator: string | null = null;
  const host: ProductMetricsHttpHost = {
    version: 'v1',
    requestId: randomUUID,
    available: () => enabled,
    authorize: async () => {
      if (!operator) throw new MetricsHttpError(403);
      return operator;
    },
    rateLimit: async () => {},
    metrics: read,
  };
  const handlers = createProductMetricsHandlers(host);
  const call = (query = '') =>
    handlers.GET(new Request('http://host.invalid/api/v1/admin/metrics/product' + query));
  const flagOff = (await call()).status;
  enabled = true;
  const notOperator = (await call()).status;
  operator = randomUUID();
  const withQuery = (await call('?guildId=x')).status;
  const ok = await call();
  const body = await ok.json();
  const text = JSON.stringify({ ...body, notMeasured: undefined });
  const tokenKey = JSON.stringify(['SOLANA', 'example', 'TOKEN', TOKEN.mint, TOKEN.tokenProgram]);
  const dueToken = metrics.settlement.byAsset.find((row) => row.assetKey === tokenKey);
  const disputedToken = metrics.disputes.byAsset.find((row) => row.assetKey === tokenKey);
  const moneyField = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.some(moneyField)
      : value && typeof value === 'object'
        ? Object.entries(value).some(
            ([key, child]) =>
              /usd|dollar|price|total|volume|worth|sum/i.test(key) || moneyField(child),
          )
        : false;

  console.log(
    JSON.stringify(
      {
        synthetic: true,
        flagOffIsAbsent: flagOff === 404,
        nonOperatorForbidden: notOperator === 403,
        queryScopeRefused: withQuery === 422,
        operatorReadOk:
          ok.status === 200 && ok.headers.get('cache-control') === 'private, no-store',
        guildActivationHasDenominator:
          metrics.guildActivation.numerator === 1 && metrics.guildActivation.denominator === 2,
        newcomerCountedInDenominatorOnly:
          metrics.raiderActivation.numerator === 1 && metrics.raiderActivation.denominator === 2,
        unverifiedGuildWorkExcluded: metrics.excluded.listingsWithoutVerifiedGuild === 1,
        funnelSeparatesDraftedFundedAcceptedWorkAcceptedAndPaid:
          metrics.launchConversion.drafted.count === 2 &&
          metrics.launchConversion.fundedFromDrafted.numerator === 1 &&
          metrics.launchConversion.workAcceptedFromAccepted.numerator === 1 &&
          metrics.launchConversion.paid === null,
        settlementAndDisputesStayPerAssetAndUnvalued:
          metrics.settlement.byAsset.length === 2 &&
          dueToken?.dueAmount === '5' &&
          disputedToken?.openAmount === '7' &&
          metrics.settlement.valuation === 'NOT_VALUED' &&
          metrics.disputes.valuation === 'NOT_VALUED',
        reviewDelayIsADecidedOnlyDistribution:
          metrics.reviewDelay.decided.numerator === 2 &&
          metrics.reviewDelay.decided.denominator === 2 &&
          metrics.reviewDelay.distribution.find((b) => b.bucket === 'LE_3D')?.count === 0 &&
          metrics.reviewDelay.distribution.find((b) => b.bucket === 'LE_4H')?.count === 2,
        exclusionMarkerRemovesAndReleaseRestoresAGuild:
          guildsWhileMarked === metrics.guildActivation.denominator - 1 &&
          guildsAfterRelease === metrics.guildActivation.denominator,
        noPriceDollarTotalFieldOrAccount: !moneyField(body) && !text.includes(operator),
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
