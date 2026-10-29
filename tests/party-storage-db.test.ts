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
  type PartyHost,
} from '../src/parties';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
type Actor = { accountId: string; sessionHash: string };
const cmd = (actor: Actor, input: unknown, key: string = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: key,
});
const on: PartyHost = { allowNewWrites: true };
const off: PartyHost = { allowNewWrites: false };
const POOL = 1000000000n;

async function setup(execution: 'PARTY' | 'SOLO' = 'PARTY') {
  const leader = await seedWorkHuman(db),
    ana = await seedWorkHuman(db),
    ben = await seedWorkHuman(db),
    outsider = await seedWorkHuman(db);
  const slot = await seedWorkSlot(db);
  const terms = { ...raidTerms(), execution };
  // Publication still refuses PARTY terms (UNSUPPORTED_MODE) until Party acceptance exists, so this fixture re-labels the
  // stored terms of a published SOLO slot. Replication role bypasses only the immutability trigger, in this transaction.
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(
      `UPDATE "TermsVersion" SET "snapshot"=$1::jsonb,"digest"=$2 WHERE "id"=$3::uuid`,
      JSON.stringify(terms),
      canonicalRequestDigest(terms),
      slot.termsVersionId,
    );
  });
  const { party } = await run((tx) =>
    createParty(tx, cmd(leader.actor, { name: 'Synthetic Party' }), on),
  );
  const termsDigest = canonicalRequestDigest(terms);
  const split = (a: bigint, b: bigint, c: bigint) => [
    { participantId: leader.participantId, role: 'Lead', allocations: [{ amount: String(a) }] },
    { participantId: ana.participantId, role: 'Frontend', allocations: [{ amount: String(b) }] },
    { participantId: ben.participantId, role: 'Solana', allocations: [{ amount: String(c) }] },
  ];
  const proposal = (members: unknown, overrides: Record<string, unknown> = {}) => ({
    partyId: party.id,
    slotId: slot.slotId,
    termsVersionId: slot.termsVersionId,
    termsDigest,
    members,
    ...overrides,
  });
  const propose = (actor: Actor, input: unknown, host = on, key?: string) =>
    run((tx) => proposePartyRoster(tx, cmd(actor, input, key), host));
  const consent = (actor: Actor, input: unknown, host = on, key?: string) =>
    run((tx) => recordPartyMemberConsent(tx, cmd(actor, input, key), host));
  const read = (actor: Actor, proposalId: string) =>
    run((tx) => readPartyProposal(tx, actor, { proposalId }));
  return {
    leader,
    ana,
    ben,
    outsider,
    slot,
    party,
    split,
    proposal,
    propose,
    consent,
    read,
    termsDigest,
  };
}
const rejects = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

