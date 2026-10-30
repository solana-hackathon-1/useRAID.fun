import assert from 'node:assert/strict';
import { canonicalRequestDigest } from './command-receipts';
import { WorkError } from './work-loop/contracts';
import { PartyCoverageError, evaluatePartyCoverage } from './parties/party-coverage';
import { PartyHttpError, createPartyHandlers, type PartyHttpHost } from './parties/party-http';
import {
  MemberProposalSchema,
  ProposePartyRosterInput,
  RecordPartyConsentInput,
} from './parties/contracts';

const now = '2026-10-14T01:00:00.000Z';
const category = (id: string, domain: string) => ({
  id,
  domain,
  name: id,
  status: 'ACTIVE',
  aliases: [id],
});
const taxonomy = {
  version: 'v1',
  id: 'synthetic-catalog',
  revision: 1,
  state: 'PUBLISHED',
  publishedByAccountId: 'synthetic-admin',
  publishedAt: '2026-10-13T00:00:00Z',
  skills: [category('frontend', 'web'), category('solana', 'chain')],
};
const fact = (skillId: string, domain: string) => ({
  kind: 'ASSESSMENT',
  skillId,
  domain,
  state: 'VERIFIED',
  assessedRank: 'A',
  assessmentReference: { recordId: 'synthetic-assessment-' + skillId, revision: 1 },
  rubricReference: { recordId: 'synthetic-rubric', revision: 1 },
  assessmentPolicyVersion: 'synthetic-policy',
  evaluatorAccountId: 'synthetic-reviewer',
  issuedAt: '2026-10-13T00:00:00Z',
  reassessmentAt: null,
});
const member = (id: string, skills: unknown[]) => ({
  participant: { kind: 'HUMAN', id, accountId: 'account-' + id },
  evidence: { status: 'CURRENT', observedAt: now, validUntil: '2026-10-14T01:01:00Z', skills },
});
const required = [
  { skillId: 'frontend', minimumRank: 'B' as const, assessmentPolicyVersion: 'synthetic-policy' },
  { skillId: 'solana', minimumRank: 'B' as const, assessmentPolicyVersion: 'synthetic-policy' },
];
const context = (...participants: unknown[]) =>
  ({ version: 'v1', now, taxonomy, participants }) as unknown as Parameters<
    typeof evaluatePartyCoverage
  >[0];

// Complementary members cover the terms only under the explicit distributed rule; a specialist does not cover everyone.
const roster = context(
  member('alice', [fact('frontend', 'web')]),
  member('bob', [fact('solana', 'chain')]),
);
assert.equal(
  evaluatePartyCoverage(roster, ['alice', 'bob'], required, 'DISTRIBUTED_PARTY').status,
  'MET',
);
assert.equal(
  evaluatePartyCoverage(roster, ['alice', 'bob'], required, 'ONE_MEMBER').status,
  'UNMET',
);
assert.equal(
  evaluatePartyCoverage(roster, ['alice', 'bob'], required, 'EVERY_MEMBER').status,
  'UNMET',
);
// No skill on the roster means no coverage: the label manufactures nothing.
const empty = context(member('alice', [fact('frontend', 'web')]), member('bob', []));
assert.equal(
  evaluatePartyCoverage(empty, ['alice', 'bob'], required, 'DISTRIBUTED_PARTY').status,
  'UNMET',
);
// A leader outside the roster cannot stand in for a member.
const withLeader = context(
  member('alice', [fact('frontend', 'web')]),
  member('leader', [fact('solana', 'chain')]),
);
assert.throws(
  () => evaluatePartyCoverage(withLeader, ['alice', 'bob'], required, 'DISTRIBUTED_PARTY'),
  PartyCoverageError,
);

// Consent names the proposal and the digest the member saw, never a participant: the member is the signed-in session.
const digest = 'a'.repeat(64);
assert.equal(
  RecordPartyConsentInput.safeParse({ proposalId: crypto.randomUUID(), snapshotDigest: digest })
    .success,
  true,
);
assert.equal(
  RecordPartyConsentInput.safeParse({
    proposalId: crypto.randomUUID(),
    snapshotDigest: digest,
    participantId: crypto.randomUUID(),
  }).success,
  false,
);
// Allocations are exact integer base units: no decimals, signs or leading zeros.
const allocation = (amount: string) =>
  MemberProposalSchema.safeParse({
    participantId: crypto.randomUUID(),
    role: 'Lead',
    allocations: [{ amount }],
  }).success;
