import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './connection';
import {
  CommandReceiptError,
  canonicalRequestDigest,
  retryWholeTransaction,
  type CommandReceiptTransaction,
} from './command-receipts';
import { saveRaidTerms, publishRaid } from './work-loop/storage';
import type { WorkHost } from './work-loop/contracts';
import {
  createParty,
  proposePartyRoster,
  readPartyProposal,
  recordPartyMemberConsent,
} from './parties/party-storage';
import type { PartyHost } from './parties/contracts';

// This host supplies its own sessions, participants, Guild authority, funding record and transaction port to the
// portable Party storage. It imports no RAID auth, application client, Next or configuration.
type Binding = string | null;
const transaction = <T>(work: (tx: CommandReceiptTransaction) => Promise<T>) =>
  retryWholeTransaction(() =>
    prisma.$transaction(
      async (client) =>
        work({
          dialect: 'POSTGRESQL',
          isolation: 'READ_COMMITTED',
          // This host declares its smaller identity schema instead of the complete RAID layout.
          identityLayout: { xKeyColumn: null, children: ['Session', 'Participant'] },
          async query<Row>(sql: string, bindings: readonly Binding[]) {
            try {
              return await client.$queryRawUnsafe<Row[]>(sql, ...bindings);
            } catch (error) {
              const code = (error as { code?: string; meta?: { code?: string } }).meta?.code;
              throw new CommandReceiptError(
                code === '40P01' || code === '40001' ? 'RETRY_TRANSACTION' : 'STORAGE_UNAVAILABLE',
              );
            }
          },
        } as CommandReceiptTransaction),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 },
    ),
  );

type Person = { accountId: string; sessionHash: string; participantId: string };
const hash = (seed: string) => canonicalRequestDigest({ synthetic: seed });
async function person(label: string): Promise<Person> {
  const accountId = `synthetic-${label}-${randomUUID()}`;
  const sessionHash = hash(accountId);
  await prisma.$executeRawUnsafe('INSERT INTO "User" ("id") VALUES ($1)', accountId);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Session" VALUES ($1,$2,'wallet',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour')`,
    sessionHash,
    accountId,
  );
  const [row] = await prisma.$queryRawUnsafe<{ id: string }[]>(
    'INSERT INTO "Participant" ("accountId") VALUES ($1) RETURNING "id"::text',
    accountId,
  );
  return { accountId, sessionHash, participantId: row.id };
}
const command = (who: { accountId: string; sessionHash: string }, input: unknown, key?: string) => {
  const idempotencyKey = key ?? randomUUID();
  return { actor: who, input, idempotencyKey, requestId: 'example:' + idempotencyKey };
};
const refused = async (work: Promise<unknown>, code: string) => {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e as { code?: string },
  );
  assert.equal(error?.code, code);
};

// The Raid terms fixture. Publication still refuses PARTY terms, so a SOLO slot is published and then relabelled.
const origin = new Date();
origin.setUTCHours(0, 0, 0, 0);
const deadline = (days: number) => new Date(origin.getTime() + days * 86400000).toISOString();
const terms = () => ({
  version: 'v1' as const,
  title: 'Synthetic team documentation task',
  publicSummary: 'Write a verified setup guide as a team.',
  category: 'documentation',
  outcome: 'A guide a new contributor can follow.',
  deliverables: ['setup.md at a pinned commit'],
  acceptanceCriteria: ['A clean installation completes using the documented steps.'],
  exclusions: ['No production changes'],
  dependencies: ['Public synthetic repository'],
  difficulty: 'E',
  requiredSkills: [{ skillId: 'writing', minimumRank: 'E', assessmentPolicyVersion: 'starter-v1' }],
  participantKinds: ['HUMAN'],
  execution: 'SOLO',
  admission: 'INSTANT',
  visibility: 'PUBLIC',
  allowedToolsPolicy: 'Public tools allowed; disclose AI assistance.',
  deadlines: {
    commitment: deadline(6),
    preparation: deadline(7),
    submission: deadline(8),
    review: deadline(9),
    operationalClosure: deadline(10),
  },
  startCondition: 'Verified binding and required resources ready.',
  review: {
    reviewerAccountId: 'reviewer',
    evidence: 'Pinned commit plus installation output.',
    maxRevisionRounds: 1,
  },
  rightsPolicy: 'Contributor retains pre-existing IP; synthetic deliverable licensed MIT.',
  portfolioPolicy: 'Public synthetic deliverable may be shown.',
  withdrawalPolicy: 'May withdraw; recorded outcome, settlement resolved separately.',
  terminationPolicy: 'Finite operational closure; no fault or money decided by silence.',
  disputePolicy: 'Manual evidence review; no settlement authority supplied by this prototype.',
  finalityPolicy: 'Simulated only; no claimable live funds.',
  rewards: [
    {
      policy: {
        assetId: { chain: 'SOLANA', networkIdentity: 'synthetic-work', kind: 'NATIVE_SOL' },
        registryVersion: 'synthetic-v1',
        verifiedDecimals: 9,
        observedAuthorities: [],
        supportedExtensionProfile: 'native',
        observedAt: '2026-10-26T00:00:00.000Z',
        observedSlot: '0',
      },
      amount: '1000000000',
    },
  ],
  fees: { payer: 'FOUNDER', amount: '0', policy: 'No fees in this synthetic host.' },
  fundingSourceRef: 'synthetic-reserve-1',
  settlementMechanism: 'SIMULATED',
});

