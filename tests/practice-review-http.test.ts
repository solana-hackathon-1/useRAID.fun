import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { definition } from '../examples/skill-assessments/fixtures';
import {
  createPracticeReviewHandlers,
  PracticeReviewHttpError,
} from '../src/skills/practice-review-http';
import { PracticeReviewReadError } from '../src/skills/practice-review-read-storage';
import { CommandReceiptError } from '../src/command-receipts';

const actor = { accountId: 'evaluator', sessionHash: 'a'.repeat(64) };
const input = {
  version: 'v1' as const,
  assignmentId: randomUUID(),
  submissionId: randomUUID(),
  purpose: 'OWNERSHIP_REVIEW' as const,
};
const review = {
  version: 'v1',
  private: true,
  accessId: randomUUID(),
  isAuthorizationToken: false,
  assignment: {
    version: 'v1',
    id: input.assignmentId,
    submissionId: input.submissionId,
    evaluatorAccountId: actor.accountId,
    purpose: input.purpose,
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-10-15T00:00:00.000Z',
    issuedByAccountId: 'issuer',
    reason: 'Synthetic appointment',
    state: 'ISSUED',
    isAuthorizationToken: false,
  },
  definition,
  submission: {
    version: 'v1',
    reference: { recordId: input.submissionId, revision: 1 },
    startId: randomUUID(),
    participantId: randomUUID(),
    skillId: definition.skillId,
    skillDomain: definition.skillDomain,
    definitionReference: definition.reference,
    rubricReference: definition.rubric.reference,
    state: 'SUBMITTED',
    submittedAt: '2026-10-15T00:00:00.000Z',
    answer: '\n  <script>private-marker</script>\r\n',
    explanation: 'private-explanation-marker',
    toolsUsed: ['editor'],
    aiAssistanceUsed: false,
    assistanceDisclosure: 'private-disclosure-marker',
    ownership: 'UNCONFIRMED',
    persisted: true,
    verifiesSkill: false,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  },
};
const result = { version: 'v1', review, readsAvailable: true, unavailableReason: null };
const host = {
  version: 'v1' as const,
  actor: vi.fn(),
  rateLimit: vi.fn(),
  read: vi.fn(),
  requestId: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  host.actor.mockResolvedValue(actor);
  host.read.mockResolvedValue(result);
  host.requestId.mockReturnValue('request-1');
});
const get = (
  query = '?purpose=OWNERSHIP_REVIEW',
  params: unknown = Promise.resolve({
    assignmentId: input.assignmentId,
    submissionId: input.submissionId,
  }),
  method = 'GET',
) =>
  createPracticeReviewHandlers(host).GET(
    new Request('http://localhost/api/v1/practice/reviews/case/submissions/item' + query, {
      method,
    }),
    params,
  );
