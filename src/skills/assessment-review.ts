import { z } from 'zod';
import {
  SkillAssessmentReviewContextSchema,
  SkillAssessmentReviewInputSchema,
  SkillAssessmentReassessmentContextSchema,
  SkillAssessmentReassessmentInputSchema,
  SkillAssessmentReviewPolicySchema,
  SkillAssessmentReviewContractError,
  type SkillAssessmentReviewContext,
  type SkillAssessmentReassessmentContext,
} from './assessment-review-contracts';

function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  code: 'INVALID_INPUT' | 'INVALID_HOST_CONTRACT',
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new SkillAssessmentReviewContractError(code);
  return result.data;
}
function approved(check: () => boolean) {
  try {
    return check() === true;
  } catch {
    throw new SkillAssessmentReviewContractError('HOST_POLICY_UNAVAILABLE');
  }
}
function same(
  a: { recordId: string; revision: number } | null,
  b: { recordId: string; revision: number } | null,
) {
  return a === null || b === null
    ? a === b
    : a.recordId === b.recordId && a.revision === b.revision;
}
function current(fact: { observedAt: string; validUntil: string }, now: string) {
  return (
    Date.parse(fact.observedAt) <= Date.parse(now) && Date.parse(now) < Date.parse(fact.validUntil)
  );
}
type CommonContext = SkillAssessmentReviewContext | SkillAssessmentReassessmentContext;
function actor(context: CommonContext) {
  if (!context.actorAccountId || !context.actorSessionAuthorized)
    throw new SkillAssessmentReviewContractError('AUTHENTICATION_REQUIRED');
  if (context.actorRestricted) throw new SkillAssessmentReviewContractError('ACCOUNT_RESTRICTED');
  if (context.subject.kind !== 'HUMAN')
    throw new SkillAssessmentReviewContractError('RESOURCE_UNAVAILABLE');
  if (context.subject.accountId === context.actorAccountId)
    throw new SkillAssessmentReviewContractError('SELF_REVIEW_FORBIDDEN');
  return context.actorAccountId;
}
function assessment(
  context: CommonContext,
  expected: { recordId: string; revision: number } | null,
  skillId: string,
) {
  if (Date.parse(context.taxonomy.publishedAt) > Date.parse(context.now))
    throw new SkillAssessmentReviewContractError('INVALID_HOST_CONTRACT');
  const observation = context.assessmentObservation;
  if (
    observation.status !== 'CURRENT' ||
    observation.participantId !== context.subject.id ||
    observation.skillId !== skillId ||
    !current(observation, context.now)
  )
    throw new SkillAssessmentReviewContractError('ASSESSMENT_UNAVAILABLE');
  const record = observation.record;
  const skill = context.taxonomy.skills.find((item) => item.id === skillId);
  if (!skill) throw new SkillAssessmentReviewContractError('INVALID_HOST_CONTRACT');
  if (
    record &&
    (record.reference.recordId !== context.assessmentRecordId ||
      record.participantId !== context.subject.id ||
      record.skillId !== skillId ||
      record.skillDomain !== skill.domain ||
      Date.parse(record.issuedAt) > Date.parse(observation.observedAt) ||
      (record.reassessmentAt !== null &&
        Date.parse(record.reassessmentAt) < Date.parse(record.issuedAt)))
  )
    throw new SkillAssessmentReviewContractError('INVALID_HOST_CONTRACT');
  if (!same(record?.reference ?? null, expected))
    throw new SkillAssessmentReviewContractError('REVISION_CHANGED');
  return { record, skill };
}
const noEffects = Object.freeze({
  persisted: false as const,
  verifiesSkill: false as const,
  isAuthorizationToken: false as const,
  createsPermissionGrant: false as const,
  consumesCapacity: false as const,
  createsFinancialObligation: false as const,
});
function nextRevision(revision: number) {
  if (revision >= Number.MAX_SAFE_INTEGER)
    throw new SkillAssessmentReviewContractError('REVISION_EXHAUSTED');
  return revision + 1;
}
/** Private proposal, including nested assessment data; never a committed VERIFIED fact. */
export function prepareSkillAssessmentReview(
  contextValue: unknown,
  inputValue: unknown,
  policyValue: unknown,
) {
  const context = parse(SkillAssessmentReviewContextSchema, contextValue, 'INVALID_HOST_CONTRACT');
  const input = parse(SkillAssessmentReviewInputSchema, inputValue, 'INVALID_INPUT');
  const policy = parse(SkillAssessmentReviewPolicySchema, policyValue, 'INVALID_HOST_CONTRACT');
  const evaluatorAccountId = actor(context);
  if (!approved(() => policy.canPrepareReview(context, input)))
    throw new SkillAssessmentReviewContractError('FORBIDDEN');
  const { definition, submission, now } = context;
  if (!approved(() => policy.isApprovedDefinition(definition, now)))
    throw new SkillAssessmentReviewContractError('DEFINITION_UNAVAILABLE');
  if (
    !same(input.expectedDefinitionReference, definition.reference) ||
    !same(input.expectedRubricReference, definition.rubric.reference) ||
    !same(input.expectedSubmissionReference, submission.reference)
  )
    throw new SkillAssessmentReviewContractError('REVISION_CHANGED');
  const { record, skill } = assessment(
    context,
    input.expectedAssessmentReference,
    definition.skillId,
  );
  if (
    skill.domain !== definition.skillDomain ||
    Date.parse(definition.publishedAt) > Date.parse(submission.submittedAt) ||
    Date.parse(submission.submittedAt) > Date.parse(submission.observedAt)
  )
    throw new SkillAssessmentReviewContractError('INVALID_HOST_CONTRACT');
  if (
    submission.participantId !== context.subject.id ||
    !same(submission.definitionReference, definition.reference) ||
    !current(submission, now)
  )
    throw new SkillAssessmentReviewContractError('SUBMISSION_UNAVAILABLE');
  const criteria = new Map(input.criteria.map((item) => [item.criterionId, item]));
  if (
    criteria.size !== definition.rubric.criteria.length ||
    definition.rubric.criteria.some((item) => !criteria.has(item.id))
  )
    throw new SkillAssessmentReviewContractError('INVALID_INPUT');
  if (input.reassessmentAt !== null && Date.parse(input.reassessmentAt) <= Date.parse(now))
    throw new SkillAssessmentReviewContractError('INVALID_INPUT');
  if (input.decision === 'VERIFY') {
    if (submission.ownership !== 'CONFIRMED')
      throw new SkillAssessmentReviewContractError('EVIDENCE_NOT_CONFIRMED');
    if (
      definition.rubric.criteria.some(
        (item) => item.required && criteria.get(item.id)?.result !== 'MET',
      )
    )
      throw new SkillAssessmentReviewContractError('RUBRIC_NOT_MET');
  }
  const proposedAssessment =
    input.decision !== 'VERIFY'
      ? null
      : Object.freeze({
          version: 'v1' as const,
          state: 'PROPOSED' as const,
          proposedState: 'VERIFIED' as const,
          reference: Object.freeze({
            recordId: context.assessmentRecordId,
            revision: nextRevision(record?.reference.revision ?? 0),
          }),
          participantId: context.subject.id,
          skillId: definition.skillId,
          skillDomain: definition.skillDomain,
          proposedRank: definition.targetRank,
          definitionReference: definition.reference,
          rubricReference: definition.rubric.reference,
          submissionReference: submission.reference,
          evidenceReferences: submission.evidenceReferences,
          assessmentPolicyVersion: context.assessmentPolicyVersion,
          evaluatorAccountId,
          preparedAt: new Date(now).toISOString(),
          proposedReassessmentAt: input.reassessmentAt,
          confidenceStatement: input.confidenceStatement,
          sampleSize: submission.sampleSize,
          ...noEffects,
        });
  return Object.freeze({
    version: 'v1' as const,
    state: 'PROPOSED' as const,
    decision: input.decision,
    participantId: context.subject.id,
    evaluatorAccountId,
    definitionReference: definition.reference,
    rubricReference: definition.rubric.reference,
    submissionReference: submission.reference,
    previousAssessmentReference: record?.reference ?? null,
    criteria: input.criteria,
    reason: input.reason,
    confidenceStatement: input.confidenceStatement,
    preparedAt: new Date(now).toISOString(),
    proposedAssessment,
    ...noEffects,
  });
}
/** Reasoned capability/fraud proposal only; old record/history and eligibility remain unchanged. */
export function prepareSkillAssessmentReassessment(
  contextValue: unknown,
  inputValue: unknown,
  policyValue: unknown,
) {
  const context = parse(
    SkillAssessmentReassessmentContextSchema,
    contextValue,
    'INVALID_HOST_CONTRACT',
  );
  const input = parse(SkillAssessmentReassessmentInputSchema, inputValue, 'INVALID_INPUT');
  const policy = parse(SkillAssessmentReviewPolicySchema, policyValue, 'INVALID_HOST_CONTRACT');
  const evaluatorAccountId = actor(context);
  if (!approved(() => policy.canPrepareReassessment(context, input)))
    throw new SkillAssessmentReviewContractError('FORBIDDEN');
  const observation = context.assessmentObservation;
  if (observation.status !== 'CURRENT' || observation.record === null)
    throw new SkillAssessmentReviewContractError('ASSESSMENT_UNAVAILABLE');
  const { record } = assessment(context, input.expectedAssessmentReference, observation.skillId);
  if (!record) throw new SkillAssessmentReviewContractError('ASSESSMENT_UNAVAILABLE');
  if (record.state === 'REVOKED') throw new SkillAssessmentReviewContractError('STATE_CONFLICT');
  const evidence = context.caseEvidence;
  if (
    evidence.status !== 'CURRENT' ||
    evidence.participantId !== context.subject.id ||
    !same(evidence.assessmentReference, record.reference) ||
    !current(evidence, context.now)
  )
    throw new SkillAssessmentReviewContractError('CASE_EVIDENCE_UNAVAILABLE');
  if (input.action === 'REQUIRE_REASSESSMENT' && Date.parse(input.dueAt) <= Date.parse(context.now))
    throw new SkillAssessmentReviewContractError('INVALID_INPUT');
  return Object.freeze({
    version: 'v1' as const,
    state: 'PROPOSED' as const,
    action: input.action,
    proposedState:
      input.action === 'REVOKE' ? ('REVOKED' as const) : ('REASSESSMENT_REQUIRED' as const),
    participantId: context.subject.id,
    evaluatorAccountId,
    previousAssessmentReference: record.reference,
    previousAssessedRank: record.assessedRank,
    proposedRevision: nextRevision(record.reference.revision),
    assessmentPolicyVersion: context.assessmentPolicyVersion,
    evidenceReferences: evidence.evidenceReferences,
    reasonCategory: input.reasonCategory,
    reason: input.reason,
    dueAt: input.action === 'REQUIRE_REASSESSMENT' ? input.dueAt : null,
    preparedAt: new Date(context.now).toISOString(),
    ...noEffects,
  });
}
