import { describe, expect, it } from 'vitest';
import { parseSkillEligibilityInput } from '../src/skills/eligibility';
import { buildSkillRequirement, createRootAcceptanceHost } from '../src/lib/work-acceptance-host';
import { raidTerms } from './helpers/raid-terms-fixture';

const skills = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    skillId: 'skill-' + i,
    minimumRank: 'D' as const,
    assessmentPolicyVersion: 'policy-1',
  }));
const leaves = (node: { kind: string; children?: unknown[]; skillId?: string }): string[] =>
  node.kind === 'SKILL'
    ? [node.skillId!]
    : (node.children as (typeof node)[]).flatMap((child) => leaves(child));
describe('Root acceptance requirement', () => {
  it.each([1, 16, 17, 50])(
    'keeps every one of %s required skills inside the eligibility schema limits',
    (n) => {
      const requirement = buildSkillRequirement(skills(n));
      const parsed = parseSkillEligibilityInput({
        version: 'v1',
        coverage: 'ONE_MEMBER',
        requirement,
      });
      expect(leaves(parsed.requirement!)).toEqual(skills(n).map((s) => s.skillId));
      expect(parsed.requirement!.kind).toBe('AND');
    },
  );
});
describe('Root acceptance host failures', () => {
  const context = {
    actor: { accountId: 'someone', sessionHash: 'a'.repeat(64) },
    participantId: '11111111-1111-4111-8111-111111111111',
    slotId: '22222222-2222-4222-8222-222222222222',
    termsVersionId: '33333333-3333-4333-8333-333333333333',
    terms: raidTerms(),
  };
  const host = createRootAcceptanceHost({
    taxonomyId: 'catalog-1',
    allowNewWrites: true,
    isOperator: () => false,
  });
  it('lets an infrastructure error propagate instead of reporting the person as ineligible', async () => {
    const tx = {
      dialect: 'POSTGRESQL',
      isolation: 'READ_COMMITTED',
      query: async (sql: string) =>
        sql.includes('WorkAcceptanceConsent')
          ? [{ id: 'consent-1' }]
          : Promise.reject(new Error('connection lost')),
    };
    await expect(host.assess(tx as never, context as never)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });
  it('treats a person without consent as not approved without reading anything else', async () => {
    const seen: string[] = [];
    const tx = {
      dialect: 'POSTGRESQL',
      isolation: 'READ_COMMITTED',
      query: async (sql: string) => (seen.push(sql), []),
    };
    expect(await host.assess(tx as never, context as never)).toBeNull();
    expect(seen).toHaveLength(1);
  });
});
