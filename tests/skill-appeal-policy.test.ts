import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPEAL_ADJUDICATION_SECONDS,
  DEFAULT_APPEAL_FILING_WINDOW_SECONDS,
  evaluateAppealAdjudicator,
  appealFilingWindowOpen,
} from '../src/skill-appeals/policy';

const facts = {
  version: 'v1' as const,
  adjudicatorAccountId: 'synthetic-adjudicator',
  appellantAccountId: 'synthetic-appellant',
  originalReviewerAccountIds: ['synthetic-reviewer'],
  sharedGuildIds: [] as string[],
  onAllowlist: true,
};

describe('skill-assessment appeal adjudicator independence (DEC-2026-11-13-12, 09.7, 17.4)', () => {
  it('allows an allowlisted adjudicator who is not a party to the case', () => {
    expect(evaluateAppealAdjudicator(facts)).toEqual({ allowed: true });
  });
  it.each([
    ['not allowlisted', { onAllowlist: false }, 'NOT_AUTHORIZED'],
    ['the appellant', { adjudicatorAccountId: 'synthetic-appellant' }, 'SELF_ADJUDICATION'],
    ['an original reviewer', { adjudicatorAccountId: 'synthetic-reviewer' }, 'ORIGINAL_REVIEWER'],
    ['sharing a Guild with the appellant', { sharedGuildIds: ['g1'] }, 'GUILD_RELATIONSHIP'],
    ['sharing a Party with the appellant (17.4)', { sharedPartyIds: ['p1'] }, 'PARTY_RELATIONSHIP'],
  ])('refuses %s', (_name, patch, reason) => {
    expect(evaluateAppealAdjudicator({ ...facts, ...patch })).toEqual({ allowed: false, reason });
  });
  it('reports self-adjudication before any other reason', () => {
    expect(
      evaluateAppealAdjudicator({
        ...facts,
        adjudicatorAccountId: 'synthetic-appellant',
        onAllowlist: true,
        originalReviewerAccountIds: ['synthetic-appellant'],
      }),
    ).toEqual({ allowed: false, reason: 'SELF_ADJUDICATION' });
  });
  it('treats facts without Party relationships as no Party conflict (existing hosts keep working)', () => {
    expect(evaluateAppealAdjudicator({ ...facts, sharedPartyIds: [] })).toEqual({ allowed: true });
  });
  it('reports a Guild relationship before a Party relationship', () => {
    expect(
      evaluateAppealAdjudicator({ ...facts, sharedGuildIds: ['g1'], sharedPartyIds: ['p1'] }),
    ).toEqual({ allowed: false, reason: 'GUILD_RELATIONSHIP' });
  });
  it('is informational: the answer never carries an authorization token', () => {
    expect(JSON.stringify(evaluateAppealAdjudicator(facts))).not.toMatch(/token|grant/i);
  });
  it('rejects malformed facts instead of allowing', () => {
    expect(() => evaluateAppealAdjudicator({ ...facts, version: 'v2' } as never)).toThrow();
    expect(() => evaluateAppealAdjudicator({ ...facts, onAllowlist: 'yes' } as never)).toThrow();
  });
});
describe('provisional 14-day windows', () => {
  it('defaults to 14 days for filing and for the adjudication target', () => {
    expect(DEFAULT_APPEAL_FILING_WINDOW_SECONDS).toBe(14 * 86400);
    expect(DEFAULT_APPEAL_ADJUDICATION_SECONDS).toBe(14 * 86400);
  });
  it('keeps the filing window open through its last instant and closes it after', () => {
    const decided = '2026-11-01T00:00:00.000Z';
    const w = 14 * 86400;
    expect(appealFilingWindowOpen(decided, '2026-11-15T00:00:00.000Z', w)).toBe(true);
    expect(appealFilingWindowOpen(decided, '2026-11-15T00:00:00.001Z', w)).toBe(false);
    expect(appealFilingWindowOpen(decided, '2026-10-31T23:59:59.999Z', w)).toBe(false);
  });
});
