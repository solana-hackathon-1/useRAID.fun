import assert from 'node:assert/strict';
import { PartyCoverageError, evaluatePartyCoverage } from './parties/party-coverage';
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
console.log(
  JSON.stringify({
    synthetic: true,
    distributedCoverageIsExplicit: true,
    partyLabelManufacturesNoSkill: true,
    leaderCannotStandInForMember: true,
    consentNamesNoParticipant: true,
    exactIntegerAllocations: true,
  }),
);
