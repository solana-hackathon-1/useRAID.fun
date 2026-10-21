import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  createPracticeReviewInboxHandlers,
  type PracticeReviewInboxHttpHost,
} from '../src/skills/practice-review-inbox-http';
import { PracticeReviewHttpError } from '../src/skills/practice-review-http';
import { SkillTaxonomyStorageError } from '../src/skills/taxonomy-storage-contracts';
const actor = { accountId: 'evaluator', sessionHash: 'a'.repeat(64) };
const page = () => ({
  version: 'v1',
  private: true,
  isAuthorizationToken: false,
  accessId: randomUUID(),
  observedAt: '2026-10-21T12:00:00.000Z',
  entries: [
    {
      assignmentId: randomUUID(),
      submissionId: randomUUID(),
      purpose: 'ASSESSMENT_REVIEW',
      issuedAt: '2026-10-21T11:00:00.000Z',
      expiresAt: '2026-10-21T13:00:00.000Z',
    },
  ],
  nextCursor: null,
});
const host = {
  version: 'v1' as const,
  requestId: () => randomUUID(),
  actor: vi.fn(),
  rateLimit: vi.fn(),
  list: vi.fn(),
};
const req = (query = '', method = 'GET') =>
  new Request('http://raid.test/api/v1/practice/reviews' + query, { method });
beforeEach(() => {
  vi.clearAllMocks();
  host.actor.mockResolvedValue(actor);
  host.list.mockResolvedValue({
    version: 'v1',
    readsAvailable: true,
    unavailableReason: null,
    result: { accountId: actor.accountId, page: page() },
  });
});
it('returns only strict own metadata after actor/quota/committed host, dropping internal account binding', async () => {
  const handlers = createPracticeReviewInboxHandlers(host);
  const response = await handlers.GET(req());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries).toHaveLength(1);
  expect(body).not.toHaveProperty('accountId');
  expect(JSON.stringify(body)).not.toContain(actor.accountId);
  expect(host.list).toHaveBeenCalledWith(actor, { version: 'v1', after: null });
  expect(host.actor.mock.invocationCallOrder[0]).toBeLessThan(
    host.rateLimit.mock.invocationCallOrder[0],
  );
  expect(host.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
    host.list.mock.invocationCallOrder[0],
  );
});
it('accepts exactly one UUID ordering cursor, normalized to canonical case', async () => {
  const after = 'ABCDEF00-0000-4000-8000-000000000000';
  host.list.mockResolvedValue({
    version: 'v1',
    readsAvailable: true,
    unavailableReason: null,
    result: { accountId: actor.accountId, page: { ...page(), entries: [] } },
  });
  expect((await createPracticeReviewInboxHandlers(host).GET(req('?after=' + after))).status).toBe(
    200,
  );
  expect(host.list).toHaveBeenCalledWith(actor, { version: 'v1', after: after.toLowerCase() });
});
it.each([
  '?after=bad',
  '?after=',
  '?after=' + randomUUID() + '&after=' + randomUUID(),
  '?evaluatorAccountId=foreign',
  '?purpose=ASSESSMENT_REVIEW',
  '?limit=500',
])('rejects invalid or authority-bearing query %s', async (query) => {
  expect((await createPracticeReviewInboxHandlers(host).GET(req(query))).status).toBe(422);
  expect(host.list).not.toHaveBeenCalled();
});
it.each([401, 403, 429] as const)(
  'authenticates and limits before query validation HTTP%s',
  async (status) => {
    host.actor.mockRejectedValue(new PracticeReviewHttpError(status));
    const response = await createPracticeReviewInboxHandlers(host).GET(req('?after=bad'));
    expect(response.status).toBe(status);
    expect(host.list).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('secret');
  },
);
it('enforces quota before SQL even on valid input', async () => {
  host.rateLimit.mockRejectedValueOnce(new PracticeReviewHttpError(429));
  expect((await createPracticeReviewInboxHandlers(host).GET(req())).status).toBe(429);
  expect(host.list).not.toHaveBeenCalled();
});
it.each(['foreign', 'privateField', 'disabled', 'incoherent', 'cursor', 'entryBeforeCursor'])(
  'fails closed for invalid/misbound host output %s',
  async (kind) => {
    const result = { accountId: actor.accountId, page: page() };
    let envelope: unknown = {
      version: 'v1',
      readsAvailable: true,
      unavailableReason: null,
      result,
    };
    let query = '';
    if (kind === 'foreign') result.accountId = 'foreign';
    if (kind === 'privateField')
      Object.assign(result.page.entries[0], { answer: 'private secret' });
    if (kind === 'disabled')
      envelope = {
        version: 'v1',
        readsAvailable: false,
        unavailableReason: 'DISABLED',
        result: null,
      };
    if (kind === 'incoherent') result.page.entries[0].expiresAt = '2020-01-01T00:00:00.000Z';
    if (kind === 'cursor') result.page.nextCursor = randomUUID() as never;
    if (kind === 'entryBeforeCursor') query = '?after=ffffffff-ffff-4fff-8fff-ffffffffffff';
    host.list.mockResolvedValue(envelope);
    expect((await createPracticeReviewInboxHandlers(host).GET(req(query))).status).toBe(503);
  },
);
it.each(['GET', 'HEAD'] as const)(
  'keeps success/error %s private/no-store/VaryCookie, with empty HEAD',
  async (method) => {
    const handler = createPracticeReviewInboxHandlers(host)[method];
    let response = await handler(req('', method));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    if (method === 'HEAD') expect(await response.text()).toBe('');
    host.list.mockRejectedValueOnce(new Error('driver private secret'));
    response = await handler(req('', method));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(await response.text()).not.toContain('secret');
  },
);
it.each([
  ['AUTHENTICATION_REQUIRED', 401],
  ['ACCOUNT_RESTRICTED', 403],
  ['FORBIDDEN', 403],
  ['STORAGE_UNAVAILABLE', 503],
] as const)('maps storage%s safely', async (code, status) => {
  host.list.mockRejectedValue(new SkillTaxonomyStorageError(code));
  expect((await createPracticeReviewInboxHandlers(host).GET(req())).status).toBe(status);
});
it('rejects unsupported method without listing', async () => {
  expect((await createPracticeReviewInboxHandlers(host).GET(req('', 'POST'))).status).toBe(405);
  expect(host.list).not.toHaveBeenCalled();
});
it('rejects incomplete host contracts', () => {
  expect(() =>
    createPracticeReviewInboxHandlers({
      ...host,
      list: undefined,
    } as unknown as PracticeReviewInboxHttpHost),
  ).toThrow();
});