assert.equal(allocation('500000000'), true);
for (const bad of ['0.5', '-1', '007', '1e9', ' 5']) assert.equal(allocation(bad), false);
assert.equal(
  ProposePartyRosterInput.safeParse({
    partyId: crypto.randomUUID(),
    slotId: crypto.randomUUID(),
    termsVersionId: crypto.randomUUID(),
    termsDigest: digest,
    members: [],
  }).success,
  false,
);

// The HTTP transport over an in-memory host. The host owns the session, origin, throttles and storage; the transport
// parses strictly, binds ids from the path, and refuses any result that does not describe the request it answers.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const people = {
  leader: { accountId: 'account-leader', sessionHash: 'a'.repeat(64), participantId: uuid(10) },
  ana: { accountId: 'account-ana', sessionHash: 'b'.repeat(64), participantId: uuid(11) },
};
let signedIn: keyof typeof people | null = 'leader';
const store = {
  party: null as null | { id: string; leader: string },
  proposal: null as null | {
    id: string;
    partyId: string;
    slotId: string;
    termsVersionId: string;
    termsDigest: string;
    members: { participantId: string; role: string; allocations: { amount: string }[] }[];
    consented: Set<string>;
  },
};
const who = (accountId: string) =>
  Object.values(people).find((p) => p.accountId === accountId)!.participantId;
