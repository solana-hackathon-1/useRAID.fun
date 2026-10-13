import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './connection';
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import { publishSkillTaxonomy } from './skills/taxonomy-storage';
import { saveSkillClaim, readSkillClaim } from './skills/claim-storage';
async function transaction<T>(work: (tx: CommandReceiptTransaction) => Promise<T>): Promise<T> {
  return retryWholeTransaction(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const port: CommandReceiptTransaction = {
        dialect: 'POSTGRESQL',
        isolation: 'READ_COMMITTED',
        async query<Row>(sql: string, bindings: readonly (string | null)[]) {
          try {
            return (await client.query<Row>(sql, bindings)).rows;
          } catch (error) {
            const state = (error as { code?: string }).code;
            throw new CommandReceiptError(
              state === '40001' || state === '40P01' ? 'RETRY_TRANSACTION' : 'STORAGE_UNAVAILABLE',
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
const admin = {
  accountId: 'synthetic-admin-' + randomUUID(),
  sessionHash: createHash('sha256').update(randomUUID()).digest('hex'),
};
const self = {
  accountId: 'synthetic-self-' + randomUUID(),
  sessionHash: createHash('sha256').update(randomUUID()).digest('hex'),
};
const xId = 'synthetic-x-' + randomUUID(),
  catalogId = 'synthetic-catalog-' + randomUUID();
const category = {
  id: 'frontend',
  domain: 'software.frontend',
  name: 'Frontend',
  status: 'ACTIVE',
  aliases: ['frontend'],
};
const key = randomUUID();
const input = {
  taxonomyId: catalogId,
  expectedTaxonomyRevision: 1,
  expectedClaimRevision: 0,
  skillId: 'frontend',
  claimedLevel: 'S',
  supportingReferences: ['https://public.example/portfolio'],
};
const publish = (revision: number, status = 'ACTIVE') =>
  transaction((tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor: admin,
        input: {
          taxonomyId: catalogId,
          expectedRevision: revision,
          skills: [{ ...category, status }],
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-catalog',
      },
      { allowNewWrites: true, canPublish: (user) => user.xId === xId },
    ),
  );
const save = (allowNewWrites = true) =>
  transaction((tx) =>
    saveSkillClaim(
      tx,
      { actor: self, input, idempotencyKey: key, requestId: 'synthetic-claim' },
      { allowNewWrites },
    ),
  );
try {
  const setup = await pool.connect();
  let participantId: string;
  try {
    await setup.query(
      `INSERT INTO "User"("id","role","xId") VALUES($1,'ADMIN',$2),($3,'CREATOR',NULL)`,
      [admin.accountId, xId, self.accountId],
    );
    for (const a of [admin, self])
      await setup.query(
        `INSERT INTO "Session"("tokenHash","userId","expiresAt") VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')`,
        [a.sessionHash, a.accountId],
      );
    const { rows } = await setup.query<{ id: string }>(
      `INSERT INTO "Participant"("accountId","provisionActorAccountId","provisionRequestId") VALUES($1,$1,'synthetic-provision') RETURNING "id"::text`,
      [self.accountId],
    );
    participantId = rows[0].id;
  } finally {
    setup.release();
  }
  await publish(0);
  const first = await save();
  assert.equal(first.status, 'EXECUTED');
  assert.equal(first.claim.participantId, participantId);
  assert.equal(first.claim.state, 'CLAIMED');
  assert.equal(first.claim.verifiesSkill, false);
  assert.equal(first.claim.persisted, true);
  assert(!('assessedRank' in first.claim));
  assert(!('assessmentHistory' in first.claim));
  await publish(1, 'RETIRED');
  assert.deepEqual(await save(false), { status: 'REPLAYED', claim: first.claim });
  assert.deepEqual(await transaction((tx) => readSkillClaim(tx, self, 'frontend')), first.claim);
  const revoke = await pool.connect();
  try {
    await revoke.query('DELETE FROM "Session" WHERE "tokenHash"=$1', [self.sessionHash]);
  } finally {
    revoke.release();
  }
  await assert.rejects(save(false), { code: 'AUTHENTICATION_REQUIRED' });
  const check = await pool.connect();
  try {
    const { rows } = await check.query<{ n: number }>('SELECT count(*)::int n FROM "OutboxEvent"');
    assert.equal(rows[0].n, 0);
  } finally {
    check.release();
  }
  console.log(
    'PASS: actual canonical HUMAN private claim/evidence persistence, saved catalog binding, original receipt after retirement/write disablement, current session revocation; no assessment/rank/outbox. Synthetic data only.',
  );
} finally {
  await pool.end();
}
