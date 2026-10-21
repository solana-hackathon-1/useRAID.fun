import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  actor: vi.fn(),
  rateLimit: vi.fn(),
  read: vi.fn(),
  enabled: true,
  writes: true,
  tx: {},
}));
vi.mock('../src/lib/practice-assessment-http', () => ({
  practiceAssessmentHttpHost: { actor: ports.actor, rateLimit: ports.rateLimit },
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: unknown) => unknown) => work(ports.tx),
}));
vi.mock('../src/lib/practice-review-reads-host', () => ({
  practiceReviewReadConfiguration: () => ({ readsAvailable: ports.enabled }),
}));
vi.mock('../src/lib/practice-trial-assessments-host', () => ({
  practiceTrialAssessmentWriteConfiguration: () => ({ writesAvailable: ports.writes }),
}));
vi.mock('../src/lib/practice-assessment-decisions-host', () => ({
  practiceAssessmentDecisionWriteConfiguration: () => ({ writesAvailable: ports.writes }),
}));
vi.mock('../src/skills/practice-assessment-context', async (original) => ({
  ...(await original<object>()),
  readPracticeAssessmentContext: ports.read,
}));
import { loadPracticeAssessmentPage } from '../src/lib/practice-assessment-page';
import { PracticeAssessmentHttpError } from '../src/skills/practice-assessment-http';
import { assessmentContextFixture as context } from './helpers/practice-assessment-view-fixture';
const path = {
  assignmentId: context.review.assignment.id,
  submissionId: context.review.submission.reference.recordId,
};
const actor = {
  accountId: context.review.assignment.evaluatorAccountId,
  sessionHash: 'a'.repeat(64),
};
beforeEach(() => {
  vi.resetAllMocks();
  ports.enabled = true;
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'catalog');
  ports.writes = true;
  ports.actor.mockResolvedValue(actor);
  const data = Object.fromEntries(
    Object.entries(context).filter(([key]) => !key.endsWith('WritesAvailable')),
  );
  ports.read.mockResolvedValue(data);
});
it('loads actual server session/quota and transaction context bound to assessment path', async () => {
  expect(await loadPracticeAssessmentPage(path)).toEqual({ status: 'READY', context });
  expect(ports.read).toHaveBeenCalledWith(
    ports.tx,
    actor,
    { version: 'v1', ...path, purpose: 'ASSESSMENT_REVIEW' },
    expect.any(Function),
  );
  expect(ports.rateLimit).toHaveBeenCalledExactlyOnceWith(actor);
});
it.each([
  [401, 'SIGN_IN'],
  [403, 'DENIED'],
  [429, 'RATE_LIMITED'],
] as const)('maps current auth %s without reading context', async (status, result) => {
  ports.actor.mockRejectedValue(new PracticeAssessmentHttpError(status));
  expect(await loadPracticeAssessmentPage(path)).toEqual({ status: result });
  expect(ports.read).not.toHaveBeenCalled();
});
it('drops private context if read gate closes after committed observation', async () => {
  ports.read.mockImplementation(async () => {
    ports.enabled = false;
    return context;
  });
  expect(await loadPracticeAssessmentPage(path)).toEqual({ status: 'UNAVAILABLE' });
});
it('preserves context read-only with new writes disabled', async () => {
  ports.writes = false;
  expect(await loadPracticeAssessmentPage(path)).toEqual({
    status: 'READY',
    context: { ...context, reviewWritesAvailable: false, decisionWritesAvailable: false },
  });
});
it('denies invalid path without calling auth/storage', async () => {
  expect(await loadPracticeAssessmentPage({ ...path, accountId: 'forged' })).toEqual({
    status: 'NOT_FOUND',
  });
  expect(ports.actor).not.toHaveBeenCalled();
});
it('rejects internally coherent context for another appointed account', async () => {
  const data = Object.fromEntries(
    Object.entries(context).filter(([key]) => !key.endsWith('WritesAvailable')),
  );
  ports.read.mockResolvedValue({
    ...data,
    review: {
      ...context.review,
      assignment: { ...context.review.assignment, evaluatorAccountId: 'foreign' },
    },
  });
  expect(await loadPracticeAssessmentPage(path)).toEqual({ status: 'UNAVAILABLE' });
});
it('returns a private-free not-found for missing/denied context', async () => {
  ports.read.mockResolvedValue(null);
  expect(await loadPracticeAssessmentPage(path)).toEqual({ status: 'NOT_FOUND' });
});

afterEach(() => vi.unstubAllEnvs());
it('disables new actions when the configured namespace differs from the actual case', async () => {
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'foreign');
  expect(await loadPracticeAssessmentPage(path)).toEqual({
    status: 'READY',
    context: { ...context, reviewWritesAvailable: false, decisionWritesAvailable: false },
  });
});
