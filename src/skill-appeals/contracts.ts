import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import {
  SkillAssessmentAppealReasonCategorySchema,
  SkillAssessmentAppealRequestSchema,
} from '../skills/assessment-review-contracts';
import { SkillVersionReferenceSchema } from '../skills/contracts';

/** Intake reuses the accepted strict request (closed reason categories, no free-form OTHER, exact version). */
export const FileSkillAssessmentAppealInputSchema = SkillAssessmentAppealRequestSchema;
export const AdjudicateSkillAssessmentAppealInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    appealId: z.uuid(),
    outcome: z.enum(['UPHELD', 'DENIED']),
    reason: z.string().trim().min(1).max(2000),
  })
  .readonly();
export type AdjudicateSkillAssessmentAppealInput = z.output<
  typeof AdjudicateSkillAssessmentAppealInputSchema
>;

const Timestamp = UtcTimestamp.refine((value) => {
  const fraction = value.match(/\.(\d+)Z$/)?.[1];
  return !fraction || fraction.length <= 3;
});
/**
 * What either party receives. It never carries the statement, an account id, the evaluators, the adjudicator or the
 * excluded-reviewer list, and it is not an authorization token: an upheld appeal only says a fresh review is required.
 */
export const SkillAssessmentAppealViewSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    assessmentReference: SkillVersionReferenceSchema,
    skillId: InternalId,
    reasonCategory: SkillAssessmentAppealReasonCategorySchema,
    state: z.enum(['PENDING', 'UPHELD', 'DENIED']),
    filedAt: Timestamp,
    adjudicationDueAt: Timestamp,
    decidedAt: Timestamp.nullable(),
    freshReview: z
      .strictObject({ required: z.boolean(), excludesOriginalReviewers: z.boolean() })
      .readonly(),
    changesAssessment: z.literal(false),
    grantsRank: z.literal(false),
    isAuthorizationToken: z.literal(false),
  })
  .refine(
    (v) =>
      (v.state === 'PENDING') === (v.decidedAt === null) &&
      v.freshReview.required === (v.state === 'UPHELD') &&
      v.freshReview.excludesOriginalReviewers === v.freshReview.required,
  )
  .readonly();
export type SkillAssessmentAppealView = z.output<typeof SkillAssessmentAppealViewSchema>;
export const SkillAssessmentAppealResultSchema = z
  .strictObject({
    status: z.enum(['EXECUTED', 'REPLAYED']),
    appeal: SkillAssessmentAppealViewSchema,
  })
  .readonly();
export type SkillAssessmentAppealResult = z.output<typeof SkillAssessmentAppealResultSchema>;

export const SkillAppealActorSchema = z
  .strictObject({ accountId: InternalId, sessionHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .readonly();
export type SkillAppealActor = z.output<typeof SkillAppealActorSchema>;
export interface SkillAppealCommand {
  readonly actor: SkillAppealActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export interface FileSkillAssessmentAppealOptions {
  /** New filings only; an original receipt still replays when this is false. */
  readonly allowNewWrites: boolean;
  /** Provisional (DEC-2026-11-14-11): days after the decision within which an appeal may be filed. */
  readonly filingWindowSeconds: number;
  /** Provisional: target seconds from filing to decision; overdue appeals stay pending and are reported, never decided. */
  readonly adjudicationSeconds: number;
}
export interface AdjudicateSkillAssessmentAppealOptions {
  readonly allowNewWrites: boolean;
  /** Current dedicated allowlist answer (`SKILL_APPEAL_REVIEWER_ACCOUNT_IDS`); re-evaluated under the locks. */
  readonly isAdjudicator: (accountId: string) => boolean;
}
export interface OverdueSkillAssessmentAppeal {
  readonly appealId: string;
  readonly adjudicationDueAt: string;
  readonly overdueSeconds: number;
}

export class SkillAppealError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'SELF_ADJUDICATION'
      | 'ORIGINAL_REVIEWER'
      | 'GUILD_RELATIONSHIP'
      | 'NOT_FOUND'
      | 'REVISION_CHANGED'
      | 'WINDOW_CLOSED'
      | 'APPEAL_EXISTS'
      | 'ALREADY_DECIDED'
      | 'WRITES_DISABLED'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'SkillAppealError';
  }
}
