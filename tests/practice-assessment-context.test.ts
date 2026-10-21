import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  read: vi.fn(),
  policy: vi.fn(),
  ownership: vi.fn(),
  observe: vi.fn(),
  assessment: vi.fn(),
  state: vi.fn(),
  grant: vi.fn(),
}));
vi.mock('../src/skills/practice-review-read-storage', async (original) => ({
  ...(await original<object>()),
  readPracticeTrialForReview: ports.read,
}));
vi.mock('../src/skills/practice-review-policy-storage', async (original) => ({
  ...(await original<object>()),
  observeApprovedPracticeReviewPolicy: ports.policy,
}));
vi.mock('../src/skills/practice-trial-ownership-storage', async (original) => ({
  ...(await original<object>()),
  readPracticeTrialOwnership: ports.ownership,
}));
vi.mock('../src/skills/practice-trial-assessment-storage', async (original) => ({
  ...(await original<object>()),
  observePracticeTrialAssessmentContext: ports.observe,
  readPracticeTrialAssessment: ports.assessment,
  readPracticeTrialAssessmentState: ports.state,
}));
vi.mock('../src/skills/practice-review-assignment-storage', async (original) => ({
  ...(await original<object>()),
  lockPracticeReviewAssignment: ports.grant,
}));
import {
  readPracticeAssessmentContext,
  PracticeAssessmentContextSchema,
} from '../src/skills/practice-assessment-context';
import { ownershipContextFixture as o } from './helpers/practice-ownership-view-fixture';
const review = {
  ...o.review,
  assignment: { ...o.review.assignment, purpose: 'ASSESSMENT_REVIEW' },
};
const policy = { ...o.policy!, policy: { ...o.policy!.policy, purpose: 'ASSESSMENT_REVIEW' } };
const scope = {
  version: 'v1',
  assignmentId: review.assignment.id,
  submissionId: review.submission.reference.recordId,
  purpose: 'ASSESSMENT_REVIEW',
};
const refs = {
  version: 'v1',
  private: true,
  assignmentId: scope.assignmentId,
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
};
const actor = { accountId: review.assignment.evaluatorAccountId, sessionHash: 'a'.repeat(64) };
beforeEach(() => {
  vi.resetAllMocks();
  ports.read.mockResolvedValue(review);
  ports.policy.mockResolvedValue(policy);
  ports.ownership.mockResolvedValue(null);
  ports.observe.mockResolvedValue(refs);
  ports.assessment.mockResolvedValue(null);
  ports.state.mockResolvedValue(null);
  ports.grant.mockResolvedValue(review.assignment);
});
const read = (enabled = () => true, input: unknown = scope) =>
  readPracticeAssessmentContext({} as never, actor, input, enabled);
it('observes actual case, approved policy, ownership, CAS refs, review and state within the supplied transaction', async () => {
  expect(await read()).toEqual({
    version: 'v1',
    review,
    policy,
    ownership: null,
    references: refs,
    assessmentReview: null,
    assessmentState: null,
  });
  expect(ports.observe).toHaveBeenCalledWith(
    {},
    actor,
    { version: 'v1', assignmentId: scope.assignmentId, submissionId: scope.submissionId },
    expect.any(Function),
  );
  expect(ports.policy.mock.invocationCallOrder[0]).toBeLessThan(
    ports.observe.mock.invocationCallOrder[0],
  );
  expect(ports.grant.mock.invocationCallOrder[0]).toBeGreaterThan(
    ports.state.mock.invocationCallOrder[0],
  );
});
it('stops at absent case without other private reads', async () => {
  ports.read.mockResolvedValue(null);
  expect(await read()).toBeNull();
  expect(ports.policy).not.toHaveBeenCalled();
});
it('preserves missing approved policy for read-only display', async () => {
  ports.policy.mockResolvedValue(null);
  expect(await read()).toMatchObject({ policy: null });
});
it('drops bytes when final grant expires or references cannot be observed', async () => {
  ports.grant.mockResolvedValue(null);
  expect(await read()).toBeNull();
  ports.grant.mockResolvedValue(review.assignment);
  ports.observe.mockResolvedValue(null);
  expect(await read()).toBeNull();
});
it('drops bytes when reads close after awaited private selection', async () => {
  let enabled = true;
  ports.state.mockImplementation(() => {
    enabled = false;
    return null;
  });
  expect(await read(() => enabled)).toBeNull();
});
it('passes exact final assignment fields and rejects ownership-purpose input', async () => {
  ports.grant.mockImplementation((_tx, _a, input) => {
    expect(input).toEqual({
      assignmentId: scope.assignmentId,
      submissionId: scope.submissionId,
      purpose: 'ASSESSMENT_REVIEW',
    });
    return review.assignment;
  });
  expect(await read()).not.toBeNull();
  await expect(read(() => true, { ...scope, purpose: 'OWNERSHIP_REVIEW' })).rejects.toThrow();
});
it.each([
  'participantId',
  'skillId',
  'definitionReference',
  'submissionReference',
  'currentReviewReference',
])('rejects incoherent observed %s', async (key) => {
  ports.observe.mockResolvedValue({
    ...refs,
    [key]: key.endsWith('Reference') ? { recordId: crypto.randomUUID(), revision: 1 } : 'foreign',
  });
  await expect(read()).rejects.toThrow('STORAGE_CONTRACT');
});
it('rejects foreign evaluator/policy and unknown context fields', async () => {
  ports.read.mockResolvedValue({
    ...review,
    assignment: { ...review.assignment, evaluatorAccountId: 'foreign' },
  });
  await expect(read()).rejects.toThrow('STORAGE_CONTRACT');
  expect(
    PracticeAssessmentContextSchema.safeParse({
      version: 'v1',
      review,
      policy,
      ownership: null,
      references: refs,
      assessmentReview: null,
      assessmentState: null,
      secret: 'bad',
    }).success,
  ).toBe(false);
});
