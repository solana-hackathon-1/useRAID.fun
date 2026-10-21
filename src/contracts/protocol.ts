import { z } from 'zod';
import { AccountId, GuildId, TermsVersionId, InternalId, Revision, UtcTimestamp } from './ids';
export const API_VERSION = 'v1' as const;
export const API_BASE_PATH = '/api/v1' as const;
// Metadata is never a replacement for server-resolved identity or permission.
export const GuildWorkCommandContextSchema = z.strictObject({
  actorId: AccountId,
  guildId: GuildId,
  requestId: InternalId,
  idempotencyKey: InternalId,
  expectedRevision: Revision,
  expectedTermsVersion: TermsVersionId,
});
// Compatibility name within this initial change; this is explicitly Guild-work scope.
export const CommandContextSchema = GuildWorkCommandContextSchema;
export type CommandContext = z.infer<typeof CommandContextSchema>;
/** Minimal identifier-only event references. Feature schemas extend via reviewed versions. */
export const EventEnvelopeSchema = z
  .strictObject({
    eventId: InternalId,
    type: z
      .string()
      .regex(
        /^(identity|guild|skill|launch|work|treasury|access|challenge|execution)\.[a-z][a-z_]*\.v1$/,
      ),
    aggregateId: InternalId,
    aggregateVersion: Revision,
    occurredAt: UtcTimestamp,
    actorId: AccountId,
    guildId: GuildId.nullable(),
    correlationId: InternalId,
    payload: z
      .strictObject({
        termsVersionId: TermsVersionId.optional(),
        submissionId: InternalId.optional(),
        operationId: InternalId.optional(),
        claimId: InternalId.optional(),
        identityLinkId: InternalId.optional(),
        orientationVersionId: InternalId.optional(),
        guildDraftVersionId: InternalId.optional(),
        projectProposalVersionId: InternalId.optional(),
        skillTaxonomyVersionId: InternalId.optional(),
        skillClaimVersionId: InternalId.optional(),
        practiceTrialVersionId: InternalId.optional(),
        practiceTrialStartId: InternalId.optional(),
        practiceTrialSubmissionId: InternalId.optional(),
        practiceReviewAssignmentId: InternalId.optional(),
        practiceReviewRevocationId: InternalId.optional(),
        practiceReviewPolicyVersionId: InternalId.optional(),
        practiceTrialOwnershipVersionId: InternalId.optional(),
        practiceAssessmentReviewVersionId: InternalId.optional(),
        practiceAssessmentDecisionId: InternalId.optional(),
        skillAssessmentVersionId: InternalId.optional(),
      })
      .readonly(),
  })
  .readonly();
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export const ERROR_CONTRACT = {
  INVALID_COMMAND: [422, 'Invalid command.', false],
  AUTHENTICATION_REQUIRED: [401, 'Sign in to continue.', false],
  FORBIDDEN: [403, 'This action is not permitted.', false],
  NOT_FOUND: [404, 'Not found.', false],
  REVISION_CHANGED: [409, 'Refresh the current record before continuing.', false],
  DRAFT_SLUG_UNAVAILABLE: [409, 'That draft URL is unavailable. Choose another.', false],
  MISSING_VERIFIED_SKILL: [403, 'Relevant verified skill is required.', false],
  MINIMUM_RANK_NOT_MET: [403, 'The required skill rank is not met.', false],
  APPROVAL_REQUIRED: [403, 'Approval is required.', false],
  CAPACITY_CONFLICT: [409, 'You already have an active Raid.', false],
  OPERATOR_CAPACITY_CONFLICT: [409, 'The operator has reached its active work limit.', false],
  SLOT_FILLED: [409, 'This slot is no longer available.', false],
  OFFER_EXPIRED: [409, 'This offer has expired.', false],
  TERMS_VERSION_CHANGED: [409, 'Review the current terms before accepting.', false],
  FUNDING_NOT_VERIFIED: [409, 'Reward funding has not been verified.', false],
  BINDING_PENDING: [409, 'Work binding is still pending.', false],
  UNSUPPORTED_ASSET: [422, 'This asset is not supported.', false],
  ASSET_POLICY_CHANGED: [409, 'Review the current asset policy before continuing.', false],
  ACCESS_NOT_GRANTED: [403, 'Resource access has not been granted.', false],
  ACCESS_EXPIRED: [403, 'Resource access has expired.', false],
  ACCOUNT_RESTRICTED: [403, 'This action is restricted for this account.', false],
  BUDGET_EXHAUSTED: [409, 'The approved budget is exhausted.', false],
  PAYMENT_STATUS_UNKNOWN: [
    503,
    'Payment status needs reconciliation before another attempt.',
    false,
  ],
  IDEMPOTENCY_KEY_REUSED: [
    409,
    'This request key was already used for a different command.',
    false,
  ],
  PRACTICE_ATTEMPT_LIMIT_REACHED: [409, 'The published attempt limit has been reached.', false],
  PRACTICE_COOLDOWN_ACTIVE: [409, 'The published retry waiting period is still active.', false],
  PRACTICE_ALREADY_SUBMITTED: [
    409,
    'This attempt already has a saved submission. Refresh to view it.',
    false,
  ],
  PRACTICE_ACCOMMODATION_UNAVAILABLE: [422, 'The requested accommodation is unavailable.', false],
  FAMILY_CHANGED: [409, 'Refresh the current skill catalog before continuing.', false],
  EVIDENCE_NOT_CONFIRMED: [422, 'Current confirmed ownership evidence is required.', false],
  RUBRIC_NOT_MET: [422, 'The required rubric criteria have not been met.', false],
  HIGH_RANK_EVIDENCE_REQUIRED: [422, 'This rank requires additional independent evidence.', false],
  AUTOMATED_EVIDENCE_UNAVAILABLE: [
    503,
    'The required automated evidence source is unavailable.',
    true,
  ],
  TOOLS_POLICY_NOT_MET: [422, 'The submission does not meet its accepted tools policy.', false],
  CURRENT_HIGHER_ASSESSMENT: [
    409,
    'Use a reasoned reassessment for the current higher rank.',
    false,
  ],
  RATE_LIMITED: [429, 'Too many requests. Try again later.', true],
  SERVICE_UNAVAILABLE: [503, 'Service unavailable. Please try again.', true],
} as const;
export type ErrorCode = keyof typeof ERROR_CONTRACT;
export const ErrorCodeSchema = z.enum(Object.keys(ERROR_CONTRACT) as [ErrorCode, ...ErrorCode[]]);
export function createErrorEnvelope(code: ErrorCode, requestId: string) {
  ErrorCodeSchema.parse(code);
  InternalId.parse(requestId);
  const [status, message, retryable] = ERROR_CONTRACT[code];
  return { status, body: { error: { code, message, retryable, requestId } } };
}
