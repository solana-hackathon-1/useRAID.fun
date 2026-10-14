import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from './connection';
import {
  CommandReceiptError,
  retryWholeTransaction,
  type CommandReceiptTransaction,
} from './command-receipts';
import {
  createSkillTaxonomyHandlers,
  createSkillTaxonomyReadHandler,
  SkillTaxonomyHttpError,
} from './skills/taxonomy-http';
import { publishSkillTaxonomy, readSkillTaxonomyForPublisher } from './skills/taxonomy-storage';
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
            return (await client.query<Row>(sql, bindings)).rows;
          } catch (error) {
            const state = (error as { code?: string }).code;
            throw new CommandReceiptError(
              state === '40001' || state === '40P01' ? 'RETRY_TRANSACTION' : 'STORAGE_UNAVAILABLE',
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
const actor = {
  accountId: 'synthetic-http-admin-' + randomUUID(),
  sessionHash: createHash('sha256').update(randomUUID()).digest('hex'),
};
const xId = 'synthetic-http-x-' + randomUUID();
const allowed = new Set([xId]);
let allowNewWrites = true;
const catalogId = 'synthetic-http-catalog-' + randomUUID();
const input = {
  expectedRevision: 0,
  skills: [
    {
      id: 'frontend',
      domain: 'software.frontend',
      name: 'Frontend',
      status: 'ACTIVE',
      aliases: ['frontend'],
    },
  ],
};
const key = randomUUID();
const api = createSkillTaxonomyHandlers({
  version: 'v1',
  actor: async () => actor,
  checkOrigin(request) {
    if (request.headers.get('origin') !== 'https://synthetic.example')
      throw new SkillTaxonomyHttpError(403);
  },
  // A CLI fixture has no untrusted caller; a real server must supply current account rate limiting.
  rateLimit: async () => {},
  requestId: randomUUID,
  publish: async (command) => ({
    version: 'v1',
    ...(await transaction((tx) =>
      publishSkillTaxonomy(tx, command, {
        allowNewWrites,
        canPublish: ({ xId }) => allowed.has(xId),
      }),
    )),
    writesAvailable: allowNewWrites,
    unavailableReason: allowNewWrites ? null : 'DISABLED',
  }),
});
const request = (body: unknown = input, originalKey = key) =>
  new Request('https://synthetic.example/api/v1/admin/skill-taxonomies/' + catalogId, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://synthetic.example',
      'idempotency-key': originalKey,
    },
    body: JSON.stringify(body),
  });
const reader = createSkillTaxonomyReadHandler({
  version: 'v1',
  actor: async () => actor,
  requestId: randomUUID,
  read: async (current, id) => ({
    version: 'v1',
    taxonomyId: id,
    publisherAccountId: current.accountId,
    taxonomy: await transaction((tx) =>
      readSkillTaxonomyForPublisher(tx, current, id, { canPublish: ({ xId }) => allowed.has(xId) }),
    ),
    writesAvailable: allowNewWrites,
    unavailableReason: allowNewWrites ? null : 'DISABLED',
  }),
});
try {
  const client = await pool.connect();
  try {
    await client.query(`INSERT INTO "User"("id","role","xId") VALUES($1,'ADMIN',$2)`, [
      actor.accountId,
      xId,
    ]);
    await client.query(
      `INSERT INTO "Session"("tokenHash","userId","via","expiresAt") VALUES($1,$2,'x',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')`,
      [actor.sessionHash, actor.accountId],
    );
  } finally {
    client.release();
  }
  const first = await api.POST(request(), catalogId);
  assert.equal(first.status, 200);
  const original = await first.json();
  assert.equal(original.taxonomy.publishedByAccountId, actor.accountId);
  const current = await reader.GET(new Request('https://synthetic.example'), catalogId);
  assert.equal(current.status, 200);
  assert.deepEqual((await current.json()).taxonomy, original.taxonomy);
  allowNewWrites = false;
  const replay = await api.POST(request(), catalogId);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    ...original,
    status: 'REPLAYED',
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  const disabled = await api.POST(
    request({ ...input, expectedRevision: 1 }, randomUUID()),
    catalogId,
  );
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).error.code, 'SERVICE_UNAVAILABLE');
  allowed.clear();
  const deniedRead = await reader.GET(new Request('https://synthetic.example'), catalogId);
  assert.equal(deniedRead.status, 403);
  assert.equal(deniedRead.headers.get('cache-control'), 'private, no-store');
  const denied = await api.POST(request(), catalogId);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'FORBIDDEN');
  assert.equal(denied.headers.get('cache-control'), 'private, no-store');
  const check = await pool.connect();
  try {
    const { rows } = await check.query<{ n: number }>(
      'SELECT count(*)::int n FROM "SkillTaxonomyVersion" WHERE "taxonomyId"=$1',
      [catalogId],
    );
    assert.equal(rows[0].n, 1);
    assert.equal(
      (await check.query<{ n: number }>('SELECT count(*)::int n FROM "OutboxEvent"')).rows[0].n,
      0,
    );
  } finally {
    check.release();
  }
  console.log(
    'PASS: independently installed HTTP/real PG publish, disabled original replay, denied new intent, revoked policy, private errors, one version and no outbox. Synthetic only.',
  );
} finally {
  await pool.end();
}
