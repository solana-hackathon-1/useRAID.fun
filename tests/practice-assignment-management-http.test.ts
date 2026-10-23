import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  createPracticeAssignmentManagementHandlers,
  type PracticeAssignmentManagementHttpHost,
} from '../src/skills/practice-assignment-management-http';
import { PracticeReviewAssignmentHttpError } from '../src/skills/practice-review-assignment-http';
import { PracticeReviewAssignmentError } from '../src/skills/practice-review-assignment-storage';
const actor = { accountId: 'current-manager', sessionHash: 'a'.repeat(64) };
const page = () => ({
  version: 'v1',
  private: true,
  isAuthorizationToken: false,
  accessId: randomUUID(),
  actorAccountId: actor.accountId,
  observedAt: '2026-10-23T12:00:00.000Z',
  submissionId: null,
  after: null,
  entries: [],
  nextCursor: null,
});
const host = {
  version: 'v1' as const,
  requestId: () => randomUUID(),
  actor: vi.fn(),
  rateLimit: vi.fn(),
  read: vi.fn(),
};
const req = (query = '', method = 'GET') =>
  new Request('http://raid.test/api/v1/admin/practice/review-assignments' + query, { method });
const result = () => ({
  version: 'v1',
  writesAvailable: true,
  unavailableReason: null,
  result: { managerXId: 'current-x', page: page() },
});
beforeEach(() => {
  vi.resetAllMocks();
  host.actor.mockResolvedValue(actor);
  host.read.mockResolvedValue(result());
});
it('returns strict current own admin/config without forwarding internal X identity', async () => {
  const response = await createPracticeAssignmentManagementHandlers(host).GET(req());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.page.actorAccountId).toBe(actor.accountId);
  expect(body).not.toHaveProperty('result');
  expect(JSON.stringify(body)).not.toContain('current-x');
  expect(host.read).toHaveBeenCalledWith(actor, { version: 'v1', submissionId: null, after: null });
});
it('accepts bound exact submission and optional canonical ordering cursor', async () => {
  const submissionId = randomUUID(),
    after = randomUUID(),
    r = result();
  Object.assign(r.result.page, { submissionId, after });
  host.read.mockResolvedValue(r);
  expect(
    (
      await createPracticeAssignmentManagementHandlers(host).GET(
        req('?submissionId=' + submissionId + '&after=' + after),
      )
    ).status,
  ).toBe(200);
  expect(host.read).toHaveBeenCalledWith(actor, { version: 'v1', submissionId, after });
});
it.each([
  '?after=' + randomUUID(),
  '?submissionId=bad',
  '?submissionId=' + randomUUID() + '&submissionId=' + randomUUID(),
  '?actorAccountId=foreign',
  '?limit=1000',
  '?submissionId=',
])('rejects malformed or authority input before hostread %s', async (query) => {
  expect((await createPracticeAssignmentManagementHandlers(host).GET(req(query))).status).toBe(422);
  expect(host.read).not.toHaveBeenCalled();
});
it.each([401, 403, 429] as const)(
  'authenticates before malformed lookup HTTP%s',
  async (status) => {
    host.actor.mockRejectedValue(new PracticeReviewAssignmentHttpError(status));
    expect(
      (await createPracticeAssignmentManagementHandlers(host).GET(req('?submissionId=bad'))).status,
    ).toBe(status);
    expect(host.read).not.toHaveBeenCalled();
  },
);
it('enforces existing current-account quota before metadata storage', async () => {
  host.rateLimit.mockRejectedValue(new PracticeReviewAssignmentHttpError(429));
  expect((await createPracticeAssignmentManagementHandlers(host).GET(req())).status).toBe(429);
  expect(host.read).not.toHaveBeenCalled();
});
it.each([
  'foreignactor',
  'wrongsubmission',
  'wrongcursor',
  'privatefield',
  'incoherentgate',
  'malformed',
])('rejects host contract %s', async (kind) => {
  const r = result();
  if (kind === 'foreignactor') r.result.page.actorAccountId = 'foreign';
  if (kind === 'wrongsubmission') Object.assign(r.result.page, { submissionId: randomUUID() });
  if (kind === 'wrongcursor')
    Object.assign(r.result.page, { submissionId: randomUUID(), after: randomUUID() });
  if (kind === 'privatefield') Object.assign(r.result.page, { answer: 'private secret' });
  if (kind === 'incoherentgate') r.writesAvailable = false;
  host.read.mockResolvedValue(kind === 'malformed' ? null : r);
  expect((await createPracticeAssignmentManagementHandlers(host).GET(req())).status).toBe(503);
});
it('retains current inspection while new writes are disabled', async () => {
  const r = result();
  r.writesAvailable = false;
  Object.assign(r, { unavailableReason: 'DISABLED' });
  host.read.mockResolvedValue(r);
  const response = await createPracticeAssignmentManagementHandlers(host).GET(req());
  expect(response.status).toBe(200);
  expect((await response.json()).writesAvailable).toBe(false);
});
it.each(['GET', 'HEAD'] as const)(
  'keeps%s success and denial private, HEAD empty',
  async (method) => {
    const handle = createPracticeAssignmentManagementHandlers(host)[method];
    let response = await handle(req('', method));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    if (method === 'HEAD') expect(await response.text()).toBe('');
    host.read.mockRejectedValueOnce(new Error('driver private secret'));
    response = await handle(req('', method));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).not.toContain('secret');
  },
);
it.each([
  ['AUTHENTICATION_REQUIRED', 401],
  ['ACCOUNT_RESTRICTED', 403],
  ['FORBIDDEN', 403],
  ['INVALID_INPUT', 422],
  ['STORAGE_UNAVAILABLE', 503],
] as const)('sanitizes storage%s', async (code, status) => {
  host.read.mockRejectedValue(new PracticeReviewAssignmentError(code));
  expect((await createPracticeAssignmentManagementHandlers(host).GET(req())).status).toBe(status);
});
it('does not permit mutations through the read dispatcher', async () => {
  expect((await createPracticeAssignmentManagementHandlers(host).GET(req('', 'POST'))).status).toBe(
    405,
  );
  expect(host.read).not.toHaveBeenCalled();
});
it('rejects incomplete versioned read host', () => {
  expect(() =>
    createPracticeAssignmentManagementHandlers({
      ...host,
      read: undefined,
    } as unknown as PracticeAssignmentManagementHttpHost),
  ).toThrow();
});
