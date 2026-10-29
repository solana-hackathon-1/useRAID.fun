import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';
import { ClaimSchema, ClosureSchema } from './closure-contracts';
import { ArtifactSchema, CriterionResultSchema } from './submission-contracts';
const title = z.string().min(1).max(200);
export const NextStepSchema = z.enum([
  'WAIT_FOR_START',
  'SUBMIT_WORK',
  'AWAIT_REVIEW',
  'REVISE_AND_RESUBMIT',
  'DISPUTE_OPEN',
  'CLOSED',
]);
const OfferViewSchema = z.strictObject({
  offerId: z.uuid(),
  state: z.enum(['PENDING', 'REVOKED', 'ACCEPTED']),
  expiresAt: UtcTimestamp,
  /** Evaluated against the database clock; a stored PENDING offer can already be unusable. */
  expired: z.boolean(),
});
/** The terms the member accepted (the effective snapshot), read-only; includes no other account's private data. */
const AcceptedTermsViewSchema = z.strictObject({
  termsVersionId: z.string(),
  revision: z.number().int(),
  scope: z.string(),
  requiredSkills: z.array(z.strictObject({ skillId: z.string(), minimumRank: z.string() })).max(50),
  roster: z.array(z.strictObject({ participantId: z.uuid(), responsibility: z.string() })).max(50),
  rewards: z
    .array(
      z.strictObject({
        policy: z.unknown(),
        amount: z.unknown(),
        beneficiaryParticipantId: z.uuid(),
      }),
    )
    .max(10),
  deadlines: z.strictObject({
    preparation: UtcTimestamp,
    submission: UtcTimestamp,
    review: UtcTimestamp,
    operationalClosure: UtcTimestamp,
  }),
});
/** Derived from persisted state: PENDING until the member starts (ACCESS_PENDING), NOT_APPLICABLE once ended unstarted. */
export const SetupStatusSchema = z.enum(['PENDING', 'READY', 'NOT_APPLICABLE']);
export const EngagementCardSchema = z.strictObject({
  engagementId: z.uuid(),
  title,
  state: z.enum([
    'ACCESS_PENDING',
    'IN_PROGRESS',
    'SUBMITTED',
    'UNDER_REVIEW',
    'REVISION_REQUESTED',
    'ACCEPTED',
    'WITHDRAWN',
    'CANCELLED',
    'TERMINATED',
  ]),
  /** True only while this engagement still holds the member's participant reservation. */
  capacityHeld: z.boolean(),
  acceptedTerms: AcceptedTermsViewSchema,
  setup: z.strictObject({ status: SetupStatusSchema, preparationDeadline: UtcTimestamp }),
  nextStep: NextStepSchema,
  deadlines: z.strictObject({
    submission: UtcTimestamp,
    review: UtcTimestamp,
    operationalClosure: UtcTimestamp,
  }),
  submissionCount: z.number().int().min(0),
  maxSubmissions: z.number().int().min(1),
  /** Original accepted criteria with the latest review's per-criterion result, if any. */
  criteria: z
    .array(
      z.strictObject({
        index: z.number().int().min(0),
        text: z.string(),
        result: CriterionResultSchema.shape.result.nullable(),
        evidence: z.string().nullable(),
      }),
    )
    .max(50),
  latestReview: z
    .strictObject({
      decision: z.enum(['ACCEPT', 'REQUEST_REVISION', 'DISPUTE']),
      reason: z.string(),
      revisionDeadline: UtcTimestamp.nullable(),
    })
    .nullable(),
  closure: ClosureSchema.nullable(),
  claims: z.array(ClaimSchema).max(10),
});
export const ApplicationCardSchema = z.strictObject({
  applicationId: z.uuid(),
  slotId: z.uuid(),
  termsVersionId: z.uuid(),
  title,
  state: z.enum(['SUBMITTED', 'WITHDRAWN', 'CLOSED']),
  offer: OfferViewSchema.nullable(),
});
export const MyRaidsSchema = z.strictObject({
  version: z.literal('v1'),
  /** R13: at most one active Raid per participant; this is the member's own slot only. */
  capacity: z.strictObject({
    limit: z.literal(1),
    held: z.boolean(),
    engagementId: z.uuid().nullable(),
    title: title.nullable(),
  }),
  engagements: z.array(EngagementCardSchema).max(50),
  applications: z.array(ApplicationCardSchema).max(50),
});
export const ReviewItemSchema = z.strictObject({
  engagementId: z.uuid(),
  submissionId: z.uuid(),
  submissionNumber: z.number().int().min(1),
  title,
  explanation: z.string(),
  artifacts: z.array(ArtifactSchema).max(20),
  dependencies: z.array(z.string()).max(50),
  aiUsage: z.string().nullable(),
  submittedAt: UtcTimestamp,
  reviewDue: UtcTimestamp,
  /** Revision requests still permitted by the accepted terms. */
  revisionsRemaining: z.number().int().min(0),
  operationalClosure: UtcTimestamp,
  criteria: z.array(z.strictObject({ index: z.number().int().min(0), text: z.string() })).max(50),
});
export const ReviewQueueSchema = z.strictObject({
  version: z.literal('v1'),
  items: z.array(ReviewItemSchema).max(50),
});
export const ApplicantQueueSchema = z.strictObject({
  version: z.literal('v1'),
  listings: z
    .array(
      z.strictObject({
        slotId: z.uuid(),
        termsVersionId: z.uuid(),
        title,
        applicants: z
          .array(
            z.strictObject({
              applicationId: z.uuid(),
              evidenceRefs: z.array(z.string()).max(10),
              state: z.literal('SUBMITTED'),
              appliedAt: UtcTimestamp,
              offer: OfferViewSchema.nullable(),
            }),
          )
          .max(100),
      }),
    )
    .max(50),
});
export type MyRaids = z.infer<typeof MyRaidsSchema>;
export type ReviewQueue = z.infer<typeof ReviewQueueSchema>;
export type ApplicantQueue = z.infer<typeof ApplicantQueueSchema>;
/** The one Raid currently holding the member's participant capacity (R13), or null; drives the site-wide indicator. */
export const ActiveRaidSchema = z
  .strictObject({ version: z.literal('v1'), engagementId: z.uuid(), title })
  .nullable();
export type ActiveRaid = z.infer<typeof ActiveRaidSchema>;
