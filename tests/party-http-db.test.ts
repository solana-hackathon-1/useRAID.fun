import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { canonicalRequestDigest } from '../src/command-receipts';
import {
  createParty,
  proposePartyRoster,
  readPartyProposal,
  recordPartyMemberConsent,
} from '../src/parties';
import { createPartyHandlers } from '../src/parties/party-http';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
type Actor = { accountId: string; sessionHash: string };
const POOL = 1000000000n;

/** A real-storage consumer of the transport: the host supplies the session actor and the write switch. */
const session = new AsyncLocalStorage<Actor>();
let writes = true;
const handlers = createPartyHandlers({
  version: 'v1',
  requestId: () => randomUUID(),
  actor: async () => session.getStore()!,
  checkOrigin: () => undefined,
  rateLimit: async () => undefined,
  create: (command) => run((tx) => createParty(tx, command, { allowNewWrites: writes })),
  propose: (command) => run((tx) => proposePartyRoster(tx, command, { allowNewWrites: writes })),
  consent: (command) =>
    run((tx) => recordPartyMemberConsent(tx, command, { allowNewWrites: writes })),
  read: (actor, proposalId) => run((tx) => readPartyProposal(tx, actor, { proposalId })),
});
const as = <T>(actor: Actor, work: () => Promise<T>) => session.run(actor, work);
const post = (url: string, body: unknown, key: string = randomUUID()) =>
  new Request('http://x' + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
const create = (actor: Actor, name = 'Synthetic Party', key?: string) =>
  as(actor, () => handlers.CREATE(post('/api/v1/parties', { name }, key)));
const propose = (actor: Actor, partyId: string, body: unknown, key?: string) =>
  as(actor, () =>
    handlers.PROPOSE(post(`/api/v1/parties/${partyId}/proposals`, body, key), partyId),
  );
const consent = (actor: Actor, proposalId: string, body: unknown, key?: string) =>
  as(actor, () =>
    handlers.CONSENT(post(`/api/v1/party-proposals/${proposalId}/consents`, body, key), proposalId),
  );
const read = (actor: Actor, proposalId: string) =>
  as(actor, () =>
    handlers.READ(new Request(`http://x/api/v1/party-proposals/${proposalId}`), proposalId),
  );
const errorCode = async (response: Response) => (await response.json()).error.code;

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
// The replication role skips only triggers (immutability, slot/listing state machines) for this transaction.
const replica = <T>(work: (tx: Tx) => Promise<T>) =>
  db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    return work(tx);
  });
// Publication still refuses PARTY terms until Party acceptance exists, so fixtures re-label stored terms.
const rewriteTerms = (termsVersionId: string, terms: unknown) =>
  replica((tx) =>
    tx.$executeRawUnsafe(
      `UPDATE "TermsVersion" SET "snapshot"=$1::jsonb,"digest"=$2 WHERE "id"=$3::uuid`,
      JSON.stringify(terms),
      canonicalRequestDigest(terms),
      termsVersionId,
    ),
  );

async function setup() {
  const leader = await seedWorkHuman(db),
    ana = await seedWorkHuman(db),
    ben = await seedWorkHuman(db),
    outsider = await seedWorkHuman(db);
  const slot = await seedWorkSlot(db, 'founder-' + randomUUID());
  const terms = { ...raidTerms(), execution: 'PARTY' };
  await rewriteTerms(slot.termsVersionId, terms);
  const made = await create(leader.actor);
  const party = (await made.json()).party as { id: string; leaderParticipantId: string };
  const members = [
    { participantId: leader.participantId, role: 'Lead', allocations: [{ amount: '500000000' }] },
    { participantId: ana.participantId, role: 'Frontend', allocations: [{ amount: '300000000' }] },
    { participantId: ben.participantId, role: 'Solana', allocations: [{ amount: '200000000' }] },
  ];
  const body = {
    slotId: slot.slotId,
    termsVersionId: slot.termsVersionId,
    termsDigest: canonicalRequestDigest(terms),
    members,
  };
  return { leader, ana, ben, outsider, slot, party, members, body };
}
async function proposed() {
  const t = await setup();
  const response = await propose(t.leader.actor, t.party.id, t.body);
  expect(response.status).toBe(200);
  const proposal = (await response.json()).proposal as {
    id: string;
    snapshotDigest: string;
    allConsented: boolean;
  };
  return { ...t, proposal };
}
const consentRows = () =>
  db.$queryRawUnsafe<{ participantId: string }[]>(
    'SELECT "participantId"::text FROM "PartyMemberConsent"',
  );

