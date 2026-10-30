import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_APPEAL_REASON_CATEGORIES,
  SkillAssessmentAppealReasonCategorySchema,
  SkillAssessmentAppealRequestSchema,
} from '../src/skills/assessment-review-contracts';

const reference = { recordId: 'assessment-1', revision: 2 };
const request = (extra: Record<string, unknown> = {}) => ({
  version: 'v1',
  expectedAssessmentReference: reference,
  reasonCategory: 'FACTUAL_ERROR',
  statement: 'The cited sample was not mine to begin with.',
  ...extra,
});

describe('T014 appeal reason categories on assessment decisions (09.7, closed list)', () => {
  it('is a closed, documented list; adding a category is an owner decision', () => {
    expect([...ASSESSMENT_APPEAL_REASON_CATEGORIES]).toEqual([
      'FACTUAL_ERROR',
      'RUBRIC_MISAPPLIED',
      'NEW_EVIDENCE',
      'CONFLICT_OF_INTEREST',
      'OWNERSHIP_DISPUTE',
      'PROCESS_IRREGULARITY',
      'SIGNAL_MISINTERPRETED',
    ]);
    expect(Object.isFrozen(ASSESSMENT_APPEAL_REASON_CATEGORIES)).toBe(true);
  });
  it('accepts every listed category and nothing else', () => {
    for (const category of ASSESSMENT_APPEAL_REASON_CATEGORIES)
      expect(SkillAssessmentAppealReasonCategorySchema.safeParse(category).success).toBe(true);
    for (const bad of ['OTHER', 'factual_error', 'FRAUD', '', 'CAPABILITY_RECHECK', 7, null])
      expect(SkillAssessmentAppealReasonCategorySchema.safeParse(bad).success, String(bad)).toBe(
        false,
      );
  });
  it('parses a strict request bound to the exact decided assessment version', () => {
    const parsed = SkillAssessmentAppealRequestSchema.parse(request());
    expect(parsed).toMatchObject({
      reasonCategory: 'FACTUAL_ERROR',
      expectedAssessmentReference: reference,
    });
    for (const category of ASSESSMENT_APPEAL_REASON_CATEGORIES)
      expect(
        SkillAssessmentAppealRequestSchema.safeParse(request({ reasonCategory: category })).success,
      ).toBe(true);
    expect(
      SkillAssessmentAppealRequestSchema.safeParse(request({ reasonCategory: 'OTHER' })).success,
    ).toBe(false);
  });
  it('cannot carry an outcome, rank, score, actor or permission (an appeal request changes nothing)', () => {
    for (const field of [
      'outcome',
      'assessedRank',
      'score',
      'accountId',
      'participantId',
      'grant',
      'state',
    ])
      expect(
        SkillAssessmentAppealRequestSchema.safeParse(request({ [field]: 'x' })).success,
        field,
      ).toBe(false);
  });
  it('requires a bounded non-empty statement and an assessment reference', () => {
    expect(
      SkillAssessmentAppealRequestSchema.safeParse(request({ statement: '   ' })).success,
    ).toBe(false);
    expect(
      SkillAssessmentAppealRequestSchema.safeParse(request({ statement: 'x'.repeat(2001) }))
        .success,
    ).toBe(false);
    expect(
      SkillAssessmentAppealRequestSchema.safeParse(
        request({ expectedAssessmentReference: undefined }),
      ).success,
    ).toBe(false);
  });
});
