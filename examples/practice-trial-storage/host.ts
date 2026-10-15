import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './connection';
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import { publishSkillTaxonomy } from './skills/taxonomy-storage';
import {
  publishPracticeTrialDefinition,
  readPracticeTrialDefinition,
} from './skills/practice-trial-storage';
async function transaction<T>(work: (tx: CommandReceiptTransaction) => Promise<T>): Promise<T> {
  return retryWholeTransaction(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
      const [statementBound] = (
        await client.query<{ statement_timeout: string }>('SHOW statement_timeout')
      ).rows;
      const [lockBound] = (await client.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows;
      assert.equal(statementBound.statement_timeout, '5s');
      assert.equal(lockBound.lock_timeout, '2s');
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

const accountId = 'synthetic-admin-' + randomUUID(),
  xId = 'synthetic-x-' + randomUUID();
const actor = { accountId, sessionHash: createHash('sha256').update(randomUUID()).digest('hex') };
const allowed = new Set([xId]);
const setPolicy = ({ xId }: { xId: string }) => allowed.has(xId);
const alternatePolicy = ({ xId }: { xId: string }) => Array.from(allowed).includes(xId);
const catalogId = 'synthetic-catalog-' + randomUUID(),
  trialId = 'synthetic-trial-' + randomUUID();
const draft = {
  version: 'v1',
  purpose: 'UNPAID_PLATFORM_PRACTICE',
  skillId: 'frontend',
  skillDomain: 'web',
  targetRank: 'A',
  title: ' ' + '😀'.repeat(100) + ' ',
  brief: 'Build and explain a synthetic accessible interface.',
  variantId: 'synthetic-one',
  inputs: [
    { label: 'Fixture', material: 'SYNTHETIC', content: 'Invented public test records only.' },
  ],
  tools: {
    permitted: ['editor', 'browser'],
    aiAssistance: 'ALLOWED',
    disclosure: 'Disclose assistance and explain or modify the solution.',
  },
  expectedMinutes: 60,
  rubric: {
    reference: { recordId: 'synthetic-rubric-' + randomUUID(), revision: 1 },
    criteria: [
      { id: 'behavior', description: 'Relevant behavior, tests and edge cases.', required: true },
      { id: 'ownership', description: 'Explain and modify the solution.', required: true },
    ],
  },
  evaluatorMethod: 'MANUAL',
  passConditions: 'Apply every required criterion under the approved manual rubric.',
  maximumAttempts: 3,
  cooldownSeconds: 60,
  accommodationPolicy: 'Request a scoped approved accommodation.',
};
const input = {
  trialId,
  expectedRevision: 0,
  taxonomyReference: { recordId: catalogId, revision: 1 },
  availability: 'AVAILABLE',
  draft,
};
const key = randomUUID();
const save = (
  body: unknown = input,
  idempotencyKey = key,
  enabled = true,
  canPublish = setPolicy,
) =>
  transaction((tx) =>
    publishPracticeTrialDefinition(
      tx,
      { actor, input: body, idempotencyKey, requestId: 'synthetic-request' },
      { allowNewWrites: enabled, canPublish },
    ),
  );
try {
  const client = await pool.connect();
  try {
    await client.query(`INSERT INTO "User"("id","role","xId") VALUES($1,'ADMIN',$2)`, [
      accountId,
      xId,
    ]);
    await client.query(
      `INSERT INTO "Session"("tokenHash","userId","via","expiresAt") VALUES($1,$2,'x',(clock_timestamp() AT TIME ZONE 'UTC')+interval '10 minutes')`,
      [actor.sessionHash, accountId],
    );
  } finally {
    client.release();
  }
  await transaction((tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor,
        input: {
          taxonomyId: catalogId,
          expectedRevision: 0,
          skills: [
            {
              id: 'frontend',
              domain: 'web',
              name: 'Frontend',
              status: 'ACTIVE',
              aliases: ['frontend'],
            },
          ],
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-catalog',
      },
      { allowNewWrites: true, canPublish: setPolicy },
    ),
  );
  const first = await save();
  assert.equal(first.status, 'EXECUTED');
  assert.equal(first.trial.definition.title, '😀'.repeat(100));
  await assert.rejects(
    () =>
      save(
        { ...input, expectedRevision: 1, draft: { ...draft, title: '😀'.repeat(101) } },
        randomUUID(),
      ),
    /INVALID_INPUT/,
  );
  assert.equal(first.trial.definition.reference.revision, 1);
  assert.equal(first.trial.verifiesSkill, false);
  assert.equal(first.trial.consumesCapacity, false);
  assert.equal(first.trial.createsFinancialObligation, false);
  const retired = await save(
    { ...input, expectedRevision: 1, availability: 'RETIRED' },
    randomUUID(),
  );
  assert.equal(retired.trial.availability, 'RETIRED');
  const replay = await save(input, key, false, alternatePolicy);
  assert.equal(replay.status, 'REPLAYED');
  assert.deepEqual(replay.trial, first.trial);
  assert.deepEqual(
    await transaction((tx) => readPracticeTrialDefinition(tx, actor, trialId, 1)),
    first.trial,
  );
  const changed = {
    ...input,
    expectedRevision: 2,
    draft: {
      ...draft,
      rubric: {
        ...draft.rubric,
        criteria: [
          {
            ...draft.rubric.criteria[0],
            description: 'Cannot change this immutable rubric version.',
          },
        ],
      },
    },
  };
  await assert.rejects(() => save(changed, randomUUID()), /RUBRIC_CONFLICT/);
  allowed.clear();
  await assert.rejects(() => save(input, key, false), /FORBIDDEN/);
  console.log(
    JSON.stringify({
      synthetic: true,
      actualPostgreSQL: true,
      storedUnicodeBound: true,
      normalizedExactBoundTitle: true,
      immutableGlobalRubric: true,
      originalReceiptAfterRetirement: true,
      alternateScopedPolicy: true,
      currentRevocationDenied: true,
      noRankGrantCapacityOrMoney: true,
    }),
  );
} finally {
  await pool.end();
}
