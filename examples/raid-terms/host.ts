import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
interface PgConnection {
  query(
    sql: string,
    bindings?: readonly (string | null)[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}
interface PgClient extends PgConnection {
  release(): void;
}
interface PgPool extends PgConnection {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
const { Pool } = createRequire(import.meta.url)('pg') as {
  Pool: new (options: { connectionString: string }) => PgPool;
};
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import { saveRaidTerms, publishRaid, readRaidTerms } from './work-loop/storage';
import type { WorkHost } from './work-loop/contracts';
import { raidTerms } from './fixture';
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.pathname, '/raid_terms_example');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  'Use the dedicated loopback example database.',
);
const pool = new Pool({ connectionString: url.toString() });
async function transaction<T>(work: (tx: CommandReceiptTransaction) => Promise<T>): Promise<T> {
  return retryWholeTransaction(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work({
        dialect: 'POSTGRESQL',
        isolation: 'READ_COMMITTED',
        async query<Row>(sql: string, bindings: readonly (string | null)[]) {
          try {
            return (await client.query(sql, [...bindings])).rows as Row[];
          } catch (error) {
            const code = (error as { code?: string }).code;
            throw new CommandReceiptError(
              code === '40P01' || code === '40001' ? 'RETRY_TRANSACTION' : 'STORAGE_UNAVAILABLE',
            );
          }
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
const actor = { accountId: 'synthetic-owner', sessionHash: 'a'.repeat(64) },
  guild = 'synthetic-guild';
const command = (input: unknown, key = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: 'example:' + key,
});
try {
  // This host owns its own authority/session and reservation records. No RAID auth/Prisma/Next import.
  await pool.query(
    'CREATE TABLE "User" ("id" text PRIMARY KEY, "suspended" boolean NOT NULL DEFAULT false); CREATE TABLE "HostSession" ("hash" text PRIMARY KEY,"accountId" text NOT NULL REFERENCES "User", "expiresAt" timestamptz NOT NULL); CREATE TABLE "HostGuildAuthority" ("guildId" text PRIMARY KEY,"accountId" text NOT NULL REFERENCES "User"); CREATE TABLE "HostReservation" ("slotId" uuid PRIMARY KEY,"termsVersionId" uuid NOT NULL,"digest" text NOT NULL)',
  );
  for (const file of ['migrations/receipts.sql', 'migrations/terms.sql'])
    await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  await pool.query('INSERT INTO "User" ("id") VALUES ($1)', [actor.accountId]);
  await pool.query(
    'INSERT INTO "HostSession" VALUES ($1,$2,clock_timestamp()+interval \'1 hour\')',
    [actor.sessionHash, actor.accountId],
  );
  await pool.query('INSERT INTO "HostGuildAuthority" VALUES ($1,$2)', [guild, actor.accountId]);
  const host: WorkHost = {
    allowNewWrites: true,
    async authorize(tx, a, g) {
      const rows = await tx.query(
        'SELECT u."id" FROM "User" u JOIN "HostSession" s ON s."accountId"=u."id" JOIN "HostGuildAuthority" g ON g."accountId"=u."id" WHERE u."id"=$1 AND s."hash"=$2 AND g."guildId"=$3 AND NOT u."suspended" AND s."expiresAt">clock_timestamp() FOR SHARE OF u,s,g',
        [a.accountId, a.sessionHash, g],
      );
      return rows.length === 1;
    },
    async reserveSimulatedFunding(tx, b) {
      // Explicit synthetic reservation, not a real balance or claimed on-chain funding.
      await tx.query(
        'INSERT INTO "HostReservation" VALUES ($1::uuid,$2::uuid,$3) RETURNING "slotId"',
        [b.slotId, b.termsVersionId, JSON.stringify(b.terms.rewards)],
      );
      return 'synthetic:' + b.slotId;
    },
  };
  const input = { listingId: null, expectedRevision: 0, guildId: guild, terms: raidTerms() },
    c = command(input);
  const saved = await transaction((tx) => saveRaidTerms(tx, c, host));
  assert.equal(saved.terms.outcome, input.terms.outcome);
  const published = await transaction((tx) =>
    publishRaid(
      tx,
      command({ listingId: saved.listingId, termsVersionId: saved.termsVersionId }),
      host,
    ),
  );
  assert.equal(published.fundingMode, 'SIMULATED');
  assert.equal((await pool.query('SELECT * FROM "HostReservation"')).rowCount, 1);
  assert.equal(
    (await transaction((tx) => saveRaidTerms(tx, c, { ...host, allowNewWrites: false }))).status,
    'REPLAYED',
  );
  // Alternate current authorization policy is still bounded to the same actual saved authority.
  const alternate: WorkHost = {
    ...host,
    authorize: async (tx, a, g) =>
      g === guild && (await host.authorize(tx, a, g, 'MANAGE_LISTING')),
  };
  assert.equal(
    (await transaction((tx) => readRaidTerms(tx, actor, saved.termsVersionId, alternate)))
      .termsVersionId,
    saved.termsVersionId,
  );
  await pool.query('DELETE FROM "HostGuildAuthority" WHERE "guildId"=$1', [guild]);
  await assert.rejects(
    transaction((tx) => readRaidTerms(tx, actor, saved.termsVersionId, host)),
    (e: unknown) => (e as { code: string }).code === 'FORBIDDEN',
  );
  console.log(
    'PASS: independent PG host save/publication/reservation/replay/alternate policy/revocation; SIMULATED ONLY.',
  );
} finally {
  await pool.end();
}