async function denied(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  const body = await response.text();
  for (const secret of [
    'private-marker',
    'private-explanation-marker',
    'private-disclosure-marker',
    actor.sessionHash,
  ])
    expect(body).not.toContain(secret);
  return JSON.parse(body);
}
it('returns exact original bytes/rubric and unconfirmed ownership only for current scoped actor', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual(result);
  expect(host.read).toHaveBeenCalledExactlyOnceWith(actor, input);
  expect(host.rateLimit).toHaveBeenCalledExactlyOnceWith(actor);
});
it('consumes an assessment-review appointment using the same explicit purpose contract', async () => {
  host.read.mockResolvedValue({
    ...result,
    review: {
      ...review,
      assignment: { ...review.assignment, purpose: 'ASSESSMENT_REVIEW' },
    },
  });
  expect((await get('?purpose=ASSESSMENT_REVIEW')).status).toBe(200);
  expect(host.read).toHaveBeenCalledWith(actor, { ...input, purpose: 'ASSESSMENT_REVIEW' });
});
it('rejects an internally coherent foreign submission before delivering bytes', async () => {
  const other = randomUUID();
  host.read.mockResolvedValue({
    ...result,
    review: {
      ...review,
      assignment: { ...review.assignment, submissionId: other },
      submission: { ...review.submission, reference: { recordId: other, revision: 1 } },
    },
  });
  await denied(await get(), 503);
});
it('contains rejected route params when authentication fails first', async () => {
  host.actor.mockRejectedValue(new PracticeReviewHttpError(401));
  await denied(
    await get('?purpose=OWNERSHIP_REVIEW', Promise.reject(new Error('private-marker'))),
    401,
  );
});
it.each([401, 403, 429] as const)(
  'sanitizes authority %s before private source',
  async (status) => {
    host.actor.mockRejectedValue(new PracticeReviewHttpError(status));
    await denied(await get(), status);
    expect(host.read).not.toHaveBeenCalled();
  },
);
it('rate limits actual account before private source', async () => {
  host.rateLimit.mockRejectedValue(new PracticeReviewHttpError(429));
  await denied(await get(), 429);
  expect(host.read).not.toHaveBeenCalled();
});
it.each([
  '',
  '?purpose=NOPE',
  '?purpose=OWNERSHIP_REVIEW&purpose=OWNERSHIP_REVIEW',
  '?purpose=OWNERSHIP_REVIEW&actor=evaluator',
])('rejects missing, duplicate and unknown query authority: %s', async (query) => {
  await denied(await get(query), 422);
  expect(host.read).not.toHaveBeenCalled();
});
it.each([
  null,
  {},
  { assignmentId: 'not-uuid', submissionId: input.submissionId },
  { assignmentId: input.assignmentId, submissionId: 'not-uuid' },
  { assignmentId: input.assignmentId, submissionId: input.submissionId, accountId: 'forged' },
])('rejects invalid/forged route context before private source %j', async (params) => {
  await denied(await get('?purpose=OWNERSHIP_REVIEW', params), 422);
  expect(host.read).not.toHaveBeenCalled();
});
it('rejects unsupported method without private source', async () => {
  await denied(await get('?purpose=OWNERSHIP_REVIEW', undefined, 'POST'), 405);
  expect(host.read).not.toHaveBeenCalled();
});
it('returns a non-enumerable404 for absent or denied case', async () => {
  host.read.mockResolvedValue({ ...result, review: null });
  expect((await denied(await get(), 404)).error.code).toBe('NOT_FOUND');
});
it.each([
  { ...result, readsAvailable: false, unavailableReason: 'DISABLED', review: null },
  { ...result, readsAvailable: false, unavailableReason: 'DISABLED' },
  { ...result, unavailableReason: 'DISABLED' },
  { ...result, internalSecret: 'private-marker' },
  { ...result, review: { ...review, internalSecret: 'private-marker' } },
  { ...result, review: { ...review, assignment: { ...review.assignment, id: randomUUID() } } },
  {
    ...result,
    review: { ...review, assignment: { ...review.assignment, evaluatorAccountId: 'other' } },
  },
  {
    ...result,
    review: { ...review, assignment: { ...review.assignment, purpose: 'ASSESSMENT_REVIEW' } },
  },
  { ...result, review: { ...review, submission: { ...review.submission, answer: 123 } } },
  { ...result, review: { ...review, definition: { ...definition, skillId: 'foreign' } } },
])('fails closed on disabled/mismatched/excessive host output %#', async (bad) => {
  host.read.mockResolvedValue(bad);
  await denied(await get(), 503);
});
it.each([
  ['AUTHENTICATION_REQUIRED', 401],
  ['ACCOUNT_RESTRICTED', 403],
  ['FORBIDDEN', 403],
  ['RESOURCE_UNAVAILABLE', 404],
  ['INVALID_INPUT', 422],
  ['STORAGE_CONTRACT', 503],
  ['STORAGE_UNAVAILABLE', 503],
] as const)('maps safe storage error %s', async (code, status) => {
  host.read.mockRejectedValue(new PracticeReviewReadError(code));
  await denied(await get(), status);
});
it.each([new Error('private-marker'), new CommandReceiptError('STORAGE_UNAVAILABLE')])(
  'sanitizes unknown/transaction errors',
  async (error) => {
    host.read.mockRejectedValue(error);
    await denied(await get(), 503);
  },
);
it('rejects malformed host actor without invoking storage', async () => {
  host.actor.mockResolvedValue({ ...actor, admin: true });
  await denied(await get(), 503);
  expect(host.read).not.toHaveBeenCalled();
});
it('contains rejected params and request-id callback failures without leaking diagnostics', async () => {
  host.requestId.mockImplementation(() => {
    throw new Error('private-marker');
  });
  const body = await denied(
    await get('?purpose=OWNERSHIP_REVIEW', Promise.reject(new Error('private-marker'))),
    503,
  );
  expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
});
it.each(['actor', 'rateLimit', 'read', 'requestId', 'version'])(
  'rejects missing host contract %s',
  (key) => {
    expect(() => createPracticeReviewHandlers({ ...host, [key]: undefined } as never)).toThrow(
      'STORAGE_CONTRACT',
    );
  },
);
