import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SkillEligibilityContractError,
  explainSkillEligibility,
  parseSkillEligibilityInput,
} from '../src/skills/eligibility';
import { readPublishedSkillTaxonomy } from '../src/skills/taxonomy-storage';
import { SkillTaxonomyStorageError } from '../src/skills/taxonomy-storage-contracts';
import { CommandReceiptError } from '../src/command-receipts';
import {
  RootAcceptanceUnavailableError,
  buildRootEligibilityContext,
  buildSkillRequirement,
  createRootAcceptanceHost,
} from '../src/lib/work-acceptance-host';
import { raidTerms } from './helpers/raid-terms-fixture';

vi.mock('../src/skills/taxonomy-storage', async (load) => {
  const actual = await load<typeof import('../src/skills/taxonomy-storage')>();
  return { ...actual, readPublishedSkillTaxonomy: vi.fn(actual.readPublishedSkillTaxonomy) };
});
vi.mock('../src/skills/eligibility', async (load) => {
  const actual = await load<typeof import('../src/skills/eligibility')>();
  return { ...actual, explainSkillEligibility: vi.fn(actual.explainSkillEligibility) };
});
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
  it('refuses to build a requirement from no skills instead of returning nothing', () => {
    expect(() => buildSkillRequirement([])).toThrow(SkillEligibilityContractError);
  });
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
  it('asks a person without consent to record it first, without reading anything else', async () => {
    const seen: string[] = [];
    const tx = {
      dialect: 'POSTGRESQL',
      isolation: 'READ_COMMITTED',
      query: async (sql: string) => (seen.push(sql), []),
    };
    await expect(host.assess(tx as never, context as never)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    expect(seen).toHaveLength(1);
  });
});

describe('Root acceptance host error boundaries', () => {
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
  const taxonomy = { skills: [] } as never;
  /** Consent exists; `fail` decides which later query breaks. */
  const tx = (fail: (sql: string) => unknown = () => undefined) => ({
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    query: async (sql: string) => {
      const error = fail(sql);
      if (error) throw error;
      if (sql.includes('WorkAcceptanceConsent')) return [{ id: 'consent-1' }];
      if (sql.includes('clock_timestamp')) return [{ now: new Date('2026-10-29T00:00:00Z') }];
      return [];
    },
  });
  beforeEach(() => {
    vi.mocked(readPublishedSkillTaxonomy).mockReset();
    vi.mocked(explainSkillEligibility).mockReset();
  });
  it.each(['INVALID_INPUT', 'FORBIDDEN'] as const)(
    'treats a %s taxonomy read as not approved',
    async (code) => {
      vi.mocked(readPublishedSkillTaxonomy).mockRejectedValueOnce(
        new SkillTaxonomyStorageError(code),
      );
      await expect(host.assess(tx() as never, context as never)).resolves.toBeNull();
    },
  );
  it.each([
    ['AUTHENTICATION_REQUIRED', 'UNAUTHENTICATED'],
    ['ACCOUNT_RESTRICTED', 'ACCOUNT_RESTRICTED'],
  ] as const)('reports a %s taxonomy read as a session problem (%s)', async (code, expected) => {
    vi.mocked(readPublishedSkillTaxonomy).mockRejectedValueOnce(
      new SkillTaxonomyStorageError(code),
    );
    await expect(host.assess(tx() as never, context as never)).rejects.toMatchObject({
      name: 'WorkError',
      code: expected,
    });
  });
  it.each(['SkillAssessment', 'clock_timestamp', 'pg_advisory_xact_lock'])(
    'reports a failing %s query as a typed retryable outage, not a verdict',
    async (marker) => {
      vi.mocked(readPublishedSkillTaxonomy).mockResolvedValueOnce(taxonomy);
      const failed = host.assess(
        tx((sql) => (sql.includes(marker) ? new Error('connection lost') : undefined)) as never,
        context as never,
      );
      await expect(failed).rejects.toBeInstanceOf(RootAcceptanceUnavailableError);
      await expect(failed).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', retryable: true });
    },
  );
  it('keeps a deadlock retry signal intact so the whole transaction is retried', async () => {
    vi.mocked(readPublishedSkillTaxonomy).mockResolvedValueOnce(taxonomy);
    const retry = new CommandReceiptError('RETRY_TRANSACTION');
    await expect(
      host.assess(
        tx((sql) => (sql.includes('SkillAssessment') ? retry : undefined)) as never,
        context as never,
      ),
    ).rejects.toBe(retry);
  });
  it('treats a malformed requirement as not approved but lets a broken host contract surface', async () => {
    vi.mocked(readPublishedSkillTaxonomy).mockResolvedValue(taxonomy);
    vi.mocked(explainSkillEligibility).mockImplementationOnce(() => {
      throw new SkillEligibilityContractError('INVALID_INPUT');
    });
    await expect(host.assess(tx() as never, context as never)).resolves.toBeNull();
    vi.mocked(explainSkillEligibility).mockImplementationOnce(() => {
      throw new SkillEligibilityContractError('INVALID_HOST_CONTRACT');
    });
    await expect(host.assess(tx() as never, context as never)).rejects.toMatchObject({
      code: 'INVALID_HOST_CONTRACT',
    });
  });
  it('builds the eligibility context from current facts and drops evidence whose domain changed', () => {
    const fact = {
      assessmentId: 'a-1',
      revision: 2,
      skillId: 'frontend',
      skillDomain: 'web',
      state: 'VERIFIED' as const,
      assessedRank: 'A' as const,
      policyVersionId: 'policy-1',
      evaluatorAccountId: 'evaluator',
      issuedAt: new Date('2026-10-01T00:00:00Z'),
      reassessmentAt: null,
      definitionVersionId: 'rubric-1',
    };
    const now = new Date('2026-10-29T00:00:00Z');
    const built = buildRootEligibilityContext({
      participantId: context.participantId,
      accountId: 'someone',
      taxonomy: { skills: [{ id: 'frontend', domain: 'web' }] } as never,
      facts: [fact, { ...fact, skillId: 'backend', skillDomain: 'web' }],
      now,
    });
    const [member] = built.participants;
    expect(member.participant).toEqual({
      id: context.participantId,
      kind: 'HUMAN',
      accountId: 'someone',
    });
    expect(member.evidence.validUntil).toBe('2026-10-29T00:01:00.000Z');
    expect(member.evidence.skills.map((s) => s.skillId)).toEqual(['frontend']);
    expect(member.evidence.skills[0]).toMatchObject({
      state: 'VERIFIED',
      assessmentReference: { recordId: 'a-1', revision: 2 },
      reassessmentAt: null,
    });
  });
});