const view = () => {
  const p = store.proposal!;
  const members = [...p.members].sort((a, b) => (a.participantId < b.participantId ? -1 : 1));
  return {
    id: p.id,
    partyId: p.partyId,
    leaderParticipantId: store.party!.leader,
    slotId: p.slotId,
    termsVersionId: p.termsVersionId,
    termsDigest: p.termsDigest,
    snapshotDigest: canonicalRequestDigest({
      partyId: p.partyId,
      slotId: p.slotId,
      termsVersionId: p.termsVersionId,
      termsDigest: p.termsDigest,
      members,
    }),
    members: members.map((m) => ({
      ...m,
      consentedAt: p.consented.has(m.participantId) ? now : null,
    })),
    allConsented: members.every((m) => p.consented.has(m.participantId)),
    createdAt: now,
  };
};
const host: PartyHttpHost = {
  version: 'v1',
  requestId: () => crypto.randomUUID(),
  actor: async () => {
    if (!signedIn) throw new PartyHttpError(401);
    return { accountId: people[signedIn].accountId, sessionHash: people[signedIn].sessionHash };
  },
  checkOrigin: (request) => {
    if (request.headers.get('origin') !== 'https://raid.example') throw new PartyHttpError(403);
  },
  rateLimit: () => undefined,
  create: async (command) => {
    const input = command.input as { name: string };
    store.party = { id: uuid(1), leader: who(command.actor.accountId) };
    return {
      status: 'EXECUTED',
      party: {
        id: uuid(1),
        name: input.name,
        leaderParticipantId: store.party.leader,
        createdAt: now,
      },
    };
  },
  propose: async (command) => {
    const input = command.input as NonNullable<typeof store.proposal>;
    if (!store.party || store.party.id !== input.partyId) throw new WorkError('NOT_FOUND');
    if (store.party.leader !== who(command.actor.accountId)) throw new WorkError('FORBIDDEN');
    store.proposal = { ...input, id: uuid(4), consented: new Set() };
    return { status: 'EXECUTED', proposal: view() };
  },
  consent: async (command) => {
    const input = command.input as { proposalId: string; snapshotDigest: string };
    const me = who(command.actor.accountId);
    // Someone off the roster learns nothing about the proposal.
    if (!store.proposal?.members.some((m) => m.participantId === me))
      throw new WorkError('NOT_FOUND');
    if (view().snapshotDigest !== input.snapshotDigest) throw new WorkError('REVISION_CONFLICT');
    store.proposal.consented.add(me);
    return {
      status: 'EXECUTED',
      consent: {
        id: uuid(20),
        proposalId: uuid(4),
        participantId: me,
        snapshotDigest: input.snapshotDigest,
        consentedAt: now,
      },
    };
  },
  read: async () => view(),
};
const handlers = createPartyHandlers(host);
const request = (path: string, body: unknown, key = crypto.randomUUID()) =>
  new Request('https://raid.example' + path, {
    method: 'POST',
    headers: {
      origin: 'https://raid.example',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  });
const created = await handlers.CREATE(request('/api/v1/parties', { name: 'Synthetic Party' }));
assert.equal(created.status, 200);
const members = [
  { participantId: people.leader.participantId, role: 'Lead', allocations: [{ amount: '600' }] },
  { participantId: people.ana.participantId, role: 'Frontend', allocations: [{ amount: '400' }] },
];
const rosterBody = {
  slotId: uuid(2),
  termsVersionId: uuid(3),
  termsDigest: 'b'.repeat(64),
  members,
};
// The Party comes from the path: a body that names one is a schema failure, and a foreign origin is refused.
assert.equal(
  (
    await handlers.PROPOSE(
      request('/api/v1/parties/p/proposals', { ...rosterBody, partyId: uuid(1) }),
      uuid(1),
    )
  ).status,
  422,
);
const foreign = new Request('https://raid.example/api/v1/parties', {
  method: 'POST',
  headers: {
    origin: 'https://evil.example',
    'content-type': 'application/json',
    'idempotency-key': crypto.randomUUID(),
  },
  body: JSON.stringify({ name: 'x' }),
});
assert.equal((await handlers.CREATE(foreign)).status, 403);
const proposedResponse = await handlers.PROPOSE(
  request('/api/v1/parties/p/proposals', rosterBody),
  uuid(1),
);
assert.equal(proposedResponse.status, 200);
const proposal = (await proposedResponse.json()).proposal;
// A member who is not the leader cannot propose; a stranger to the roster gets NOT_FOUND on consent.
signedIn = 'ana';
assert.equal(
  (await handlers.PROPOSE(request('/api/v1/parties/p/proposals', rosterBody), uuid(1))).status,
  403,
);
const consentBody = { snapshotDigest: proposal.snapshotDigest };
// The consent body names no participant: the member is the signed-in session, so nobody consents for another.
assert.equal(
  (
    await handlers.CONSENT(
      request('/api/v1/party-proposals/x/consents', {
        ...consentBody,
        participantId: people.leader.participantId,
      }),
      uuid(4),
    )
  ).status,
  422,
);
const consented = await handlers.CONSENT(
  request('/api/v1/party-proposals/x/consents', consentBody),
  uuid(4),
);
assert.equal(consented.status, 200);
assert.equal((await consented.json()).consent.participantId, people.ana.participantId);
assert.equal(
  (
    await handlers.CONSENT(
      request('/api/v1/party-proposals/x/consents', { snapshotDigest: 'c'.repeat(64) }),
      uuid(4),
    )
  ).status,
  409,
);
// A host that returns a roster other than the one sent is a contract failure, never a silent substitute.
const tampered = createPartyHandlers({
  ...host,
  propose: async (command) => {
    const result = (await host.propose(command)) as {
      proposal: { members: { allocations: { amount: string }[] }[] };
    };
    result.proposal.members[0].allocations[0].amount = '1000';
    return result;
  },
});
signedIn = 'leader';
assert.equal(
  (await tampered.PROPOSE(request('/api/v1/parties/p/proposals', rosterBody), uuid(1))).status,
  503,
);
signedIn = null;
assert.equal(
  (await handlers.READ(new Request('https://raid.example/api/v1/party-proposals/x'), uuid(4)))
    .status,
  401,
);

console.log(
  JSON.stringify({
    synthetic: true,
    distributedCoverageIsExplicit: true,
    partyLabelManufacturesNoSkill: true,
    leaderCannotStandInForMember: true,
    consentNamesNoParticipant: true,
    exactIntegerAllocations: true,
    httpBindsPathIdsAndSession: true,
    httpRefusesSubstitutedResults: true,
  }),
);
