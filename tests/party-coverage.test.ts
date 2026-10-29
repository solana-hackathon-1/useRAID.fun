import { describe, expect, it } from 'vitest';
import { PartyCoverageError, evaluatePartyCoverage } from '../src/parties';
import type { SkillEligibilityContext } from '../src/skills/eligibility';

const now = '2026-10-14T01:00:00.000Z';
const taxonomy = {
  version: 'v1',
  id: 'catalog',
  revision: 3,
  state: 'PUBLISHED',
  publishedByAccountId: 'admin',
  publishedAt: '2026-10-13T00:00:00.000Z',
  skills: [
    { id: 'react', domain: 'frontend', name: 'React', status: 'ACTIVE', aliases: ['react'] },
    {
      id: 'solana',
      domain: 'solana-programs',
      name: 'Solana',
      status: 'ACTIVE',
      aliases: ['solana'],
    },
  ],
};
const assessment = (skillId: string, domain: string) => ({
  kind: 'ASSESSMENT',
  skillId,
  domain,
  state: 'VERIFIED',
  assessedRank: 'A',
  assessmentReference: { recordId: 'assessment-' + skillId, revision: 2 },
  rubricReference: { recordId: 'rubric', revision: 1 },
  assessmentPolicyVersion: 'policy-1',
  evaluatorAccountId: 'reviewer',
  issuedAt: '2026-10-13T00:00:00.000Z',
  reassessmentAt: null,
});
const react = () => assessment('react', 'frontend');
const solana = () => assessment('solana', 'solana-programs');
const member = (id: string, skills: unknown[]) => ({
  participant: { id, kind: 'HUMAN', accountId: id + '-account' },
  evidence: {
    status: 'CURRENT',
    observedAt: now,
    validUntil: '2026-10-14T01:01:00.000Z',
    skills,
  },
});
const context = (...participants: unknown[]) =>
  ({ version: 'v1', now, taxonomy, participants }) as unknown as SkillEligibilityContext;
const required = [
  { skillId: 'react', minimumRank: 'C' as const, assessmentPolicyVersion: 'policy-1' },
  { skillId: 'solana', minimumRank: 'C' as const, assessmentPolicyVersion: 'policy-1' },
];

describe('Party skill coverage uses each member’s own evidence', () => {
  it('lets complementary members cover different skills under an explicit distributed rule', () => {
    const roster = context(member('alice', [react()]), member('bob', [solana()]));
    expect(
      evaluatePartyCoverage(roster, ['alice', 'bob'], required, 'DISTRIBUTED_PARTY').status,
    ).toBe('MET');
  });
  it('does not let a Party manufacture a skill nobody on the roster has', () => {
    const roster = context(member('alice', [react()]), member('bob', []));
    expect(
      evaluatePartyCoverage(roster, ['alice', 'bob'], required, 'DISTRIBUTED_PARTY').status,
    ).toBe('UNMET');
  });
  it('requires every member when the rule says so, not just one specialist', () => {
    const roster = context(member('alice', [react(), solana()]), member('bob', []));
    expect(evaluatePartyCoverage(roster, ['alice', 'bob'], required, 'ONE_MEMBER').status).toBe(
      'MET',
    );
    expect(evaluatePartyCoverage(roster, ['alice', 'bob'], required, 'EVERY_MEMBER').status).toBe(
      'UNMET',
    );
  });
  it('refuses a context that is not exactly the roster, so a leader’s record cannot stand in for members', () => {
    const leaderOnly = context(member('alice', [react()]), member('leader', [react(), solana()]));
    expect(() =>
      evaluatePartyCoverage(leaderOnly, ['alice', 'bob'], required, 'DISTRIBUTED_PARTY'),
    ).toThrow(PartyCoverageError);
    const missing = context(member('alice', [react(), solana()]));
    expect(() =>
      evaluatePartyCoverage(missing, ['alice', 'bob'], required, 'DISTRIBUTED_PARTY'),
    ).toThrow(PartyCoverageError);
    expect(() =>
      evaluatePartyCoverage(
        context(member('alice', [react()])),
        ['alice', 'alice'],
        required,
        'ONE_MEMBER',
      ),
    ).toThrow(PartyCoverageError);
  });
  it('is met when the terms require no skills', () => {
    expect(
      evaluatePartyCoverage(context(member('alice', [])), ['alice'], [], 'EVERY_MEMBER').status,
    ).toBe('MET');
  });
});
