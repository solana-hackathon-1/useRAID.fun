import { ownershipContextFixture as o } from './practice-ownership-view-fixture';
import { PracticeAssessmentContextSchema } from '../../src/skills/practice-assessment-context';
const review = {
  ...o.review,
  assignment: { ...o.review.assignment, purpose: 'ASSESSMENT_REVIEW' },
};
export const assessmentContextFixture = {
  ...PracticeAssessmentContextSchema.parse({
    version: 'v1',
    review,
    policy: { ...o.policy, policy: { ...o.policy!.policy, purpose: 'ASSESSMENT_REVIEW' } },
    ownership: null,
    references: {
      version: 'v1',
      private: true,
      assignmentId: review.assignment.id,
      participantId: review.submission.participantId,
      submissionReference: review.submission.reference,
      definitionReference: review.definition.reference,
      rubricReference: review.definition.rubric.reference,
      taxonomyReference: { recordId: 'catalog', revision: 1 },
      skillId: review.definition.skillId,
      skillDomain: review.definition.skillDomain,
      targetRank: review.definition.targetRank,
      evaluatorMethod: review.definition.evaluatorMethod,
      currentOwnershipReference: null,
      currentReviewReference: null,
      currentAssessmentReference: null,
      accessId: crypto.randomUUID(),
      verifiesSkill: false,
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    },
    assessmentReview: null,
    assessmentState: null,
  }),
  reviewWritesAvailable: true,
  decisionWritesAvailable: true,
};
