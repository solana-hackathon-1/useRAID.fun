import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const base = new URL(process.env.GUILD_DRAFT_HTTP_PREVIEW_URL ?? 'http://missing');
assert(['127.0.0.1', 'localhost'].includes(base.hostname));
assertTestDatabase();
const credentials: { id: string; cookie: string }[] = [];
async function request(
  path: string,
  cookie?: string,
  body?: unknown,
  key?: string,
  origin = base.origin,
) {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = 'raid_session=' + cookie;
  if (body !== undefined) {
    headers.Origin = origin;
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key ?? randomUUID();
  }
  return fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
}
function privateResponse(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert(response.headers.get('vary')?.includes('Cookie'));
}
try {
  await truncateAll(db);
  for (let i = 0; i < 2; i++) {
    const user = await db.user.create({ data: { handle: 'synthetic_http_' + randomUUID() } });
    const cookie = randomBytes(32).toString('base64url');
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(cookie).digest('hex'),
        via: 'wallet',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    credentials.push({ id: user.id, cookie });
  }
  const [owner, foreign] = credentials;
  const profile = {
    name: 'Synthetic private Guild',
    slug: 'synthetic-http-' + randomUUID(),
    description: 'Synthetic HTTP preview only',
  };
  const body = { guildDraftId: null, expectedRevision: 0, profile },
    key = randomUUID();
  const created = await request('/api/v1/guild-drafts', owner.cookie, body, key);
  assert.equal(created.status, 200);
  privateResponse(created);
  const first = await created.json();
  assert.equal(first.draft.state, 'DRAFT_UNVERIFIED');
  assert.equal(first.draft.founderControlVerified, false);
  assert.equal(first.draft.publicProfileApproved, false);
  assert.equal(first.draft.primaryToken, null);
  const path = '/api/v1/guild-drafts/' + first.draft.id;
  const read = await request(path, owner.cookie);
  assert.equal(read.status, 200);
  privateResponse(read);
  const state = await read.json();
  assert.deepEqual(state.draft, first.draft);
  assert.equal(state.writesAvailable, true);
  const anon = await request(path);
  assert.equal(anon.status, 401);
  privateResponse(anon);
  assert(!JSON.stringify(await anon.json()).includes(profile.description));
  for (const target of [path, '/api/v1/guild-drafts/' + randomUUID()]) {
    const denied = await request(target, foreign.cookie);
    assert.equal(denied.status, 404);
    privateResponse(denied);
    assert.equal((await denied.json()).error.code, 'NOT_FOUND');
  }
  const updated = await request(
    '/api/v1/guild-drafts',
    owner.cookie,
    {
      guildDraftId: first.draft.id,
      expectedRevision: 1,
      profile: { ...profile, name: 'Updated synthetic draft' },
    },
    randomUUID(),
  );
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).draft.revision, 2);
  const replay = await request('/api/v1/guild-drafts', owner.cookie, body, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ...first, status: 'REPLAYED' });
  const changed = await request(
    '/api/v1/guild-drafts',
    owner.cookie,
    { ...body, profile: { ...profile, description: 'Changed' } },
    key,
  );
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(
    (
      await request(
        '/api/v1/guild-drafts',
        owner.cookie,
        body,
        randomUUID(),
        'https://foreign.invalid',
      )
    ).status,
    403,
  );
  assert.equal(
    (await request('/api/v1/guild-drafts', owner.cookie, { ...body, actorAccountId: foreign.id }))
      .status,
    422,
  );
  const [counts] = await db.$queryRawUnsafe<
    { versions: number; drafts: number; audits: number; receipts: number; outbox: number }[]
  >(
    `SELECT (SELECT count(*)::int FROM "GuildDraftVersion") AS versions,(SELECT count(*)::int FROM "GuildDraft") AS drafts,(SELECT count(*)::int FROM "AuditEvent") AS audits,(SELECT count(*)::int FROM "CommandReceipt") AS receipts,(SELECT count(*)::int FROM "OutboxEvent") AS outbox`,
  );
  assert.deepEqual(counts, { versions: 2, drafts: 1, audits: 2, receipts: 2, outbox: 0 });
  console.log(
    JSON.stringify({
      synthetic: true,
      developmentPreview: base.origin,
      privateSaveRead: true,
      originalReplayAfterUpdate: true,
      anonymousAndForeignDenied: true,
      csrfAndInjectedActorDenied: true,
      noStore: true,
      noFounderPublicTokenOrOutbox: true,
    }),
  );
} finally {
  await truncateAll(db);
  await db.$disconnect();
}
