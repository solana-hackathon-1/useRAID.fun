import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import { SkillRankSchema } from '../contracts/entities';
import { SkillVersionReferenceSchema } from './contracts';
const Ref = SkillVersionReferenceSchema.unwrap()
  .extend({ revision: z.number().int().min(1).max(2147483647) })
  .readonly();
export const OwnSkillAssessmentInputSchema = z
  .strictObject({ version: z.literal('v1'), taxonomyId: InternalId, skillId: InternalId })
  .readonly();
/** Owned summary only. No private submission, evaluator notes or internal eligibility observation. */
export const OwnSkillAssessmentViewSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    skillId: InternalId,
    skillDomain: InternalId,
    skillName: z.string().min(1).max(200),
    taxonomyReference: Ref,
    assessmentReference: Ref.nullable(),
    recordedState: z.enum(['VERIFIED', 'REASSESSMENT_REQUIRED', 'REVOKED']).nullable(),
    effectiveStatus: z.enum(['NO_ASSESSMENT', 'VERIFIED', 'REASSESSMENT_REQUIRED', 'REVOKED']),
    assessedRank: SkillRankSchema.nullable(),
    issuedAt: UtcTimestamp.nullable(),
    reassessmentAt: UtcTimestamp.nullable(),
    reasonCategory: z.enum(['CAPABILITY_RECHECK', 'FRAUDULENT_ASSESSMENT_EVIDENCE']).nullable(),
    observedAt: UtcTimestamp,
    informational: z.literal(true),
    isAuthorizationToken: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .refine((v) => {
    if (v.recordedState === null)
      return (
        v.effectiveStatus === 'NO_ASSESSMENT' &&
        v.assessmentReference === null &&
        v.assessedRank === null &&
        v.issuedAt === null &&
        v.reassessmentAt === null &&
        v.reasonCategory === null
      );
    if (
      !v.assessmentReference ||
      !v.assessedRank ||
      !v.issuedAt ||
      Date.parse(v.issuedAt) > Date.parse(v.observedAt) ||
      (v.reassessmentAt !== null && Date.parse(v.reassessmentAt) <= Date.parse(v.issuedAt))
    )
      return false;
    const effective =
      v.recordedState === 'VERIFIED' &&
      v.reassessmentAt !== null &&
      Date.parse(v.reassessmentAt) <= Date.parse(v.observedAt)
        ? 'REASSESSMENT_REQUIRED'
        : v.recordedState;
    return (
      v.effectiveStatus === effective &&
      (v.recordedState !== 'REVOKED' ||
        (v.reasonCategory === 'FRAUDULENT_ASSESSMENT_EVIDENCE' && v.reassessmentAt === null)) &&
      (v.recordedState !== 'REASSESSMENT_REQUIRED' || v.reasonCategory === 'CAPABILITY_RECHECK') &&
      (v.recordedState !== 'VERIFIED' || v.reasonCategory === null)
    );
  })
  .readonly();
export type OwnSkillAssessmentView = z.output<typeof OwnSkillAssessmentViewSchema>;
export const OwnSkillAssessmentHttpStateSchema = z
  .strictObject({
    version: z.literal('v1'),
    view: OwnSkillAssessmentViewSchema.nullable(),
    readsAvailable: z.boolean(),
    unavailableReason: z.enum(['DISABLED', 'MISCONFIGURED']).nullable(),
  })
  .refine(
    (v) =>
      v.readsAvailable === (v.unavailableReason === null) && (v.readsAvailable || v.view === null),
  )
  .readonly();
export type OwnSkillAssessmentHttpState = z.output<typeof OwnSkillAssessmentHttpStateSchema>;
export interface OwnSkillAssessmentScope {
  readonly accountId: string;
  readonly participantId: string;
  readonly taxonomyId: string;
  readonly skillId: string;
}
export class OwnSkillAssessmentError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'RESOURCE_UNAVAILABLE'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'OwnSkillAssessmentError';
  }
}
