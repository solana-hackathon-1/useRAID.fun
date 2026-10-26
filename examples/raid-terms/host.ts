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
import type { LockTransaction } from './identity-locks';
import { commitEngagement } from './work-loop/engagement-storage';
import type { AcceptanceHost } from './work-loop/engagement-contracts';
import { submitApplication, issueOffer } from './work-loop/admission-storage';
import type { AdmissionHost } from './work-loop/admission-contracts';
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
      const port: CommandReceiptTransaction & LockTransaction = {
        identityLayout: { xKeyColumn: null, children: ['Session', 'Participant'] },
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
      };
      const result = await work(port);
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
  await pool.query(`
    CREATE TABLE "Session" ("tokenHash" text PRIMARY KEY,"userId" text NOT NULL REFERENCES "User","via" text NOT NULL,"expiresAt" timestamp(3) NOT NULL);
    CREATE TABLE "Participant" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),"accountId" text NOT NULL UNIQUE REFERENCES "User" ON DELETE RESTRICT ON UPDATE RESTRICT,"kind" text NOT NULL DEFAULT 'HUMAN' CHECK ("kind"='HUMAN'));
    CREATE TABLE "WalletIdentity" ("address" text PRIMARY KEY,"userId" text NOT NULL REFERENCES "User");
    CREATE TABLE "WalletLink" ("id" uuid PRIMARY KEY,"address" text NOT NULL,"accountId" text NOT NULL REFERENCES "User");
    CREATE TABLE "HostAcceptance" ("slotId" uuid NOT NULL,"termsVersionId" uuid NOT NULL,"participantId" uuid NOT NULL REFERENCES "Participant","consentRef" text NOT NULL,"beneficiaryRef" text NOT NULL,"eligibilityPolicyVersion" text NOT NULL,PRIMARY KEY ("slotId","participantId"));
    CREATE FUNCTION host_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic canonical identity is immutable'; END $$;
    CREATE TRIGGER participant_immutable BEFORE UPDATE OR DELETE ON "Participant" FOR EACH ROW EXECUTE FUNCTION host_identity_immutable();
  `);
  for (const file of [
    'migrations/receipts.sql',
    'migrations/terms.sql',
    'migrations/capacity.sql',
    'migrations/admission.sql',
  ])
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
  await pool.query(
    "INSERT INTO \"Session\" VALUES ($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')",
    [actor.sessionHash, actor.accountId],
  );
  // Actual minimal canonical HUMAN identity/session and exact-source consent owned by this host.
  const member = { accountId: 'synthetic-member', sessionHash: 'b'.repeat(64) };
  await pool.query('INSERT INTO "User" ("id") VALUES ($1)', [member.accountId]);
  await pool.query(
    "INSERT INTO \"Session\" VALUES ($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')",
    [member.sessionHash, member.accountId],
  );
  const participant = (
    await pool.query('INSERT INTO "Participant" ("accountId") VALUES ($1) RETURNING "id"::text', [
      member.accountId,
    ])
  ).rows[0] as { id: string };
  await pool.query('INSERT INTO "HostAcceptance" VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)', [
    published.slotId,
    saved.termsVersionId,
    participant.id,
    'synthetic-explicit-consent',
    'synthetic-fixed-beneficiary',
    'synthetic-eligibility-v1',
  ]);
  const acceptance: AcceptanceHost = {
    allowNewWrites: true,
    async assess(tx, c) {
      const found = await tx.query<{
        consentRef: string;
        beneficiaryRef: string;
        eligibilityPolicyVersion: string;
      }>(
        'SELECT "consentRef","beneficiaryRef","eligibilityPolicyVersion" FROM "HostAcceptance" WHERE "slotId"=$1::uuid AND "termsVersionId"=$2::uuid AND "participantId"=$3::uuid FOR SHARE',
        [c.slotId, c.termsVersionId, c.participantId],
      );
      return found.length === 1 ? { ...found[0], operatorId: null } : null;
    },
    async fundingAvailable(tx, b) {
      const found = await tx.query(
        'SELECT "slotId" FROM "HostReservation" WHERE "slotId"=$1::uuid AND "termsVersionId"=$2::uuid AND "digest"=$3 FOR SHARE',
        [b.slotId, b.termsVersionId, JSON.stringify(b.terms.rewards)],
      );
      return b.fundingRef === 'synthetic:' + b.slotId && found.length === 1;
    },
  };
  const commit = {
    actor: member,
    input: { slotId: published.slotId, termsVersionId: saved.termsVersionId },
    idempotencyKey: 'synthetic-commit',
    requestId: 'synthetic-commit',
  };
  const engagement = await transaction((tx) => commitEngagement(tx, commit, acceptance));
  assert.equal(engagement.engagement.state, 'ACCESS_PENDING');
  assert.equal(engagement.engagement.acceptedTerms.roster[0].participantId, participant.id);
  assert.equal((await pool.query('SELECT * FROM "ActiveCommitment"')).rowCount, 1);
  assert.equal(
    (
      await transaction((tx) =>
        commitEngagement(tx, commit, {
          ...acceptance,
          allowNewWrites: false,
          assess: async () => null,
          fundingAvailable: async () => false,
        }),
      )
    ).status,
    'REPLAYED',
  );
  const otherTerms = await transaction((tx) => saveRaidTerms(tx, command(input), host));
  const otherSlot = await transaction((tx) =>
    publishRaid(
      tx,
      command({ listingId: otherTerms.listingId, termsVersionId: otherTerms.termsVersionId }),
      host,
    ),
  );
  await pool.query('INSERT INTO "HostAcceptance" VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)', [
    otherSlot.slotId,
    otherTerms.termsVersionId,
    participant.id,
    'synthetic-second-consent',
    'synthetic-fixed-beneficiary',
    'synthetic-eligibility-v1',
  ]);
  await assert.rejects(
    transaction((tx) =>
      commitEngagement(
        tx,
        {
          ...commit,
          input: { slotId: otherSlot.slotId, termsVersionId: otherTerms.termsVersionId },
          idempotencyKey: 'second-intent',
        },
        acceptance,
      ),
    ),
    (error: unknown) => (error as { code: string }).code === 'CAPACITY_CONFLICT',
  );
  assert.equal((await pool.query('SELECT * FROM "Engagement"')).rowCount, 1);
  const admissions: AdmissionHost = {
    allowNewWrites: true,
    applicationLimit: 5,
    authorize: host.authorize,
  };
  const appTerms = await transaction((tx) =>
    saveRaidTerms(
      tx,
      command({ ...input, terms: { ...input.terms, admission: 'APPLICATION' } }),
      host,
    ),
  );
  const appSlot = await transaction((tx) =>
    publishRaid(
      tx,
      command({ listingId: appTerms.listingId, termsVersionId: appTerms.termsVersionId }),
      host,
    ),
  );
  const applicantCommand = (input: unknown) => ({ ...command(input), actor: member });
  const application = await transaction((tx) =>
    submitApplication(
      tx,
      applicantCommand({
        slotId: appSlot.slotId,
        termsVersionId: appTerms.termsVersionId,
        evidenceRefs: ['synthetic:portfolio'],
      }),
      admissions,
    ),
  );
  const offer = await transaction((tx) =>
    issueOffer(
      tx,
      command({
        applicationId: application.application.id,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      admissions,
    ),
  );
  await pool.query('INSERT INTO "HostAcceptance" VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)', [
    appSlot.slotId,
    appTerms.termsVersionId,
    participant.id,
    'synthetic-offer-consent',
    'synthetic-beneficiary',
    'synthetic-eligibility-v1',
  ]);
  await assert.rejects(
    transaction((tx) =>
      commitEngagement(
        tx,
        applicantCommand({
          slotId: appSlot.slotId,
          termsVersionId: appTerms.termsVersionId,
          offerId: offer.offer.id,
        }),
        acceptance,
      ),
    ),
    (e: unknown) => (e as { code: string }).code === 'CAPACITY_CONFLICT',
  );
  // A separate current candidate accepts the same exact slot after the first candidate is busy.
  const candidate = { accountId: 'synthetic-candidate', sessionHash: 'c'.repeat(64) };
  await pool.query('INSERT INTO "User" ("id") VALUES ($1)', [candidate.accountId]);
  await pool.query(
    "INSERT INTO \"Session\" VALUES ($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')",
    [candidate.sessionHash, candidate.accountId],
  );
  const p2 = (
    await pool.query('INSERT INTO "Participant" ("accountId") VALUES ($1) RETURNING "id"::text', [
      candidate.accountId,
    ])
  ).rows[0] as { id: string };
  const candidateCommand = (input: unknown) => ({ ...command(input), actor: candidate });
  const a2 = await transaction((tx) =>
    submitApplication(
      tx,
      candidateCommand({
        slotId: appSlot.slotId,
        termsVersionId: appTerms.termsVersionId,
        evidenceRefs: [],
      }),
      admissions,
    ),
  );
  const o2 = await transaction((tx) =>
    issueOffer(
      tx,
      command({
        applicationId: a2.application.id,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      admissions,
    ),
  );
  await pool.query('INSERT INTO "HostAcceptance" VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)', [
    appSlot.slotId,
    appTerms.termsVersionId,
    p2.id,
    'synthetic-second-offer-consent',
    'synthetic-beneficiary-2',
    'synthetic-eligibility-v1',
  ]);
  const selected = await transaction((tx) =>
    commitEngagement(
      tx,
      candidateCommand({
        slotId: appSlot.slotId,
        termsVersionId: appTerms.termsVersionId,
        offerId: o2.offer.id,
      }),
      acceptance,
    ),
  );
  assert.equal(selected.engagement.state, 'ACCESS_PENDING');
  const previousOffer = (
    await pool.query('SELECT "state" FROM "RaidOffer" WHERE "id"=$1::uuid', [offer.offer.id])
  ).rows[0] as { state: string };
  assert.equal(previousOffer.state, 'REVOKED');
  await pool.query('DELETE FROM "Session" WHERE "tokenHash"=$1', [member.sessionHash]);
  await assert.rejects(
    transaction((tx) => commitEngagement(tx, commit, acceptance)),
    (error: unknown) => (error as { code: string }).code === 'UNAUTHENTICATED',
  );
  assert.equal(
    (await pool.query('SELECT * FROM "ActiveCommitment"')).rowCount,
    2,
    'Session loss does not close work.',
  );
  await pool.query('DELETE FROM "HostGuildAuthority" WHERE "guildId"=$1', [guild]);
  await assert.rejects(
    transaction((tx) => readRaidTerms(tx, actor, saved.termsVersionId, host)),
    (e: unknown) => (e as { code: string }).code === 'FORBIDDEN',
  );
  console.log(
    'PASS: independent PG host terms/publication/applications/offers/consent/capacity/receipt recovery/revocation; SIMULATED ONLY.',
  );
} finally {
  await pool.end();
}
