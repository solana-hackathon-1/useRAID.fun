import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy } from '../src/skills/taxonomy-storage';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const base = new URL(process.env.SKILL_HTTP_PREVIEW_URL ?? 'http://missing');
assert(['127.0.0.1', 'localhost'].includes(base.hostname));
assertTestDatabase();
async function request(
  path: string,
  cookie?: string,
  body?: unknown,
  key = randomUUID(),
  origin = base.origin,
) {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = 'raid_session=' + cookie;
  if (body !== undefined) {
    headers.Origin = origin;
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
  }
  return fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
}
function privacy(r: Response) {
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert(r.headers.get('vary')?.includes('Cookie'));
}
try {
  await truncateAll(db);
  const accounts = [];
  for (let i = 0; i < 3; i++) {
    const u = await db.user.create({
      data: {
        handle: 'synthetic-skill-' + randomUUID(),
        role: i === 0 ? 'ADMIN' : 'CREATOR',
        xId: i === 0 ? 'synthetic-admin-' + randomUUID() : null,
      },
    });
    const cookie = randomBytes(32).toString('base64url'),
      sessionHash = createHash('sha256').update(cookie).digest('hex');
    await db.session.create({
      data: {
        userId: u.id,
        tokenHash: sessionHash,
        via: i === 0 ? 'x' : 'wallet',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const p = await db.participant.create({
      data: {
        accountId: u.id,
        provisionActorAccountId: u.id,
        provisionRequestId: 'synthetic-provision',
      },
    });
    accounts.push({ id: u.id, cookie, sessionHash, participantId: p.id });
  }
  const [admin, owner, foreign] = accounts,
    taxonomyId = 'synthetic-api-catalog',
    skillId = 'frontend';
  await runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor: { accountId: admin.id, sessionHash: admin.sessionHash },
        input: {
          taxonomyId,
          expectedRevision: 0,
          skills: [
            {
              id: skillId,
              domain: 'software.frontend',
              name: 'Frontend',
              status: 'ACTIVE',
              aliases: ['frontend'],
            },
          ],
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-catalog',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
  const path = '/api/v1/skill-claims/' + skillId,
    body = {
      taxonomyId,
      expectedTaxonomyRevision: 1,
      expectedClaimRevision: 0,
      claimedLevel: ' S ',
      supportingReferences: [' https://PUBLIC.EXAMPLE '],
    },
    key = randomUUID();
  let r = await request(path);
  privacy(r);
  assert.equal(r.status, 401);
  r = await request('/api/v1/skill-taxonomies/' + taxonomyId, owner.cookie);
  privacy(r);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).taxonomy.id, taxonomyId);
  r = await request(path, owner.cookie);
  privacy(r);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).claim, null);
  r = await request(path, owner.cookie, body, key);
  privacy(r);
  assert.equal(r.status, 200);
  const first = await r.json();
  assert.equal(first.status, 'EXECUTED');
  assert.equal(first.claim.participantId, owner.participantId);
  assert.equal(first.claim.claimedLevel, 'S');
  assert.equal(first.claim.verifiesSkill, false);
  assert(!('assessedRank' in first.claim));
  assert.deepEqual(first.claim.supportingReferences, ['https://public.example/']);
  r = await request(path, owner.cookie, body, key);
  privacy(r);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'REPLAYED');
  r = await request(path, foreign.cookie);
  privacy(r);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).claim, null);
  r = await request(path, owner.cookie, { ...body, claimedLevel: 'C' }, key);
  privacy(r);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
  r = await request(path, owner.cookie, body, randomUUID(), 'https://foreign.example');
  privacy(r);
  assert.equal(r.status, 403);
  r = await request(path, owner.cookie, { ...body, participantId: foreign.participantId });
  privacy(r);
  assert.equal(r.status, 422);
  const bucket = Math.floor(Date.now() / 60000);
  await db.rateLimit.upsert({
    where: { key: 'skill-claim:' + owner.id + ':' + bucket },
    create: {
      key: 'skill-claim:' + owner.id + ':' + bucket,
      count: 30,
      expiresAt: new Date(Date.now() + 120000),
    },
    update: { count: 30 },
  });
  r = await request(path, owner.cookie, body, randomUUID());
  privacy(r);
  assert.equal(r.status, 429);
  await db.session.delete({ where: { tokenHash: owner.sessionHash } });
  r = await request(path, owner.cookie);
  privacy(r);
  assert.equal(r.status, 401);
  assert.equal(await db.outboxEvent.count(), 0);
  console.log(
    'PASS: actual Next private catalog/claim current-cookie GET/POST/normalized save/replay/foreign privacy/origin/digest/body/rate/revoked-session checks, no assessed rank/outbox. Synthetic development API only.',
  );
} finally {
  await db.$disconnect();
}
