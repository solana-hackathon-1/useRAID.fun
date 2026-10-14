import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { db } from '../../src/lib/db';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
const baseURL = process.env.SKILL_TAXONOMY_TEST_URL || 'http://127.0.0.1:3022';
const path = '/api/v1/admin/skill-taxonomies/synthetic-admin-catalog';
const input = {
  expectedRevision: 0,
  skills: [
    {
      id: 'frontend',
      domain: 'software.frontend',
      name: 'Frontend',
      status: 'ACTIVE',
      aliases: ['frontend', 'web-ui'],
    },
  ],
};
let cookie: string, ownerId: string, sessionHash: string;
test.beforeEach(async () => {
  assertTestDatabase();
  await truncateAll(db);
  const user = await db.user.create({
    data: {
      handle: 'synthetic-publisher-' + randomUUID(),
      role: 'ADMIN',
      xId: 'synthetic-taxonomy-publisher',
    },
  });
  ownerId = user.id;
  cookie = randomBytes(32).toString('base64url');
  sessionHash = createHash('sha256').update(cookie).digest('hex');
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: ownerId,
      via: 'x',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
});
async function post(
  request: APIRequestContext,
  body: unknown = input,
  key = randomUUID(),
  headers: Record<string, string> = {},
) {
  return request.post(path, {
    data: body,
    headers: {
      origin: baseURL,
      cookie: 'raid_session=' + cookie,
      'idempotency-key': key,
      ...headers,
    },
  });
}
async function denied(r: Awaited<ReturnType<typeof post>>, status: number, code: string) {
  expect(r.status()).toBe(status);
  expect(r.headers()['cache-control']).toBe('private, no-store');
  expect(
    r
      .headers()
      ['vary'].split(',')
      .map((v) => v.trim().toLowerCase()),
  ).toContain('cookie');
  expect((await r.json()).error.code).toBe(code);
  expect(await db.skillTaxonomyVersion.count()).toBe(0);
}
test('actual X admin publishes once, reads catalog, and replays immutable original after a later update', async ({
  request,
}) => {
  const key = randomUUID();
  const first = await post(request, input, key);
  expect(first.status()).toBe(200);
  const result = await first.json();
  expect(result.taxonomy.publishedByAccountId).toBe(ownerId);
  expect(result.taxonomy.revision).toBe(1);
  const read = await request.get('/api/v1/skill-taxonomies/synthetic-admin-catalog', {
    headers: { cookie: 'raid_session=' + cookie },
  });
  expect(read.status()).toBe(200);
  expect((await read.json()).taxonomy).toEqual(result.taxonomy);
  const second = await post(request, {
    ...input,
    expectedRevision: 1,
    skills: [
      {
        ...input.skills[0],
        name: 'Accessible frontend',
        status: 'RETIRED',
        aliases: [...input.skills[0].aliases, 'accessible-ui'],
      },
    ],
  });
  expect(second.status()).toBe(200);
  const replay = await post(request, input, key);
  expect(await replay.json()).toEqual({ ...result, status: 'REPLAYED' });
  expect(await db.skillTaxonomyVersion.count()).toBe(2);
  expect(await db.auditEvent.count({ where: { eventType: 'skill.taxonomy_published.v1' } })).toBe(
    2,
  );
  expect(await db.outboxEvent.count()).toBe(0);
  expect(await db.skillClaimVersion.count()).toBe(0);
});
for (const kind of [
  'anonymous',
  'wallet-admin',
  'ordinary-user',
  'unlisted-x',
  'suspended',
  'expired',
  'revoked',
] as const) {
  test(`denies actual ${kind} before publication`, async ({ request }) => {
    if (kind === 'wallet-admin')
      await db.session.update({ where: { tokenHash: sessionHash }, data: { via: 'wallet' } });
    if (kind === 'ordinary-user')
      await db.user.update({ where: { id: ownerId }, data: { role: 'CREATOR' } });
    if (kind === 'unlisted-x')
      await db.user.update({ where: { id: ownerId }, data: { xId: 'unlisted-synthetic-x' } });
    if (kind === 'suspended')
      await db.user.update({ where: { id: ownerId }, data: { suspended: true } });
    if (kind === 'expired')
      await db.session.update({
        where: { tokenHash: sessionHash },
        data: { expiresAt: new Date(0) },
      });
    if (kind === 'revoked') await db.session.delete({ where: { tokenHash: sessionHash } });
    await denied(
      await post(request, input, randomUUID(), kind === 'anonymous' ? { cookie: '' } : {}),
      ['anonymous', 'suspended', 'expired', 'revoked'].includes(kind) ? 401 : 403,
      ['anonymous', 'suspended', 'expired', 'revoked'].includes(kind)
        ? 'AUTHENTICATION_REQUIRED'
        : 'FORBIDDEN',
    );
  });
}
test('rejects foreign origin and actual account rate excess', async ({ request }) => {
  await denied(
    await post(request, input, randomUUID(), { origin: 'https://foreign.example' }),
    403,
    'FORBIDDEN',
  );
  const bucket = Math.floor(Date.now() / 60000);
  await db.rateLimit.create({
    data: {
      key: `skill-taxonomy:${ownerId}:${bucket}`,
      count: 30,
      expiresAt: new Date((bucket + 1) * 60000),
    },
  });
  await denied(await post(request), 429, 'RATE_LIMITED');
});
test('rejects stale revision, changed key body and historical identity removal without extra versions', async ({
  request,
}) => {
  const key = randomUUID();
  expect((await post(request, input, key)).status()).toBe(200);
  const stale = await post(request);
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe('REVISION_CHANGED');
  const conflict = await post(request, { ...input, expectedRevision: 1 }, key);
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  const history = await post(request, {
    ...input,
    expectedRevision: 1,
    skills: [{ ...input.skills[0], domain: 'other.domain' }],
  });
  expect(history.status()).toBe(422);
  expect((await history.json()).error.code).toBe('INVALID_COMMAND');
  expect(await db.skillTaxonomyVersion.count()).toBe(1);
  expect(await db.outboxEvent.count()).toBe(0);
});
test('current X revocation denies original replay while wallet retains ordinary catalog read', async ({
  request,
}) => {
  const key = randomUUID();
  expect((await post(request, input, key)).status()).toBe(200);
  await db.session.update({ where: { tokenHash: sessionHash }, data: { via: 'wallet' } });
  const replay = await post(request, input, key);
  expect(replay.status()).toBe(403);
  expect((await replay.json()).error.code).toBe('FORBIDDEN');
  const read = await request.get('/api/v1/skill-taxonomies/synthetic-admin-catalog', {
    headers: { cookie: 'raid_session=' + cookie },
  });
  expect(read.status()).toBe(200);
  expect((await read.json()).taxonomy.revision).toBe(1);
  expect(await db.skillTaxonomyVersion.count()).toBe(1);
});
test.afterAll(async () => db.$disconnect());
test('simultaneous bootstrap commands have one winner and preserve one audit/version', async ({
  request,
}) => {
  const results = await Promise.all([post(request), post(request)]);
  expect(results.map((r) => r.status()).sort()).toEqual([200, 409]);
  const loser = results.find((r) => r.status() === 409)!;
  expect((await loser.json()).error.code).toBe('REVISION_CHANGED');
  expect(await db.skillTaxonomyVersion.count()).toBe(1);
  expect(await db.auditEvent.count()).toBe(1);
  expect(await db.outboxEvent.count()).toBe(0);
});
test('simultaneous exact original intent executes once and returns the same immutable result', async ({
  request,
}) => {
  const key = randomUUID();
  const results = await Promise.all([post(request, input, key), post(request, input, key)]);
  expect(results.map((r) => r.status())).toEqual([200, 200]);
  const bodies = await Promise.all(results.map((r) => r.json()));
  expect(bodies.map((b) => b.status).sort()).toEqual(['EXECUTED', 'REPLAYED']);
  expect(bodies[0].taxonomy).toEqual(bodies[1].taxonomy);
  expect(await db.skillTaxonomyVersion.count()).toBe(1);
  expect(await db.commandReceipt.count()).toBe(1);
});
test('rejects a forged publisher body and oversized body without side effects', async ({
  request,
}) => {
  await denied(
    await post(request, { ...input, publishedByAccountId: ownerId, isAdmin: true }),
    422,
    'INVALID_COMMAND',
  );
  await denied(
    await post(request, { ...input, padding: 'x'.repeat(16384) }),
    413,
    'INVALID_COMMAND',
  );
});
