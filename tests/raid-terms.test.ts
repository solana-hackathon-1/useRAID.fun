import { describe, expect, it } from 'vitest';
import { RaidTermsSchema, publicationProblems } from '../src/work-loop/terms';

import { raidTerms as terms } from './helpers/raid-terms-fixture';

describe('T016 versioned publication terms', () => {
  it('accepts a complete prospective contract without inventing an accepted roster', () => {
    expect(RaidTermsSchema.safeParse(terms()).success).toBe(true);
  });
  it.each([
    'outcome',
    'acceptanceCriteria',
    'difficulty',
    'requiredSkills',
    'rightsPolicy',
    'disputePolicy',
    'deadlines',
    'fees',
  ])('rejects missing publication field %s', (field) => {
    const input = { ...terms() } as Record<string, unknown>;
    delete input[field];
    expect(RaidTermsSchema.safeParse(input).success).toBe(false);
  });
  it('rejects floating, zero and overflowing base-unit rewards', () => {
    for (const amount of ['1.5', '0', '18446744073709551616']) {
      const input = terms();
      input.rewards[0].amount = amount;
      expect(RaidTermsSchema.safeParse(input).success).toBe(false);
    }
  });
  it('rejects empty criteria, unknown fields and non-finite or unordered deadlines', () => {
    expect(RaidTermsSchema.safeParse({ ...terms(), acceptanceCriteria: [] }).success).toBe(false);
    expect(RaidTermsSchema.safeParse({ ...terms(), adminApproved: true }).success).toBe(false);
    expect(
      RaidTermsSchema.safeParse({
        ...terms(),
        deadlines: { ...terms().deadlines, review: terms().deadlines.commitment },
      }).success,
    ).toBe(false);
  });
  it('keeps confidential and high-rank work behind approval and unsupported modes closed', () => {
    const now = new Date('2026-10-26T00:00:00.000Z');
    expect(publicationProblems(terms(), now)).toEqual([]);
    expect(publicationProblems({ ...terms(), difficulty: 'B' }, now)).toContain(
      'APPROVAL_REQUIRED',
    );
    expect(
      publicationProblems(
        { ...terms(), visibility: 'CONFIDENTIAL_LISTING', admission: 'APPLICATION' },
        now,
      ),
    ).toContain('UNSUPPORTED_MODE');
    expect(publicationProblems({ ...terms(), settlementMechanism: 'LIVE' }, now)).toContain(
      'INVALID_TERMS',
    );
  });
  it('requires commitment and finite operational windows still in the future at publication', () => {
    expect(publicationProblems(terms(), new Date(terms().deadlines.commitment))).toContain(
      'DEADLINE_PASSED',
    );
  });
});