integration('T056 Party rosters, exact splits and per-member consent', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());

  it('creates a Party led by the commanding human and replays the original receipt', async () => {
    const leader = await seedWorkHuman(db);
    const key = randomUUID();
    const first = await run((tx) =>
      createParty(tx, cmd(leader.actor, { name: 'Synthetic Party' }, key), on),
    );
    expect(first.status).toBe('EXECUTED');
    expect(first.party.leaderParticipantId).toBe(leader.participantId);
    const again = await run((tx) =>
      createParty(tx, cmd(leader.actor, { name: 'Synthetic Party' }, key), off),
    );
    expect(again.status).toBe('REPLAYED');
    expect(again.party.id).toBe(first.party.id);
    await rejects(
      run((tx) => createParty(tx, cmd(leader.actor, { name: 'Another' }), off)),
      'WRITES_DISABLED',
    );
    await rejects(
      run((tx) => createParty(tx, cmd(leader.actor, { name: ' padded ' }), on)),
      'INVALID_INPUT',
    );
  });

  it('stores an immutable snapshot whose split sums exactly to the reward, in sorted member order', async () => {
    const t = await setup();
    const result = await t.propose(
      t.leader.actor,
      t.proposal(t.split(500000000n, 300000000n, 200000000n)),
    );
    expect(result.status).toBe('EXECUTED');
    expect(result.proposal.allConsented).toBe(false);
    expect(result.proposal.members.map((m) => m.participantId)).toEqual(
      [t.leader.participantId, t.ana.participantId, t.ben.participantId].sort(),
    );
    expect(result.proposal.members.every((m) => m.consentedAt === null)).toBe(true);
    const total = result.proposal.members.reduce(
      (sum, m) => sum + BigInt(m.allocations[0].amount),
      0n,
    );
    expect(total).toBe(POOL);
    await expect(
      db.$executeRawUnsafe(`UPDATE "PartyProposal" SET "snapshotDigest"=$1`, 'a'.repeat(64)),
    ).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "PartyProposalMember"')).rejects.toThrow();
  });

  it('refuses dust, shortfall, wrong leg counts, duplicates and unknown or non-human members', async () => {
    const t = await setup();
    await rejects(
      t.propose(t.leader.actor, t.proposal(t.split(500000000n, 300000000n, 199999999n))),
      'INVALID_INPUT',
    );
    await rejects(
      t.propose(t.leader.actor, t.proposal(t.split(500000000n, 300000000n, 200000001n))),
      'INVALID_INPUT',
    );
    const twoLegs = t.split(500000000n, 300000000n, 200000000n).map((m) => ({
      ...m,
      allocations: [...m.allocations, { amount: '0' }],
    }));
    await rejects(t.propose(t.leader.actor, t.proposal(twoLegs)), 'INVALID_INPUT');
    const duplicate = [
      ...t.split(500000000n, 300000000n, 0n).slice(0, 2),
      t.split(0n, 0n, 200000000n)[1],
    ];
    await rejects(t.propose(t.leader.actor, t.proposal(duplicate)), 'INVALID_INPUT');
    const unknown = [
      { participantId: randomUUID(), role: 'Ghost', allocations: [{ amount: String(POOL) }] },
    ];
    await rejects(t.propose(t.leader.actor, t.proposal(unknown)), 'INVALID_INPUT');
    await rejects(t.propose(t.leader.actor, t.proposal([], {})), 'INVALID_INPUT');
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "PartyProposal"')).toHaveLength(0);
  });

  it('lets only the Party leader propose, and only for current PARTY terms at the exact digest', async () => {
    const t = await setup();
    const members = t.split(500000000n, 300000000n, 200000000n);
    await rejects(t.propose(t.ana.actor, t.proposal(members)), 'FORBIDDEN');
    await rejects(
      t.propose(t.leader.actor, t.proposal(members, { partyId: randomUUID() })),
      'NOT_FOUND',
    );
    await rejects(
      t.propose(t.leader.actor, t.proposal(members, { termsDigest: 'b'.repeat(64) })),
      'TERMS_VERSION_CHANGED',
    );
    await rejects(t.propose(t.leader.actor, t.proposal(members), off), 'WRITES_DISABLED');
    const solo = await setup('SOLO');
    await rejects(
      solo.propose(
        solo.leader.actor,
        solo.proposal(solo.split(500000000n, 300000000n, 200000000n)),
      ),
      'PUBLICATION_BLOCKED',
    );
  });

  it('records consent only from the member’s own session; the leader cannot consent for anyone else', async () => {
    const t = await setup();
    const { proposal } = await t.propose(
      t.leader.actor,
      t.proposal(t.split(500000000n, 300000000n, 200000000n)),
    );
    const input = { proposalId: proposal.id, snapshotDigest: proposal.snapshotDigest };
    await rejects(t.consent(t.outsider.actor, input), 'NOT_FOUND');
    await rejects(
      t.consent(t.ana.actor, { ...input, snapshotDigest: 'c'.repeat(64) }),
      'REVISION_CONFLICT',
    );
    // The leader's consent records the leader's own participant only: there is no input to name anyone else.
    const lead = await t.consent(t.leader.actor, input);
    expect(lead.consent.participantId).toBe(t.leader.participantId);
    const forged = await t.read(t.leader.actor, proposal.id);
    expect(
      forged.members.filter((m) => m.consentedAt !== null).map((m) => m.participantId),
    ).toEqual([t.leader.participantId]);
    expect(forged.allConsented).toBe(false);
    const key = randomUUID();
    const anaConsent = await t.consent(t.ana.actor, input, on, key);
    expect(anaConsent.status).toBe('EXECUTED');
    const replay = await t.consent(t.ana.actor, input, off, key);
    expect(replay.status).toBe('REPLAYED');
    expect(replay.consent.id).toBe(anaConsent.consent.id);
    // A fresh key by the same member keeps the one consent.
    expect((await t.consent(t.ana.actor, input)).consent.id).toBe(anaConsent.consent.id);
    await rejects(t.consent(t.ben.actor, input, off), 'WRITES_DISABLED');
    expect((await t.read(t.ana.actor, proposal.id)).allConsented).toBe(false);
    await t.consent(t.ben.actor, input);
    expect((await t.read(t.ben.actor, proposal.id)).allConsented).toBe(true);
  });

  it('rejects, in the database, a consent row whose commanding account does not own the participant', async () => {
    const t = await setup();
    const { proposal } = await t.propose(
      t.leader.actor,
      t.proposal(t.split(500000000n, 300000000n, 200000000n)),
    );
    // A receipt of the leader's own consent command, reused to try to consent as Ana.
    const lead = await t.consent(t.leader.actor, {
      proposalId: proposal.id,
      snapshotDigest: proposal.snapshotDigest,
    });
    const [receipt] = (await db.$queryRawUnsafe(
      `SELECT r."id"::text FROM "CommandReceipt" r WHERE r."commandKind"='RecordPartyMemberConsent' AND r."resultRef"=$1`,
      lead.consent.id,
    )) as { id: string }[];
    const forge = (receiptId: string, participantId: string, digest = proposal.snapshotDigest) =>
      db.$executeRawUnsafe(
        `INSERT INTO "PartyMemberConsent" ("proposalId","participantId","snapshotDigest","receiptId") VALUES ($1::uuid,$2::uuid,$3,$4::uuid)`,
        proposal.id,
        participantId,
        digest,
        receiptId,
      );
    await expect(forge(receipt.id, t.ana.participantId)).rejects.toThrow(/consenting member/);
    // Not a roster member: the composite foreign key refuses it before any guard matters.
    await expect(forge(receipt.id, t.outsider.participantId)).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "PartyMemberConsent"')).rejects.toThrow();
  });

  it('refuses rows that are not the snapshot or do not sum exactly, even written directly', async () => {
    const t = await setup();
    const { proposal } = await t.propose(
      t.leader.actor,
      t.proposal(t.split(500000000n, 300000000n, 200000000n)),
    );
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "PartyProposalMember" ("proposalId","participantId","role","allocations") VALUES ($1::uuid,$2::uuid,'Extra','[{"amount":"0"}]'::jsonb)`,
        proposal.id,
        t.outsider.participantId,
      ),
    ).rejects.toThrow(/immutable snapshot/);
    // A whole forged proposal whose members sum short fails at commit (deferred constraint).
    await expect(
      db.$transaction(async (tx) => {
        const [receipt] = (await tx.$queryRawUnsafe(
          `INSERT INTO "CommandReceipt" ("actorId","commandKind","idempotencyKey","requestDigest","requestId","resultRef") VALUES ($1,'ProposePartyRoster',$2,$3,$2,$2) RETURNING "id"::text`,
          t.leader.actor.accountId,
          randomUUID(),
          'd'.repeat(64),
        )) as { id: string }[];
        const members = [
          { participantId: t.ana.participantId, role: 'Solo', allocations: [{ amount: '1' }] },
        ];
        const [forged] = (await tx.$queryRawUnsafe(
          `INSERT INTO "PartyProposal" ("partyId","leaderParticipantId","slotId","termsVersionId","termsDigest","snapshot","snapshotDigest","receiptId") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7,$8::uuid) RETURNING "id"::text`,
          t.party.id,
          t.leader.participantId,
          t.slot.slotId,
          t.slot.termsVersionId,
          t.termsDigest,
          JSON.stringify({ members }),
          'e'.repeat(64),
          receipt.id,
        )) as { id: string }[];
        await tx.$executeRawUnsafe(
          `INSERT INTO "PartyProposalMember" ("proposalId","participantId","role","allocations") VALUES ($1::uuid,$2::uuid,'Solo','[{"amount":"1"}]'::jsonb)`,
          forged.id,
          t.ana.participantId,
        );
      }),
    ).rejects.toThrow(/sum exactly/);
  });

  it('shows a proposal only to its leader and named members', async () => {
    const t = await setup();
    const { proposal } = await t.propose(
      t.leader.actor,
      t.proposal(t.split(500000000n, 300000000n, 200000000n)),
    );
    expect((await t.read(t.ana.actor, proposal.id)).id).toBe(proposal.id);
    expect((await t.read(t.leader.actor, proposal.id)).snapshotDigest).toBe(
      proposal.snapshotDigest,
    );
    await rejects(t.read(t.outsider.actor, proposal.id), 'NOT_FOUND');
    await rejects(t.read(t.ana.actor, randomUUID()), 'NOT_FOUND');
  });
});