integration('T056 Party roster over HTTP (real storage)', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    writes = true;
  });
  afterAll(() => db.$disconnect());

  it('creates, proposes, collects every member’s own consent and shows the result', async () => {
    const t = await proposed();
    expect(t.proposal.allConsented).toBe(false);
    for (const who of [t.leader, t.ana, t.ben]) {
      const response = await consent(who.actor, t.proposal.id, {
        snapshotDigest: t.proposal.snapshotDigest,
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe('EXECUTED');
      expect(body.consent.participantId).toBe(who.participantId);
    }
    const seen = await read(t.ana.actor, t.proposal.id);
    expect(seen.status).toBe(200);
    expect(seen.headers.get('cache-control')).toBe('private, no-store');
    const proposal = await seen.json();
    expect(proposal.allConsented).toBe(true);
    expect(proposal.members.every((m: { consentedAt: string | null }) => m.consentedAt)).toBe(true);
    const total = proposal.members.reduce(
      (sum: bigint, m: { allocations: { amount: string }[] }) =>
        sum + BigInt(m.allocations[0].amount),
      0n,
    );
    expect(total).toBe(POOL);
    expect(JSON.stringify(proposal)).not.toMatch(/receipt|sessionHash|accountId/i);
  });

  it('keeps authority server-side: strangers, non-leaders, other members and non-humans are refused', async () => {
    const t = await proposed();
    const digest = { snapshotDigest: t.proposal.snapshotDigest };
    // A stranger learns nothing about a proposal: not by reading it, not by consenting to it.
    expect((await read(t.outsider.actor, t.proposal.id)).status).toBe(404);
    expect(await errorCode(await consent(t.outsider.actor, t.proposal.id, digest))).toBe(
      'NOT_FOUND',
    );
    expect((await read(t.leader.actor, randomUUID())).status).toBe(404);
    expect(await consentRows()).toHaveLength(0);
    // Only the Party's own leader proposes for it; a named member or an unknown Party id gets no write.
    expect(await errorCode(await propose(t.ana.actor, t.party.id, t.body))).toBe('FORBIDDEN');
    expect(await errorCode(await propose(t.leader.actor, randomUUID(), t.body))).toBe('NOT_FOUND');
    // The consent body names no participant, so a leader cannot consent for ana; her own session is the only way.
    expect(
      (
        await consent(t.leader.actor, t.proposal.id, {
          ...digest,
          participantId: t.ana.participantId,
        })
      ).status,
    ).toBe(422);
    expect((await consent(t.leader.actor, t.proposal.id, digest)).status).toBe(200);
    expect(await consentRows()).toEqual([{ participantId: t.leader.participantId }]);
    // A digest the member did not see is a conflict, not a consent.
    expect(
      await errorCode(
        await consent(t.ana.actor, t.proposal.id, { snapshotDigest: 'e'.repeat(64) }),
      ),
    ).toBe('REVISION_CHANGED');
    // A signed-out or expired session, and a non-human participant, cannot act.
    expect(
      (await consent({ ...t.ana.actor, sessionHash: 'f'.repeat(64) }, t.proposal.id, digest))
        .status,
    ).toBe(401);
    // Participant.kind is checked to HUMAN today, so a signed-in account with no human participant stands in for a
    // non-human principal (an AI worker has no participant of its own that may create or consent).
    const bot = await db.user.create({
      data: { id: 'bot-' + randomUUID(), handle: 'bot-' + randomUUID() },
    });
    const botActor = { accountId: bot.id, sessionHash: 'b'.repeat(64) };
    await db.session.create({
      data: {
        tokenHash: botActor.sessionHash,
        userId: bot.id,
        via: 'wallet',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    expect((await create(botActor)).status).toBe(403);
    expect((await consent(botActor, t.proposal.id, digest)).status).toBe(403);
    expect(await consentRows()).toHaveLength(1);
  });

  it('records exactly one consent per member when members and duplicates race', async () => {
    const t = await proposed();
    const body = { snapshotDigest: t.proposal.snapshotDigest };
    const sameKey = randomUUID();
    const responses = await Promise.all([
      consent(t.leader.actor, t.proposal.id, body),
      consent(t.ana.actor, t.proposal.id, body, sameKey),
      consent(t.ana.actor, t.proposal.id, body, sameKey),
      consent(t.ana.actor, t.proposal.id, body),
      consent(t.ben.actor, t.proposal.id, body),
      consent(t.ben.actor, t.proposal.id, body),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const ids = (await Promise.all(responses.map((r) => r.json()))).map((b) => [
      b.consent.participantId,
      b.consent.id,
    ]);
    // Every duplicate for a member resolves to that member’s one stored consent.
    for (const who of [t.ana, t.ben])
      expect(new Set(ids.filter(([p]) => p === who.participantId).map(([, id]) => id)).size).toBe(
        1,
      );
    expect(await consentRows()).toHaveLength(3);
    expect((await (await read(t.leader.actor, t.proposal.id)).json()).allConsented).toBe(true);
  });

  it('answers replays from the original receipt after the Party, slot and switch moved on', async () => {
    const t = await setup();
    const keys = { propose: randomUUID(), consent: randomUUID(), create: randomUUID() };
    const first = await propose(t.leader.actor, t.party.id, t.body, keys.propose);
    const proposal = (await first.json()).proposal;
    const body = { snapshotDigest: proposal.snapshotDigest };
    expect((await consent(t.ana.actor, proposal.id, body, keys.consent)).status).toBe(200);
    expect((await create(t.leader.actor, 'Replayed', keys.create)).status).toBe(200);
    for (const who of [t.leader, t.ben]) await consent(who.actor, proposal.id, body);
    // The slot fills and new writes are switched off.
    await replica((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "RaidSlot" SET "state"='FILLED' WHERE "id"=$1::uuid`,
        t.slot.slotId,
      ),
    );
    writes = false;
    const again = await propose(t.leader.actor, t.party.id, t.body, keys.propose);
    expect(again.status).toBe(200);
    const replayed = await again.json();
    expect(replayed.status).toBe('REPLAYED');
    expect(replayed.proposal.allConsented).toBe(true);
    const replayConsent = await consent(t.ana.actor, proposal.id, body, keys.consent);
    expect(replayConsent.status).toBe(200);
    expect((await replayConsent.json()).status).toBe('REPLAYED');
    expect((await (await create(t.leader.actor, 'Replayed', keys.create)).json()).status).toBe(
      'REPLAYED',
    );
    // The same key with a different request is refused, not silently replayed.
    expect(await errorCode(await create(t.leader.actor, 'Different', keys.create))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('refuses new writes with the switch off but keeps reads and refuses once the slot filled', async () => {
    const t = await proposed();
    writes = false;
    const denied = await create(t.leader.actor, 'Blocked');
    expect(denied.status).toBe(503);
    expect(await errorCode(denied)).toBe('NOT_AVAILABLE');
    expect(
      await errorCode(
        await consent(t.ana.actor, t.proposal.id, { snapshotDigest: t.proposal.snapshotDigest }),
      ),
    ).toBe('NOT_AVAILABLE');
    expect((await read(t.ana.actor, t.proposal.id)).status).toBe(200);
    expect(await consentRows()).toHaveLength(0);
    writes = true;
    await replica((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "RaidSlot" SET "state"='FILLED' WHERE "id"=$1::uuid`,
        t.slot.slotId,
      ),
    );
    expect(
      await errorCode(
        await consent(t.ana.actor, t.proposal.id, { snapshotDigest: t.proposal.snapshotDigest }),
      ),
    ).toBe('SLOT_FILLED');
  });

  it('refuses dust and shortfall splits as invalid input and stores nothing', async () => {
    const t = await setup();
    const short = t.members.map((m, i) =>
      i === 2 ? { ...m, allocations: [{ amount: '199999999' }] } : m,
    );
    const response = await propose(t.leader.actor, t.party.id, { ...t.body, members: short });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('INVALID_COMMAND');
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "PartyProposal"')).toHaveLength(0);
  });
});
