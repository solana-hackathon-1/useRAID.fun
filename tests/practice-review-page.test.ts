import { beforeEach, expect, it, vi } from 'vitest';
import { createPracticeReviewPageLoader } from '../src/skills/practice-review-page';
import { reviewScope, reviewViewFixture as review } from './helpers/practice-review-view-fixture';
const get = vi.fn();
const params = { assignmentId: reviewScope.assignmentId, submissionId: reviewScope.submissionId };
const query = { purpose: reviewScope.purpose };
const envelope = { version: 'v1', review, readsAvailable: true, unavailableReason: null };
beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async () => Response.json(envelope));
});
const load = (path: unknown = params, search: unknown = query) =>
  createPracticeReviewPageLoader(get)(path, search);
it('passes exact request scope through the existing protected GET and returns canonical private evidence', async () => {
  expect(await load()).toEqual({ status: 'READY', scope: reviewScope, review });
  expect(get).toHaveBeenCalledTimes(1);
  const [request, path] = get.mock.calls[0];
  expect(request.method).toBe('GET');
  expect(new URL(request.url).search).toBe('?purpose=OWNERSHIP_REVIEW');
  expect(path).toEqual(params);
});
it.each([
  [null, query],
  [{ ...params, assignmentId: 'bad' }, query],
  [params, {}],
  [params, { purpose: ['OWNERSHIP_REVIEW', 'OWNERSHIP_REVIEW'] }],
  [params, { ...query, actor: 'forged' }],
  [params, { purpose: 'FRAUD' }],
])('rejects malformed path/query before any access attempt %#', async (path, search) => {
  expect(await load(path, search)).toEqual({ status: 'NOT_FOUND' });
  expect(get).not.toHaveBeenCalled();
});
it.each([
  [401, 'SIGN_IN'],
  [403, 'DENIED'],
  [404, 'NOT_FOUND'],
  [429, 'RATE_LIMITED'],
  [422, 'NOT_FOUND'],
  [503, 'UNAVAILABLE'],
] as const)('maps HTTP %s without exposing private error diagnostics', async (status, expected) => {
  get.mockImplementation(async () => new Response('private-answer-marker', { status }));
  expect(await load()).toEqual({ status: expected, scope: reviewScope });
});
it.each([
  { ...envelope, readsAvailable: false },
  { ...envelope, extra: 'private-answer-marker' },
  { ...envelope, review: null },
  {
    ...envelope,
    review: {
      ...review,
      assignment: { ...review.assignment, id: '66666666-6666-4666-8666-666666666666' },
    },
  },
  {
    ...envelope,
    review: { ...review, assignment: { ...review.assignment, purpose: 'ASSESSMENT_REVIEW' } },
  },
])('rejects malformed or mismatched success envelopes %#', async (body) => {
  get.mockImplementation(async () => Response.json(body));
  expect(await load()).toEqual({ status: 'UNAVAILABLE', scope: reviewScope });
});
it('sanitizes thrown handlers and unreadable JSON', async () => {
  get.mockRejectedValueOnce(new Error('private-answer-marker'));
  expect(await load()).toEqual({ status: 'UNAVAILABLE', scope: reviewScope });
  get.mockImplementation(async () => new Response('private-answer-marker'));
  expect(await load()).toEqual({ status: 'UNAVAILABLE', scope: reviewScope });
});
it('does not accept a handler redirect as an authorized body', async () => {
  get.mockImplementation(async () => new Response(JSON.stringify(envelope), { status: 302 }));
  expect(await load()).toEqual({ status: 'UNAVAILABLE', scope: reviewScope });
});
