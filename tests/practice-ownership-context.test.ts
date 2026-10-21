import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  read: vi.fn(),
  policy: vi.fn(),
  ownership: vi.fn(),
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
vi.mock('../src/skills/practice-review-assignment-storage', async (original) => ({
  ...(await original<object>()),
  lockPracticeReviewAssignment: ports.grant,
}));
import {
  readPracticeOwnershipContext,
  PracticeOwnershipContextSchema,
} from '../src/skills/practice-ownership-context';
import {
  reviewViewFixture as review,
  reviewScope as scope,
} from './helpers/practice-review-view-fixture';
const actor = { accountId: review.assignment.evaluatorAccountId, sessionHash: 'a'.repeat(64) };
const policy = {
  version: 'v1',
  private: true,
  accessId: crypto.randomUUID(),
  isAuthorizationToken: false,
  policy: {
    version: 'v1',
    id: crypto.randomUUID(),
    reference: { recordId: 'policy', revision: 1 },
    definitionReference: review.definition.reference,
    rubricReference: review.definition.rubric.reference,
    skillId: review.definition.skillId,
    skillDomain: review.definition.skillDomain,
    targetRank: review.definition.targetRank,
    purpose: 'OWNERSHIP_REVIEW',
    state: 'APPROVED',
    guidance: 'private-policy',
    publishedByAccountId: 'issuer',
    publishedAt: '2026-10-21T00:00:00.000Z',
    persisted: true,
    verifiesSkill: false,
    confirmsOwnership: false,
    createsPermissionGrant: false,
    isAuthorizationToken: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  ports.read.mockResolvedValue(review);
  ports.policy.mockResolvedValue(policy);
  ports.ownership.mockResolvedValue(null);
  ports.grant.mockResolvedValue(review.assignment);
});
const read = (enabled = () => true, input: unknown = scope) =>
  readPracticeOwnershipContext({} as never, actor, input, enabled);
it('uses canonical case, policy, finding and final current authority in the same transaction', async () => {
  expect(await read()).toEqual({ version: 'v1', review, policy, ownership: null });
  expect(ports.read).toHaveBeenCalledWith({}, actor, scope, expect.any(Function));
  expect(ports.policy).toHaveBeenCalledWith({}, actor, scope, expect.any(Function));
  expect(ports.ownership).toHaveBeenCalledWith({}, actor, scope, expect.any(Function));
  expect(ports.grant.mock.invocationCallOrder[0]).toBeGreaterThan(
    ports.ownership.mock.invocationCallOrder[0],
  );
});
it('returns null without reading other private sources when case denied', async () => {
  ports.read.mockResolvedValue(null);
  expect(await read()).toBeNull();
  expect(ports.policy).not.toHaveBeenCalled();
});
it('retains explicitly absent approved policy as read-only context', async () => {
  ports.policy.mockResolvedValue(null);
  expect(await read()).toMatchObject({ policy: null });
});
it('drops all bytes if grant expires during observation', async () => {
  ports.grant.mockResolvedValue(null);
  expect(await read()).toBeNull();
});
it('drops all bytes when read flag closes at final delivery', async () => {
  let enabled = true;
  ports.ownership.mockImplementation(() => {
    enabled = false;
    return null;
  });
  expect(await read(() => enabled)).toBeNull();
});
it('rejects assessment-purpose form scope', async () => {
  await expect(read(() => true, { ...scope, purpose: 'ASSESSMENT_REVIEW' })).rejects.toThrow();
  expect(ports.read).not.toHaveBeenCalled();
});
it.each([
  { ...policy, policy: { ...policy.policy, state: 'WITHDRAWN' } },
  {
    ...policy,
    policy: { ...policy.policy, definitionReference: { recordId: 'foreign', revision: 1 } },
  },
  {
    ...policy,
    policy: { ...policy.policy, rubricReference: { recordId: 'foreign', revision: 1 } },
  },
  { ...policy, policy: { ...policy.policy, purpose: 'ASSESSMENT_REVIEW' } },
  { ...policy, policy: { ...policy.policy, skillId: 'foreign' } },
])('rejects malformed/cross-case policy %#', async (bad) => {
  ports.policy.mockResolvedValue(bad);
  await expect(read()).rejects.toThrow('STORAGE_CONTRACT');
});
it('rejects foreign returned evaluator', async () => {
  ports.read.mockResolvedValue({
    ...review,
    assignment: { ...review.assignment, evaluatorAccountId: 'foreign' },
  });
  await expect(read()).rejects.toThrow('STORAGE_CONTRACT');
});
it('exports strict coherent context schema for reusable server hosts', () => {
  expect(
    PracticeOwnershipContextSchema.safeParse({ version: 'v1', review, policy, ownership: null })
      .success,
  ).toBe(true);
  expect(
    PracticeOwnershipContextSchema.safeParse({
      version: 'v1',
      review,
      policy,
      ownership: null,
      secret: 'bad',
    }).success,
  ).toBe(false);
});
it('passes only exact assignment-use fields to the strict final authority source', async () => {
  ports.grant.mockImplementation((_tx, _actor, input) => {
    if (Object.keys(input).some((k) => !['assignmentId', 'submissionId', 'purpose'].includes(k)))
      throw Error('INVALID_INPUT');
    return review.assignment;
  });
  expect(await read()).not.toBeNull();
});
