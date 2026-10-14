import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './connection';
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import { publishSkillTaxonomy, readPublishedSkillTaxonomy } from './skills/taxonomy-storage';
import { prepareSkillClaim, resolveSkillAlias } from './skills';
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
const accountId = 'synthetic-admin-' + randomUUID();
const xId = 'synthetic-x-' + randomUUID();
const actor = { accountId, sessionHash: createHash('sha256').update(randomUUID()).digest('hex') };
const allowed = new Set([xId]);
const catalogId = 'synthetic-taxonomy-' + randomUUID();
const input = {
  taxonomyId: catalogId,
  expectedRevision: 0,
  skills: [
    {
      id: 'frontend',
      domain: 'software.frontend',
      name: 'Frontend',
      status: 'ACTIVE',
      aliases: ['frontend', 'web-ui'],
    },
    {
      id: 'solana',
      domain: 'blockchain.solana',
      name: 'Solana programs',
      status: 'ACTIVE',
      aliases: ['solana'],
    },
  ],
};
const key = randomUUID();
const publish = (body: unknown, allowNewWrites = true) =>
  transaction((tx) =>
    publishSkillTaxonomy(
      tx,
      { actor, input: body, idempotencyKey: key, requestId: 'synthetic-request' },
      { allowNewWrites, canPublish: (user) => allowed.has(user.xId) },
    ),
  );
try {
  const setup = await pool.connect();
  try {
    await setup.query(`INSERT INTO "User"("id","role","xId") VALUES($1,'ADMIN',$2)`, [
      accountId,
      xId,
    ]);
    await setup.query(
      `INSERT INTO "Session"("tokenHash","userId","via","expiresAt") VALUES($1,$2,'x',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')`,
      [actor.sessionHash, accountId],
    );
  } finally {
    setup.release();
  }
  const first = await publish(input);
  assert.equal(first.status, 'EXECUTED');
  assert.equal(first.taxonomy.publishedByAccountId, accountId);
  assert.deepEqual(await publish(input, false), { status: 'REPLAYED', taxonomy: first.taxonomy });
  const read = await transaction((tx) => readPublishedSkillTaxonomy(tx, actor, catalogId));
  assert.deepEqual(read, first.taxonomy);
  assert.equal(resolveSkillAlias(read, 'WEB-UI').domain, 'software.frontend');
  const claim = prepareSkillClaim(
    {
      version: 'v1',
      now: new Date().toISOString(),
      actorAccountId: accountId,
      actorSessionAuthorized: true,
      actorRestricted: false,
      participant: { kind: 'HUMAN', id: 'synthetic-human', accountId },
      taxonomy: read,
    },
    { skillId: 'frontend', claimedLevel: 'S', supportingReferences: [] },
  );
  assert.equal(claim.assessedRank, null);
  assert.equal(claim.persisted, false);
  assert.equal(claim.verifiesSkill, false);
  allowed.clear();
  await assert.rejects(publish(input, false), { code: 'FORBIDDEN' });
  const check = await pool.connect();
  try {
    const { rows } = await check.query<{ n: number }>('SELECT count(*)::int n FROM "OutboxEvent"');
    assert.equal(rows[0].n, 0);
  } finally {
    check.release();
  }
  console.log(
    'PASS: actual authorized publication/read/original replay/current policy revocation; stable skill domains; saved taxonomy never verifies a self claim; no outbox. Synthetic data only.',
  );
} finally {
  await pool.end();
}
