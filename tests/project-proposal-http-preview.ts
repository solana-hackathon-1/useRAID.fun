import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const base = new URL(process.env.PROJECT_PROPOSAL_HTTP_PREVIEW_URL ?? 'http://missing');
assert(['127.0.0.1', 'localhost'].includes(base.hostname));
assertTestDatabase();
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
function privacy(r: Response) {
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert(r.headers.get('vary')?.includes('Cookie'));
}
try {
  await truncateAll(db);
  const credentials = [];
  for (let i = 0; i < 2; i++) {
    const user = await db.user.create({ data: { handle: 'synthetic_proposal_' + randomUUID() } }),
      cookie = randomBytes(32).toString('base64url');
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
  const draftResponse = await request('/api/v1/guild-drafts', owner.cookie, {
    guildDraftId: null,
    expectedRevision: 0,
    profile: {
      name: 'Synthetic proposal API',
      slug: 'synthetic-' + randomUUID(),
      description: 'Private current-cookie proof',
    },
  });
  assert.equal(draftResponse.status, 200);
  const { draft } = await draftResponse.json();
  const path = '/api/v1/guild-drafts/' + draft.id + '/project-proposal';
  let response = await request(path, owner.cookie);
  privacy(response);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).proposal, null);
  const body = {
      expectedDraftRevision: 1,
      expectedProposalRevision: 0,
      candidateToken: {
        chain: 'SOLANA',
        networkIdentity: 'synthetic-genesis',
        kind: 'TOKEN',
        mint: bs58.encode(new Uint8Array(32).fill(17)),
        tokenProgram: bs58.encode(new Uint8Array(32).fill(18)),
      },
      publicEvidenceRefs: ['https://PUBLIC.EXAMPLE'],
    },
    key = randomUUID();
  response = await request(path, owner.cookie, body, key);
  privacy(response);
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.status, 'EXECUTED');
  assert.equal(first.proposal.state, 'PENDING_VERIFICATION');
  assert.equal(first.proposal.recognizesGuild, false);
  assert.equal(first.proposal.founderControlVerified, false);
  assert.equal(first.proposal.activatesToken, false);
  assert.deepEqual(first.proposal.publicEvidenceRefs, ['https://public.example/']);
  response = await request(
    path,
    owner.cookie,
    { ...body, expectedProposalRevision: 1, publicEvidenceRefs: ['https://public.example/new'] },
    randomUUID(),
  );
  assert.equal(response.status, 200);
  const second = await response.json();
  assert.equal(second.proposal.revision, 2);
  response = await request(path, owner.cookie, body, key);
  privacy(response);
  assert.equal(response.status, 200);
  const replay = await response.json();
  assert.equal(replay.status, 'REPLAYED');
  assert.deepEqual(replay.proposal, first.proposal);
  response = await request(path, owner.cookie);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).proposal, second.proposal);
  response = await request(
    path,
    owner.cookie,
    { ...body, publicEvidenceRefs: ['https://public.example/conflict'] },
    key,
  );
  assert.equal(response.status, 409);
  privacy(response);
  response = await request(
    path,
    owner.cookie,
    { ...body, expectedProposalRevision: 2 },
    randomUUID(),
    'https://foreign.example',
  );
  assert.equal(response.status, 403);
  privacy(response);
  response = await request(path, owner.cookie, { ...body, role: 'ADMIN' }, randomUUID());
  assert.equal(response.status, 422);
  privacy(response);
  response = await request(path);
  assert.equal(response.status, 401);
  privacy(response);
  for (const target of [path, '/api/v1/guild-drafts/' + randomUUID() + '/project-proposal']) {
    response = await request(target, foreign.cookie);
    assert.equal(response.status, 404);
    privacy(response);
    assert(!JSON.stringify(await response.json()).includes('synthetic-genesis'));
    response = await request(target, foreign.cookie, body, randomUUID());
    assert.equal(response.status, 404);
    privacy(response);
  }
  const [counts] = await db.$queryRawUnsafe<Record<string, number>[]>(
    'SELECT (SELECT count(*)::int FROM "GuildProjectProposalVersion") AS versions,(SELECT count(*)::int FROM "GuildProjectProposal") AS proposals,(SELECT count(*)::int FROM "CommandReceipt") AS receipts,(SELECT count(*)::int FROM "AuditEvent") AS audits,(SELECT count(*)::int FROM "OutboxEvent") AS outbox',
  );
  assert.deepEqual(counts, { versions: 2, proposals: 1, receipts: 3, audits: 3, outbox: 0 });
  console.log(
    JSON.stringify({
      synthetic: true,
      developmentURL: new URL(path, base).href,
      ownCurrentCookie: true,
      saveUpdateReadOriginalReplay: true,
      privateHeaders: true,
      anonymousForeignUnknownOriginInjectedActorDenied: true,
      counts,
      noAuthorityGrantToken: true,
    }),
  );
} finally {
  await truncateAll(db);
  await db.$disconnect();
}