try {
  const guildId = 'synthetic-guild';
  const founder = await person('founder');
  const [leader, ana, ben, outsider] = await Promise.all(
    ['leader', 'ana', 'ben', 'outsider'].map(person),
  );
  await prisma.$executeRawUnsafe(
    'INSERT INTO "HostGuildAuthority" VALUES ($1,$2)',
    guildId,
    founder.accountId,
  );
  // Current scoped Guild authority behind the work-loop port: the founder's own unexpired session, not suspended.
  const workHost: WorkHost = {
    allowNewWrites: true,
    async authorize(tx, a, g) {
      const found = await tx.query(
        `SELECT 1 FROM "User" u JOIN "HostGuildAuthority" h ON h."accountId"=u."id" JOIN "Session" s ON s."userId"=u."id"
         WHERE u."id"=$1 AND h."guildId"=$2 AND s."tokenHash"=$3 AND NOT u."suspended" AND s."expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')`,
        [a.accountId, g, a.sessionHash],
      );
      return found.length === 1;
    },
    async reserveSimulatedFunding(tx, b) {
      await tx.query('INSERT INTO "HostReservation" VALUES ($1::uuid,$2::uuid,$3)', [
        b.slotId,
        b.termsVersionId,
        JSON.stringify(b.terms.rewards),
      ]);
      return 'synthetic:' + b.slotId;
    },
  };
  const saved = await transaction((tx) =>
    saveRaidTerms(
      tx,
      command(founder, { listingId: null, expectedRevision: 0, guildId, terms: terms() }),
      workHost,
    ),
  );
  const published = await transaction((tx) =>
    publishRaid(
      tx,
      command(founder, { listingId: saved.listingId, termsVersionId: saved.termsVersionId }),
      workHost,
    ),
  );
  // Fixture only: relabel the published slot's stored terms as PARTY. Superuser-only, and exactly the trigger bypass the
  // module documentation warns about, so a production host must never run the application role this way.
  const partyTerms = { ...terms(), execution: 'PARTY' };
  await prisma.$transaction(async (client) => {
    await client.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await client.$executeRawUnsafe(
      `UPDATE "TermsVersion" SET "snapshot"=$1::jsonb,"digest"=$2 WHERE "id"=$3::uuid`,
      JSON.stringify(partyTerms),
      canonicalRequestDigest(partyTerms),
      saved.termsVersionId,
    );
  });
  const termsDigest = canonicalRequestDigest(partyTerms);

  const on: PartyHost = { allowNewWrites: true };
  const off: PartyHost = { allowNewWrites: false };
  // The leader is the commanding human's own participant, and a repeat of the same command replays with writes off.
  const key = randomUUID();
  const { party } = await transaction((tx) =>
    createParty(tx, command(leader, { name: 'Synthetic Party' }, key), on),
  );
  assert.equal(party.leaderParticipantId, leader.participantId);
  const replayed = await transaction((tx) =>
    createParty(tx, command(leader, { name: 'Synthetic Party' }, key), off),
  );
  assert.equal(replayed.status, 'REPLAYED');
  assert.equal(replayed.party.id, party.id);
  await refused(
    transaction((tx) => createParty(tx, command(ana, { name: 'Another Party' }), off)),
    'WRITES_DISABLED',
  );

  const split = (a: string, b: string, c: string) => [
    { participantId: leader.participantId, role: 'Lead', allocations: [{ amount: a }] },
    { participantId: ana.participantId, role: 'Frontend', allocations: [{ amount: b }] },
    { participantId: ben.participantId, role: 'Docs', allocations: [{ amount: c }] },
  ];
  const roster = (members: unknown) => ({
    partyId: party.id,
    slotId: published.slotId,
    termsVersionId: saved.termsVersionId,
    termsDigest,
    members,
  });
  const propose = (who: Person, members: unknown, host = on) =>
    transaction((tx) => proposePartyRoster(tx, command(who, roster(members)), host));
  // One amount per reward leg, summing to the leg exactly: dust or a shortfall is refused before anything is stored.
  await refused(propose(leader, split('500000000', '300000000', '199999999')), 'INVALID_INPUT');
  await refused(propose(leader, split('500000000', '300000000', '200000001')), 'INVALID_INPUT');
  // Only the Party's leader proposes its roster.
  await refused(propose(ana, split('500000000', '300000000', '200000000')), 'FORBIDDEN');
  const { proposal } = await propose(leader, split('500000000', '300000000', '200000000'));
  assert.equal(proposal.members.length, 3);
  assert.equal(proposal.allConsented, false);
  assert.equal(proposal.snapshotDigest.length, 64);

  // Someone outside the roster learns nothing about the proposal, by consent or by read.
  const input = { proposalId: proposal.id, snapshotDigest: proposal.snapshotDigest };
  const consent = (who: Person, body: unknown, host = on, k?: string) =>
    transaction((tx) => recordPartyMemberConsent(tx, command(who, body, k), host));
  const read = (who: Person) =>
    transaction((tx) => readPartyProposal(tx, who, { proposalId: proposal.id }));
  await refused(consent(outsider, input), 'NOT_FOUND');
  await refused(read(outsider), 'NOT_FOUND');
  // A member consents to the exact digest they saw; any other digest is refused.
  await refused(consent(ana, { ...input, snapshotDigest: 'c'.repeat(64) }), 'REVISION_CONFLICT');
  // Consent names no participant: the member is the signed-in session, so nobody consents for another.
  await refused(consent(leader, { ...input, participantId: ana.participantId }), 'INVALID_INPUT');
  const lead = await consent(leader, input);
  assert.equal(lead.consent.participantId, leader.participantId);
  const anaKey = randomUUID();
  const given = await consent(ana, input, on, anaKey);
  assert.equal(given.consent.participantId, ana.participantId);
  assert.equal(
    (await read(leader)).members.filter((m) => m.consentedAt !== null).length,
    2,
    'Only the members who consented are marked.',
  );
  assert.equal((await read(ana)).allConsented, false);
  // Original receipts replay with new writes off, while a new consent is not available.
  const again = await consent(ana, input, off, anaKey);
  assert.equal(again.status, 'REPLAYED');
  assert.equal(again.consent.id, given.consent.id);
  await refused(consent(ben, input, off), 'WRITES_DISABLED');
  await consent(ben, input);
  assert.equal((await read(ben)).allConsented, true);

  // The database also refuses a consent a coding mistake would record for another human: the leader's own consent
  // receipt cannot stand in for Ben. This guard trusts the CommandReceipt row, not an authenticated identity.
  const forged = await prisma
    .$transaction(async (client) => {
      const [receipt] = await client.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "CommandReceipt" ("actorId","commandKind","idempotencyKey","requestDigest","requestId")
         VALUES ($1,'RecordPartyMemberConsent',$2,$3,$2) RETURNING "id"::text`,
        leader.accountId,
        randomUUID(),
        'd'.repeat(64),
      );
      await client.$executeRawUnsafe(
        `INSERT INTO "PartyMemberConsent" ("proposalId","participantId","snapshotDigest","receiptId") VALUES ($1::uuid,$2::uuid,$3,$4::uuid)`,
        proposal.id,
        outsider.participantId,
        proposal.snapshotDigest,
        receipt.id,
      );
    })
    .then(
      () => false,
      (error: Error) => /recorded only by the consenting member/.test(error.message),
    );
  assert.equal(forged, true);

  // None of it accepted work, held capacity or moved money.
  const [effects] = await prisma.$queryRawUnsafe<{ commitments: bigint; engagements: bigint }[]>(
    `SELECT (SELECT count(*) FROM "ActiveCommitment") AS commitments,(SELECT count(*) FROM "Engagement") AS engagements`,
  );
  assert.equal(Number(effects.commitments) + Number(effects.engagements), 0);

  console.log(
    JSON.stringify({
      synthetic: true,
      ownDatabase: true,
      leaderOwnsParty: true,
      exactSplitRequired: true,
      staleDigestRefused: true,
      outsiderLearnsNothing: true,
      consentIsTheMembersOwn: true,
      directForgeryRefusedByDatabase: true,
      replayWithWritesOff: true,
      acceptsNothing: true,
    }),
  );
} finally {
  await prisma.$disconnect();
}
