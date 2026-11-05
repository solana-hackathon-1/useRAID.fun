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
CREATE TABLE "Engagement" ("id" uuid PRIMARY KEY, "guildId" text NOT NULL);
CREATE TABLE "EngagementClosure" ("engagementId" uuid PRIMARY KEY, "reason" text NOT NULL, "closedAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "EngagementMember" ("engagementId" uuid NOT NULL, "participantId" uuid NOT NULL);
CREATE TABLE "RaidApplication" ("participantId" uuid NOT NULL, "slotId" uuid NOT NULL);`;

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
    await insert(
      client,
      'INSERT INTO "Engagement" ("id","guildId") VALUES ($1,$2)',
      engagement,
      guildA,
    );
    await insert(client, 'INSERT INTO "EngagementMember" VALUES ($1,$2)', engagement, raider);
    await insert(
      client,
      `INSERT INTO "EngagementClosure" ("engagementId","reason") VALUES ($1,'ACCEPTED')`,
      engagement,
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
        noMoneyAccountOrValuation:
          !/usd|dollar|price|amount|volume|total/i.test(text) && !text.includes(operator),
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
