import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveRaidTerms, publishRaid } from '../src/work-loop/storage';
import type { WorkHost } from '../src/work-loop/contracts';
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

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
// The replication role skips only triggers (immutability, slot/listing state machines) for this transaction.
const replica = <T>(work: (tx: Tx) => Promise<T>) =>
  db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    return work(tx);
  });
// Publication still refuses PARTY terms (UNSUPPORTED_MODE) until Party acceptance exists, so fixtures re-label the
// stored terms of a published SOLO slot.
const rewriteTerms = (termsVersionId: string, terms: unknown) =>
  replica((tx) =>
    tx.$executeRawUnsafe(
      `UPDATE "TermsVersion" SET "snapshot"=$1::jsonb,"digest"=$2 WHERE "id"=$3::uuid`,
      JSON.stringify(terms),
      canonicalRequestDigest(terms),
      termsVersionId,
    ),
  );

async function setup(execution: 'PARTY' | 'SOLO' = 'PARTY', patch: Record<string, unknown> = {}) {
  const leader = await seedWorkHuman(db),
    ana = await seedWorkHuman(db),
    ben = await seedWorkHuman(db),
    outsider = await seedWorkHuman(db);
  const founderId = 'founder-' + randomUUID();
  const slot = await seedWorkSlot(db, founderId);
  const terms = { ...raidTerms(), execution, ...patch };
  await rewriteTerms(slot.termsVersionId, terms);
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
    founderId,
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

  // --- Direct-SQL guard coverage: each case satisfies every foreign key and violates exactly one guard branch. ---
  class Rollback extends Error {}
  /** Runs the inserts, then always rolls back: only immediate (BEFORE) guards are exercised, nothing is committed. */
  const dry = async (work: (tx: Tx) => Promise<unknown>) => {
    try {
      await db.$transaction(async (tx) => {
        await work(tx);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  };
  /** The Postgres guard itself must refuse: its check_violation code and its message, not just any rejection. */
  const guardRejects = async (promise: Promise<unknown>, message: RegExp) => {
    const error = (await promise.then(
      () => undefined,
      (e: unknown) => e,
    )) as { message?: string; meta?: { code?: string } } | undefined;
    expect(error, 'expected the database guard to reject').toBeDefined();
    expect(error?.meta?.code).toBe('23514');
    expect(error?.message).toMatch(message);
  };
  const receiptFor = async (tx: Tx, accountId: string, commandKind: string) =>
    (
      (await tx.$queryRawUnsafe(
        `INSERT INTO "CommandReceipt" ("actorId","commandKind","idempotencyKey","requestDigest","requestId","resultRef") VALUES ($1,$2,$3,$4,$3,$3) RETURNING "id"::text`,
        accountId,
        commandKind,
        randomUUID(),
        'd'.repeat(64),
      )) as { id: string }[]
    )[0].id;
  type Fixture = Awaited<ReturnType<typeof setup>>;
  const insertParty = (tx: Tx, receiptId: string, leaderParticipantId: string) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "Party" ("name","leaderParticipantId","receiptId") VALUES ('Forged',$1::uuid,$2::uuid)`,
      leaderParticipantId,
      receiptId,
    );
  const insertProposal = (
    tx: Tx,
    t: Fixture,
    receiptId: string,
    over: { termsDigest?: string; members?: unknown[] } = {},
  ) =>
    tx.$queryRawUnsafe(
      `INSERT INTO "PartyProposal" ("partyId","leaderParticipantId","slotId","termsVersionId","termsDigest","snapshot","snapshotDigest","receiptId") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7,$8::uuid) RETURNING "id"::text`,
      t.party.id,
      t.leader.participantId,
      t.slot.slotId,
      t.slot.termsVersionId,
      over.termsDigest ?? t.termsDigest,
      JSON.stringify({ members: over.members ?? [] }),
      randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
      receiptId,
    ) as Promise<{ id: string }[]>;
  const insertMember = (
    tx: Tx,
    proposalId: string,
    participantId: string,
    role: string,
    allocations: unknown,
  ) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "PartyProposalMember" ("proposalId","participantId","role","allocations") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb)`,
      proposalId,
      participantId,
      role,
      JSON.stringify(allocations),
    );
  const insertConsent = (
    tx: Tx,
    t: Fixture,
    proposal: { id: string; snapshotDigest: string },
    receiptId: string,
    participantId: string,
  ) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "PartyMemberConsent" ("proposalId","participantId","snapshotDigest","receiptId") VALUES ($1::uuid,$2::uuid,$3,$4::uuid)`,
      proposal.id,
      participantId,
      proposal.snapshotDigest,
      receiptId,
    );
  const workHost = (founderId: string): WorkHost => ({
    allowNewWrites: true,
    authorize: async (_tx, a, g) => a.accountId === founderId && g === 'synthetic-guild',
    reserveSimulatedFunding: async (_tx, b) => 'synthetic:' + b.slotId,
  });
  const founderCmd = (t: Fixture, input: unknown) =>
    cmd({ accountId: t.founderId, sessionHash: 'f'.repeat(64) }, input);
  /** A real terms republish through the work commands: closes the old slot and moves the listing's current terms. */
  async function republish(t: Fixture, publish: boolean) {
    const saved = await run((tx) =>
      saveRaidTerms(
        tx,
        founderCmd(t, {
          listingId: t.slot.listingId,
          expectedRevision: 1,
          guildId: 'synthetic-guild',
          terms: t.slot.terms,
        }),
        workHost(t.founderId),
      ),
    );
    if (publish)
      await run((tx) =>
        publishRaid(
          tx,
          founderCmd(t, { listingId: t.slot.listingId, termsVersionId: saved.termsVersionId }),
          workHost(t.founderId),
        ),
      );
    return saved;
  }
  /** Only the listing's current terms move: the old slot and listing stay AVAILABLE/OPEN, isolating that one guard branch. */
  async function moveCurrentTermsOnly(t: Fixture) {
    await republish(t, false);
    await replica(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "RaidSlot" SET "state"='AVAILABLE' WHERE "id"=$1::uuid`,
        t.slot.slotId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "WorkListing" SET "state"='OPEN' WHERE "id"=$1::uuid`,
        t.slot.listingId,
      );
    });
  }
  const setSlotState = (t: Fixture, state: string) =>
    replica((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "RaidSlot" SET "state"=$2 WHERE "id"=$1::uuid`,
        t.slot.slotId,
        state,
      ),
    );
  const setListingState = (t: Fixture, state: string) =>
    replica((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "WorkListing" SET "state"=$2 WHERE "id"=$1::uuid`,
        t.slot.listingId,
        state,
      ),
    );
  const stale: Record<string, (t: Fixture) => Promise<unknown>> = {
    'the slot is closed': (t) => setSlotState(t, 'CLOSED'),
    'the slot is filled': (t) => setSlotState(t, 'FILLED'),
    'the listing is not open': (t) => setListingState(t, 'DRAFT'),
    'the listing moved to other current terms': moveCurrentTermsOnly,
  };

  it('Party guard: the leader must be the commanding account’s own participant, via a CreateParty receipt', async () => {
    const t = await setup();
    // Control: the matching account, kind and participant passes the guard.
    await dry(async (tx) =>
      insertParty(
        tx,
        await receiptFor(tx, t.ana.actor.accountId, 'CreateParty'),
        t.ana.participantId,
      ),
    );
    await guardRejects(
      dry(async (tx) =>
        insertParty(
          tx,
          await receiptFor(tx, t.leader.actor.accountId, 'CreateParty'),
          t.ana.participantId,
        ),
      ),
      /commanding human participant/,
    );
    await guardRejects(
      dry(async (tx) =>
        insertParty(
          tx,
          await receiptFor(tx, t.ana.actor.accountId, 'ProposePartyRoster'),
          t.ana.participantId,
        ),
      ),
      /commanding human participant/,
    );
  });

  it('PartyProposal guard: the receipt must be the leader’s own ProposePartyRoster command', async () => {
    const t = await setup();
    await guardRejects(
      dry(async (tx) =>
        insertProposal(tx, t, await receiptFor(tx, t.ana.actor.accountId, 'ProposePartyRoster')),
      ),
      /Only the Party leader proposes/,
    );
    await guardRejects(
      dry(async (tx) =>
        insertProposal(tx, t, await receiptFor(tx, t.leader.actor.accountId, 'CreateParty')),
      ),
      /Only the Party leader proposes/,
    );
  });

  it.each(Object.keys(stale))(
    'PartyProposal guard: refuses a roster when %s',
    async (condition) => {
      const t = await setup();
      await dry(async (tx) =>
        insertProposal(tx, t, await receiptFor(tx, t.leader.actor.accountId, 'ProposePartyRoster')),
      );
      await stale[condition](t);
      await guardRejects(
        dry(async (tx) =>
          insertProposal(
            tx,
            t,
            await receiptFor(tx, t.leader.actor.accountId, 'ProposePartyRoster'),
          ),
        ),
        /available slot on the current terms/,
      );
    },
  );

  it('PartyProposal guard: only PARTY terms, and only the exact stored terms digest', async () => {
    const solo = await setup('SOLO');
    await guardRejects(
      dry(async (tx) =>
        insertProposal(
          tx,
          solo,
          await receiptFor(tx, solo.leader.actor.accountId, 'ProposePartyRoster'),
        ),
      ),
      /Only PARTY terms take a roster/,
    );
    const t = await setup();
    await guardRejects(
      dry(async (tx) =>
        insertProposal(
          tx,
          t,
          await receiptFor(tx, t.leader.actor.accountId, 'ProposePartyRoster'),
          {
            termsDigest: 'b'.repeat(64),
          },
        ),
      ),
      /exact stored terms digest/,
    );
  });

  describe('consent after the slot or terms moved on', () => {
    async function proposed() {
      const t = await setup();
      const { proposal } = await t.propose(
        t.leader.actor,
        t.proposal(t.split(500000000n, 300000000n, 200000000n)),
      );
      return {
        t,
        proposal,
        input: { proposalId: proposal.id, snapshotDigest: proposal.snapshotDigest },
      };
    }
    const noConsent = async () =>
      expect(await db.$queryRawUnsafe('SELECT 1 FROM "PartyMemberConsent"')).toHaveLength(0);

    it('consent guard: the receipt must be the member’s own RecordPartyMemberConsent command', async () => {
      const { t, proposal } = await proposed();
      // Control: Ben's own consent receipt passes the guard.
      await dry(async (tx) =>
        insertConsent(
          tx,
          t,
          proposal,
          await receiptFor(tx, t.ben.actor.accountId, 'RecordPartyMemberConsent'),
          t.ben.participantId,
        ),
      );
      await guardRejects(
        dry(async (tx) =>
          insertConsent(
            tx,
            t,
            proposal,
            await receiptFor(tx, t.ben.actor.accountId, 'CreateParty'),
            t.ben.participantId,
          ),
        ),
        /recorded only by the consenting member/,
      );
    });

    it.each(Object.keys(stale))(
      'consent guard: refuses a consent row when %s',
      async (condition) => {
        const { t, proposal } = await proposed();
        await dry(async (tx) =>
          insertConsent(
            tx,
            t,
            proposal,
            await receiptFor(tx, t.ben.actor.accountId, 'RecordPartyMemberConsent'),
            t.ben.participantId,
          ),
        );
        await stale[condition](t);
        await guardRejects(
          dry(async (tx) =>
            insertConsent(
              tx,
              t,
              proposal,
              await receiptFor(tx, t.ben.actor.accountId, 'RecordPartyMemberConsent'),
              t.ben.participantId,
            ),
          ),
          /available slot on the proposal terms/,
        );
      },
    );

    it('commands: SLOT_FILLED once the slot is filled, for consent and for a new roster', async () => {
      const { t, input } = await proposed();
      await setSlotState(t, 'FILLED');
      await rejects(t.consent(t.ana.actor, input), 'SLOT_FILLED');
      await rejects(
        t.propose(t.leader.actor, t.proposal(t.split(500000000n, 300000000n, 200000000n))),
        'SLOT_FILLED',
      );
      await noConsent();
    });

    it('commands: a real terms republish closes the slot, so consent and a new roster are refused', async () => {
      const { t, input } = await proposed();
      await republish(t, true);
      await rejects(t.consent(t.ana.actor, input), 'PUBLICATION_BLOCKED');
      await rejects(
        t.propose(t.leader.actor, t.proposal(t.split(500000000n, 300000000n, 200000000n))),
        'PUBLICATION_BLOCKED',
      );
      await noConsent();
    });

    it('commands: TERMS_VERSION_CHANGED when only the listing’s current terms moved', async () => {
      const { t, input } = await proposed();
      await moveCurrentTermsOnly(t);
      await rejects(t.consent(t.ana.actor, input), 'TERMS_VERSION_CHANGED');
      await rejects(
        t.propose(t.leader.actor, t.proposal(t.split(500000000n, 300000000n, 200000000n))),
        'TERMS_VERSION_CHANGED',
      );
      await noConsent();
    });

    it('commands: DEADLINE_PASSED once the commitment deadline passes', async () => {
      const { t, input } = await proposed();
      const past = {
        ...raidTerms(),
        execution: 'PARTY' as const,
        deadlines: {
          ...raidTerms().deadlines,
          commitment: new Date(Date.now() - 60000).toISOString(),
        },
      };
      await rewriteTerms(t.slot.termsVersionId, past);
      await rejects(t.consent(t.ana.actor, input), 'DEADLINE_PASSED');
      await rejects(
        t.propose(
          t.leader.actor,
          t.proposal(t.split(500000000n, 300000000n, 200000000n), {
            termsDigest: canonicalRequestDigest(past),
          }),
        ),
        'DEADLINE_PASSED',
      );
      await noConsent();
    });
  });

  describe('PartyProposalMember guard', () => {
    const alloc = [{ amount: String(POOL) }];
    /** Forges a proposal whose snapshot already holds the member, so only the member guard can refuse the mirror row. */
    const forged = async (
      tx: Tx,
      t: Fixture,
      member: { participantId: string; role: string; allocations: unknown },
    ) => {
      const [row] = await insertProposal(
        tx,
        t,
        await receiptFor(tx, t.leader.actor.accountId, 'ProposePartyRoster'),
        { members: [member] },
      );
      return row.id;
    };
    it('accepts the exact snapshot member (control)', async () => {
      const t = await setup();
      const member = { participantId: t.ana.participantId, role: 'Frontend', allocations: alloc };
      await dry(async (tx) =>
        insertMember(tx, await forged(tx, t, member), member.participantId, member.role, alloc),
      );
    });
    it.each([
      ['a different role', { role: 'Backend' }],
      ['different allocations', { allocations: [{ amount: '1' }] }],
    ])('refuses a row with %s than the snapshot', async (_name, differs) => {
      const t = await setup();
      const member = { participantId: t.ana.participantId, role: 'Frontend', allocations: alloc };
      await guardRejects(
        dry(async (tx) => {
          const id = await forged(tx, t, member);
          await insertMember(
            tx,
            id,
            member.participantId,
            (differs as { role?: string }).role ?? member.role,
            (differs as { allocations?: unknown }).allocations ?? alloc,
          );
        }),
        /match the immutable snapshot/,
      );
    });
    it('refuses a non-human participant, even one named in the snapshot', async () => {
      const t = await setup();
      const member = { participantId: t.ana.participantId, role: 'Frontend', allocations: alloc };
      await guardRejects(
        dry(async (tx) => {
          const id = await forged(tx, t, member);
          // Participant.kind is checked to HUMAN today; lift that in this rolled-back transaction to prove the guard stands alone.
          await tx.$executeRawUnsafe(
            `ALTER TABLE "Participant" DROP CONSTRAINT "Participant_kind_check"`,
          );
          await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
          await tx.$executeRawUnsafe(
            `UPDATE "Participant" SET "kind"='AI_AGENT' WHERE "id"=$1::uuid`,
            t.ana.participantId,
          );
          await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = origin`);
          await insertMember(tx, id, member.participantId, member.role, alloc);
        }),
        /Only human members consent/,
      );
    });
    it.each([
      [
        'the wrong number of legs',
        [{ amount: '1' }, { amount: '0' }],
        /one allocation per reward leg/,
      ],
      ['an extra key', [{ amount: '1', extra: 'x' }], /exact integer amount/],
      ['a numeric amount', [{ amount: 1 }], /exact integer amount/],
      ['a leading zero', [{ amount: '01' }], /exact integer amount/],
      ['a negative amount', [{ amount: '-1' }], /exact integer amount/],
      ['a fractional amount', [{ amount: '1.5' }], /exact integer amount/],
      ['an amount over 78 digits', [{ amount: '1' + '0'.repeat(78) }], /exact integer amount/],
      ['a leg that is not an object', ['1'], /exact integer amount/],
    ])('refuses an allocation with %s', async (_name, allocations, message) => {
      const t = await setup();
      const member = { participantId: t.ana.participantId, role: 'Frontend', allocations };
      await guardRejects(
        dry(async (tx) =>
          insertMember(
            tx,
            await forged(tx, t, member),
            member.participantId,
            member.role,
            allocations,
          ),
        ),
        message,
      );
    });
  });

  it('refuses a suspended member through the command', async () => {
    const t = await setup();
    const members = t.split(500000000n, 300000000n, 200000000n);
    await db.user.update({ where: { id: t.ben.actor.accountId }, data: { suspended: true } });
    await rejects(t.propose(t.leader.actor, t.proposal(members)), 'INVALID_INPUT');
    await db.user.update({ where: { id: t.ben.actor.accountId }, data: { suspended: false } });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "PartyProposal"')).toHaveLength(0);
    expect((await t.propose(t.leader.actor, t.proposal(members))).status).toBe('EXECUTED');
  });
});
