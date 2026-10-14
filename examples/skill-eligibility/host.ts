import assert from 'node:assert/strict';
import { explainSkillEligibility } from './skills/eligibility';
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
const requirement = (skillId: string) => ({
  kind: 'SKILL',
  skillId,
  minimumRank: 'B',
  verificationRequired: true,
  assessmentPolicyVersion: 'synthetic-policy',
});
const context = {
  version: 'v1',
  now,
  taxonomy,
  participants: [
    member('alice', [fact('frontend', 'web')]),
    member('bob', [fact('solana', 'chain')]),
  ],
};
const expression = { kind: 'AND', children: [requirement('frontend'), requirement('solana')] };
const input = (coverage: string) => ({ version: 'v1', coverage, requirement: expression });
assert.equal(explainSkillEligibility(context, input('ONE_MEMBER')).status, 'UNMET');
const distributed = explainSkillEligibility(context, input('DISTRIBUTED_PARTY'));
assert.equal(distributed.status, 'MET');
assert.equal(distributed.isAuthorizationToken, false);
assert.equal(distributed.createsPermissionGrant, false);
assert.equal(distributed.consumesCapacity, false);
assert.equal(explainSkillEligibility(context, input('EVERY_MEMBER')).status, 'UNMET');
assert.equal(
  explainSkillEligibility(
    { ...context, participants: [context.participants[0]] },
    { version: 'v1', coverage: 'ONE_MEMBER', requirement: requirement('solana') },
  ).status,
  'UNMET',
);
const expired = { ...context, now: '2026-10-14T01:01:00Z' };
assert.equal(explainSkillEligibility(expired, input('DISTRIBUTED_PARTY')).status, 'UNKNOWN');
assert.throws(
  () => explainSkillEligibility({ ...context, wealth: '1000000' }, input('ONE_MEMBER')),
  /INVALID_HOST_CONTRACT/,
);
assert.throws(
  () => explainSkillEligibility(context, { ...input('ONE_MEMBER'), eligible: true }),
  /INVALID_INPUT/,
);
assert(!JSON.stringify(distributed).includes('synthetic-reviewer'));
assert(Object.isFrozen(distributed.evaluations[0].explanation));
console.log(
  JSON.stringify({
    synthetic: true,
    explicitPartyCoverage: true,
    wrongDomainRejected: true,
    staleIsUnknown: true,
    noPurchasedRank: true,
    noPermissionOrCapacityEffect: true,
    privateEvidenceOmitted: true,
  }),
);
