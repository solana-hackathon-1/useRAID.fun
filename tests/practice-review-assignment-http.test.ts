import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPracticeReviewAssignmentHandlers,
  PracticeReviewAssignmentHttpError,
  type PracticeReviewAssignmentHttpHost,
} from '../src/skills/practice-review-assignment-http';
import { PracticeReviewAssignmentError } from '../src/skills/practice-review-assignment-storage';
import { CommandReceiptError } from '../src/command-receipts';

const actor = { accountId: 'admin-account', sessionHash: 'a'.repeat(64) };
const submissionId = randomUUID();
const assignmentId = randomUUID();
const input = {
  version: 'v1',
  submissionId,
  evaluatorAccountId: 'evaluator-account',
  purpose: 'ASSESSMENT_REVIEW',
  expiresAt: '2026-11-01T00:00:00.000Z',
  reason: 'Synthetic appointment',
};
const assignment = (over: Record<string, unknown> = {}) => ({
  version: 'v1',
  id: assignmentId,
  submissionId,
  evaluatorAccountId: input.evaluatorAccountId,
  purpose: input.purpose,
  expiresAt: input.expiresAt,
  issuedAt: '2026-10-21T12:00:00.000Z',
  issuedByAccountId: actor.accountId,
  reason: input.reason,
  state: 'ISSUED',
  isAuthorizationToken: false,
  ...over,
});
const revocation = (over: Record<string, unknown> = {}) => ({
  version: 'v1',
  id: randomUUID(),
  assignmentId,
  revokedAt: '2026-10-21T12:30:00.000Z',
  revokedByAccountId: actor.accountId,
  reason: 'Synthetic revoke',
  state: 'REVOKED',
  isAuthorizationToken: false,
  ...over,
});
const host = {
  version: 'v1' as const,
  requestId: () => randomUUID(),
  origin: vi.fn(),
  actor: vi.fn(),
  rateLimit: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
};
const issueReq = (body: unknown = input, headers: Record<string, string> = {}, query = '') =>
  new Request('http://raid.test/api/v1/admin/practice/review-assignments' + query, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-issue-1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const revokeInput = { version: 'v1', assignmentId, reason: 'Synthetic revoke' };
const revokeReq = (body: unknown = revokeInput, headers: Record<string, string> = {}, query = '') =>
  new Request(
    `http://raid.test/api/v1/admin/practice/review-assignments/${assignmentId}/revocations` + query,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'key-revoke-1',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
const done = (extra: Record<string, unknown> = {}) => ({
  version: 'v1',
  status: 'EXECUTED',
  writesAvailable: true,
  unavailableReason: null,
  ...extra,
});
const handlers = () =>
  createPracticeReviewAssignmentHandlers(host as unknown as PracticeReviewAssignmentHttpHost);
beforeEach(() => {
  vi.resetAllMocks();
  host.requestId = () => randomUUID();
  host.actor.mockResolvedValue(actor);
  host.issue.mockResolvedValue(done({ assignment: assignment() }));
  host.revoke.mockResolvedValue(done({ revocation: revocation() }));
});

describe('issue', () => {
  it('runs origin → actor → quota → committed command and returns the bound private result', async () => {
    const response = await handlers().issue(issueReq());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie');
    const body = await response.json();
    expect(body).toMatchObject({
      version: 'v1',
      status: 'EXECUTED',
      assignment: { id: assignmentId },
    });
    expect(host.issue).toHaveBeenCalledExactlyOnceWith({
      actor,
      input,
      idempotencyKey: 'key-issue-1',
      requestId: expect.any(String),
    });
    const order = [host.origin, host.actor, host.rateLimit, host.issue].map(
      (f) => f.mock.invocationCallOrder[0],
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it.each([
    ['query string', () => issueReq(input, {}, '?evaluator=x')],
    ['missing key', () => issueReq(input, { 'Idempotency-Key': '' })],
    ['unknown field', () => issueReq({ ...input, issuedByAccountId: 'forged' })],
    ['wrong version', () => issueReq({ ...input, version: 'v2' })],
    ['bad purpose', () => issueReq({ ...input, purpose: 'ADMIN' })],
    ['non-json', () => issueReq('not json')],
    ['array body', () => issueReq([input])],
  ])('rejects %s as 422 before any host command', async (_name, make) => {
    const response = await handlers().issue(make());
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('INVALID_COMMAND');
    expect(host.issue).not.toHaveBeenCalled();
  });
  it('rejects an oversize body with the bounded-body status before any host command', async () => {
    const response = await handlers().issue(issueReq({ ...input, reason: 'x'.repeat(20000) }));
    expect(response.status).toBe(413);
    expect(host.issue).not.toHaveBeenCalled();
  });
  it.each([
    [
      'assignment for another evaluator',
      { assignment: assignment({ evaluatorAccountId: 'other' }) },
    ],
    [
      'assignment for another submission',
      { assignment: assignment({ submissionId: randomUUID() }) },
    ],
    ['different purpose', { assignment: assignment({ purpose: 'OWNERSHIP_REVIEW' }) }],
    ['different expiry', { assignment: assignment({ expiresAt: '2027-01-01T00:00:00.000Z' }) }],
    ['different reason', { assignment: assignment({ reason: 'changed' }) }],
    ['forged issuer', { assignment: assignment({ issuedByAccountId: 'someone-else' }) }],
    ['token flag true', { assignment: assignment({ isAuthorizationToken: true }) }],
    ['missing assignment', {}],
    ['extra private field', { assignment: assignment(), secret: 'x' }],
    ['unknown status', { status: 'DONE', assignment: assignment() }],
  ])('fails closed (503) on %s', async (_name, extra) => {
    host.issue.mockResolvedValue(done(extra));
    const response = await handlers().issue(issueReq());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('other');
  });
  it('accepts a replayed result with the original binding', async () => {
    host.issue.mockResolvedValue(done({ status: 'REPLAYED', assignment: assignment() }));
    expect((await (await handlers().issue(issueReq())).json()).status).toBe('REPLAYED');
  });
  it('keeps a committed result when writes close after commit', async () => {
    host.issue.mockResolvedValue(
      done({ writesAvailable: false, unavailableReason: 'DISABLED', assignment: assignment() }),
    );
    const response = await handlers().issue(issueReq());
    expect(response.status).toBe(200);
  });
});

describe('revoke', () => {
  it('binds path, body and result, and returns the immutable revocation', async () => {
    const response = await handlers().revoke(revokeReq(), { assignmentId });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(host.revoke).toHaveBeenCalledExactlyOnceWith({
      actor,
      input: revokeInput,
      idempotencyKey: 'key-revoke-1',
      requestId: expect.any(String),
    });
    expect((await response.json()).revocation.assignmentId).toBe(assignmentId);
  });
  it.each([
    [
      'path/body id mismatch',
      () => revokeReq({ ...revokeInput, assignmentId: randomUUID() }),
      { assignmentId },
    ],
    ['non-uuid path', () => revokeReq(), { assignmentId: 'not-a-uuid' }],
    ['extra path param', () => revokeReq(), { assignmentId, other: 'x' }],
    ['query', () => revokeReq(revokeInput, {}, '?x=1'), { assignmentId }],
    ['missing key', () => revokeReq(revokeInput, { 'Idempotency-Key': '' }), { assignmentId }],
    ['unknown field', () => revokeReq({ ...revokeInput, state: 'REVOKED' }), { assignmentId }],
  ])('rejects %s as 422 before any host command', async (_name, make, params) => {
    const response = await handlers().revoke(make(), params);
    expect(response.status).toBe(422);
    expect(host.revoke).not.toHaveBeenCalled();
  });
  it.each([
    ['other assignment', { revocation: revocation({ assignmentId: randomUUID() }) }],
    ['other reason', { revocation: revocation({ reason: 'different' }) }],
    ['forged revoker', { revocation: revocation({ revokedByAccountId: 'someone-else' }) }],
    ['assignment shape', { assignment: assignment() }],
  ])('fails closed (503) on %s', async (_name, extra) => {
    host.revoke.mockResolvedValue(done(extra));
    expect((await handlers().revoke(revokeReq(), { assignmentId })).status).toBe(503);
  });
  it('awaits params rejection safely', async () => {
    const response = await handlers().revoke(revokeReq(), Promise.reject(new Error('boom')));
    expect(response.status).toBe(503);
  });
});

describe('authority and error mapping', () => {
  it('stops at origin denial before actor, quota or command', async () => {
    host.origin.mockRejectedValue(new PracticeReviewAssignmentHttpError(403));
    const response = await handlers().issue(issueReq());
    expect(response.status).toBe(403);
    expect(host.actor).not.toHaveBeenCalled();
    expect(host.issue).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'AUTHENTICATION_REQUIRED'],
    [403, 'FORBIDDEN'],
    [429, 'RATE_LIMITED'],
  ] as const)('maps actor/quota %s to a sanitized envelope', async (status, code) => {
    host.actor.mockRejectedValue(new PracticeReviewAssignmentHttpError(status));
    const response = await handlers().issue(issueReq());
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
    expect(host.issue).not.toHaveBeenCalled();
  });
  it('limits the authenticated actor before reading the body', async () => {
    host.rateLimit.mockRejectedValue(new PracticeReviewAssignmentHttpError(429));
    const response = await handlers().issue(issueReq());
    expect(response.status).toBe(429);
    expect(host.issue).not.toHaveBeenCalled();
  });
  it.each([
    ['INVALID_INPUT', 422, 'INVALID_COMMAND'],
    ['EXPIRY_INVALID', 422, 'INVALID_COMMAND'],
    ['AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'],
    ['ACCOUNT_RESTRICTED', 403, 'ACCOUNT_RESTRICTED'],
    ['FORBIDDEN', 403, 'FORBIDDEN'],
    ['SELF_REVIEW_FORBIDDEN', 403, 'FORBIDDEN'],
    ['RESOURCE_UNAVAILABLE', 404, 'NOT_FOUND'],
    ['ALREADY_REVOKED', 409, 'REVISION_CHANGED'],
    ['WRITES_DISABLED', 503, 'SERVICE_UNAVAILABLE'],
    ['STORAGE_CONTRACT', 503, 'SERVICE_UNAVAILABLE'],
    ['STORAGE_UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE'],
  ] as const)('maps storage %s to %s/%s', async (storage, status, code) => {
    host.issue.mockRejectedValue(new PracticeReviewAssignmentError(storage));
    const response = await handlers().issue(issueReq());
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });
  it('maps idempotency key reuse to 409 and hides unknown driver text', async () => {
    host.issue.mockRejectedValue(new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'));
    expect((await handlers().issue(issueReq())).status).toBe(409);
    host.issue.mockRejectedValue(new Error('select * from "User" password=hunter2'));
    const response = await handlers().issue(issueReq());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('hunter2');
  });
  it('rejects a malformed host and never constructs handlers from one', () => {
    expect(() =>
      createPracticeReviewAssignmentHandlers({ ...host, version: 'v2' } as never),
    ).toThrow();
    expect(() =>
      createPracticeReviewAssignmentHandlers({ ...host, revoke: undefined } as never),
    ).toThrow();
  });
  it('fails closed on a malformed actor', async () => {
    host.actor.mockResolvedValue({ accountId: '', sessionHash: 'x' });
    expect((await handlers().issue(issueReq())).status).toBe(503);
    expect(host.issue).not.toHaveBeenCalled();
  });
});
