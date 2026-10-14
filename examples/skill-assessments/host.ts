import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  prepareSkillAssessmentReview,
  prepareSkillAssessmentReassessment,
} from './skills/assessment-review';
import { PracticeTrialDefinitionSchema } from './skills/practice-trial-contracts';
import { type SkillAssessmentReviewPolicy } from './skills/assessment-review-contracts';
import {
  definition,
  reviewContext,
  reviewInput,
  reassessmentContext,
  reassessmentInput,
  assessmentReference,
  until,
} from './fixtures';

// Synthetic local current scoped grant; actual hosts must resolve their real authority and records.
const grant = Object.freeze({
  evaluatorAccountId: 'synthetic-reviewer',
  participantId: 'synthetic-alice-participant',
  assessmentPolicyVersion: 'synthetic-policy-current',
  validUntil: until,
});
const approvedDefinition = PracticeTrialDefinitionSchema.parse(definition);
const bytes = JSON.stringify(approvedDefinition);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const approvedDigest = digest(approvedDefinition);
function policy(checkDefinition: (value: unknown) => boolean): SkillAssessmentReviewPolicy {
  return {
    isApprovedDefinition: checkDefinition,
    canPrepareReview: (context) =>
      context.actorAccountId === grant.evaluatorAccountId &&
      context.subject.id === grant.participantId &&
      context.assessmentPolicyVersion === grant.assessmentPolicyVersion &&
      Date.parse(context.now) < Date.parse(grant.validUntil) &&
      context.submission.reference.recordId === 'synthetic-submission' &&
      context.submission.reference.revision === 4,
    canPrepareReassessment: (context) =>
      context.actorAccountId === grant.evaluatorAccountId &&
      context.subject.id === grant.participantId &&
      context.assessmentPolicyVersion === grant.assessmentPolicyVersion &&
      Date.parse(context.now) < Date.parse(grant.validUntil) &&
      context.caseEvidence.status === 'CURRENT' &&
      context.caseEvidence.assessmentReference.recordId === assessmentReference.recordId &&
      context.caseEvidence.assessmentReference.revision === assessmentReference.revision &&
      context.caseEvidence.evidenceReferences[0].recordId === 'synthetic-case-evidence',
  };
}
for (const port of [
  policy((value) => JSON.stringify(value) === bytes),
  policy((value) => digest(value) === approvedDigest),
]) {
  const ctx = reviewContext(),
    before = JSON.stringify(ctx);
  const proposal = prepareSkillAssessmentReview(ctx, reviewInput(), port);
  assert.equal(proposal.state, 'PROPOSED');
  assert.equal(proposal.proposedAssessment?.state, 'PROPOSED');
  assert.equal(proposal.proposedAssessment?.proposedRank, 'A');
  assert.equal(proposal.proposedAssessment?.verifiesSkill, false);
  assert.equal(proposal.persisted, false);
  assert.equal(proposal.createsPermissionGrant, false);
  assert.equal(proposal.consumesCapacity, false);
  assert.equal(JSON.stringify(ctx), before);
  assert.throws(
    () =>
      prepareSkillAssessmentReview(
        { ...ctx, actorAccountId: 'synthetic-alice-account' },
        reviewInput(),
        port,
      ),
    /SELF_REVIEW_FORBIDDEN/,
  );
  assert.throws(
    () =>
      prepareSkillAssessmentReview(
        { ...ctx, actorAccountId: 'unscoped-founder' },
        reviewInput(),
        port,
      ),
    /FORBIDDEN/,
  );
  assert.throws(
    () =>
      prepareSkillAssessmentReview(
        ctx,
        { ...reviewInput(), expectedRubricReference: { recordId: 'wrong', revision: 1 } },
        port,
      ),
    /REVISION_CHANGED/,
  );
  assert.throws(
    () =>
      prepareSkillAssessmentReview(
        { ...ctx, assessmentObservation: { status: 'UNAVAILABLE' } },
        reviewInput(),
        port,
      ),
    /ASSESSMENT_UNAVAILABLE/,
  );
  const reassessment = prepareSkillAssessmentReassessment(
    reassessmentContext(),
    reassessmentInput(),
    port,
  );
  assert.equal(reassessment.proposedState, 'REASSESSMENT_REQUIRED');
  assert.equal(reassessment.previousAssessedRank, 'B');
  assert.equal(reassessment.verifiesSkill, false);
  const revoked = prepareSkillAssessmentReassessment(
    reassessmentContext(),
    {
      version: 'v1',
      expectedAssessmentReference: assessmentReference,
      action: 'REVOKE',
      reasonCategory: 'FRAUDULENT_ASSESSMENT_EVIDENCE',
      reason: 'The synthetic scoped case has confirmed fraudulent assessment material.',
    },
    port,
  );
  assert.equal(revoked.proposedState, 'REVOKED');
  assert.equal(revoked.persisted, false);
}
console.log(
  JSON.stringify({
    synthetic: true,
    alternateApprovalPorts: true,
    scopedEvaluator: true,
    selfReviewDenied: true,
    immutableVersions: true,
    staleFactsDenied: true,
    reasonedReassessment: true,
    noCommittedRankOrCapacityOrMoney: true,
  }),
);
