import { describe, expect, it, vi } from 'vitest';
import { WorkError } from '../src/work-loop/contracts';
import {
  WorkHttpError,
  createWorkHandlers,
  type WorkHttpHost,
} from '../src/work-http/workspace-http';
const actor = { accountId: 'account-1', sessionHash: 'a'.repeat(64) };
const engagementId = '11111111-1111-4111-8111-111111111111';
const submissionId = '22222222-2222-4222-8222-222222222222';
const termsVersionId = '33333333-3333-4333-8333-333333333333';
const participantId = '44444444-4444-4444-8444-444444444444';
const submission = {
  id: submissionId,
  engagementId,
  termsVersionId,
  submissionNumber: 1,
  submitterParticipantId: participantId,
  explanation: 'Done.',
  artifacts: [{ kind: 'COMMIT', ref: 'synthetic://r', immutableVersion: 'a'.repeat(40) }],
  dependencies: [],
  aiUsage: null,
  createdAt: '2026-10-26T00:00:00.000Z',
};
const body = {
  engagementId,
  expectedSubmissionNumber: 1,
  explanation: 'Done.',
  artifacts: submission.artifacts,
  dependencies: [],
  aiUsage: null,
};
function host(overrides: Partial<WorkHttpHost> = {}): WorkHttpHost {
  return {
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => actor,
    checkOrigin: () => {},
    rateLimit: () => {},
    me: async () => ({ version: 'v1', engagements: [], applications: [] }),
    reviews: async () => ({ version: 'v1', items: [] }),
    applicants: async () => ({ version: 'v1', listings: [] }),
    submitWork: async () => ({ status: 'EXECUTED', engagementState: 'SUBMITTED', submission }),
    decideReview: async () => {
      throw new Error('unused');
    },
    issueOffer: async () => {
      throw new Error('unused');
    },
    revokeOffer: async () => {
      throw new Error('unused');
    },
    withdrawApplication: async () => {
      throw new Error('unused');
    },
    submitApplication: async () => {
      throw new Error('unused');
    },
    ...overrides,
  };
}
const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: JSON.stringify(payload),
  });
const error = async (response: Response) => (await response.json()).error;
describe('T022 work workspace HTTP boundary', () => {
  it('returns private no-store schema-checked reads', async () => {
    const handlers = createWorkHandlers(host());
    const response = await handlers.ME(new Request('http://localhost/api/v1/work/me'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ version: 'v1', engagements: [], applications: [] });
  });
  it('fails closed when the host breaks its own response contract', async () => {
    const handlers = createWorkHandlers(
      host({ me: async () => ({ version: 'v1', surprise: true }) }),
    );
    const response = await handlers.ME(new Request('http://localhost/api/v1/work/me'));
    expect(response.status).toBe(503);
    expect((await error(response)).code).toBe('SERVICE_UNAVAILABLE');
  });
  it('rejects query strings and foreign methods before reading', async () => {
    const me = vi.fn(async () => ({ version: 'v1', engagements: [], applications: [] }));
    const handlers = createWorkHandlers(host({ me }));
    expect((await handlers.ME(new Request('http://localhost/api/v1/work/me?x=1'))).status).toBe(
      422,
    );
    const wrong = await handlers.ME(
      new Request('http://localhost/api/v1/work/me', { method: 'POST' }),
    );
    expect(wrong.status).toBe(405);
    expect(me).not.toHaveBeenCalled();
  });
  it('requires origin, authentication and rate-limit approval before any write', async () => {
    const submitWork = vi.fn();
    for (const [denial, status, code] of [
      [() => new WorkHttpError(403), 403, 'FORBIDDEN'],
      [() => new WorkHttpError(401), 401, 'AUTHENTICATION_REQUIRED'],
      [() => new WorkHttpError(429), 429, 'RATE_LIMITED'],
    ] as const) {
      const handlers = createWorkHandlers(
        host({
          submitWork,
          checkOrigin: status === 403 ? () => Promise.reject(denial()) : () => {},
          actor: status === 401 ? () => Promise.reject(denial()) : async () => actor,
          rateLimit: status === 429 ? () => Promise.reject(denial()) : () => {},
        }),
      );
      const response = await handlers.SUBMIT(post('/api/v1/work/submissions', body));
      expect(response.status).toBe(status);
      expect((await error(response)).code).toBe(code);
    }
    expect(submitWork).not.toHaveBeenCalled();
  });
  it('requires a JSON body, an idempotency key and strict input', async () => {
    const submitWork = vi.fn();
    const handlers = createWorkHandlers(host({ submitWork }));
    const noKey = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await handlers.SUBMIT(noKey)).status).toBe(422);
    const wrongType = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'idempotency-key': 'key-1' },
      body: JSON.stringify(body),
    });
    expect((await handlers.SUBMIT(wrongType)).status).toBe(415);
    expect((await handlers.SUBMIT(post('/x', { ...body, participantId }))).status).toBe(422);
    expect(submitWork).not.toHaveBeenCalled();
  });
  it('passes the actor, key and request id to the command and checks the result matches the request', async () => {
    const submitWork = vi.fn(async () => ({
      status: 'EXECUTED',
      engagementState: 'SUBMITTED',
      submission,
    }));
    const handlers = createWorkHandlers(host({ submitWork }));
    const ok = await handlers.SUBMIT(post('/x', body));
    expect(ok.status).toBe(200);
    expect(submitWork).toHaveBeenCalledWith({
      actor,
      input: body,
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
    const other = createWorkHandlers(
      host({
        submitWork: async () => ({
          status: 'EXECUTED',
          engagementState: 'SUBMITTED',
          submission: { ...submission, engagementId: '55555555-5555-4555-8555-555555555555' },
        }),
      }),
    );
    expect((await other.SUBMIT(post('/x', body))).status).toBe(503);
  });
  it.each([
    ['REVIEW_EXISTS', 409, 'REVISION_CHANGED'],
    ['ENGAGEMENT_STATE', 409, 'REVISION_CHANGED'],
    ['CAPACITY_CONFLICT', 409, 'CAPACITY_CONFLICT'],
    ['OFFER_UNAVAILABLE', 409, 'OFFER_EXPIRED'],
    ['FORBIDDEN', 403, 'FORBIDDEN'],
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['UNAUTHENTICATED', 401, 'AUTHENTICATION_REQUIRED'],
    ['WRITES_DISABLED', 503, 'SERVICE_UNAVAILABLE'],
    ['STORAGE_CONTRACT', 503, 'SERVICE_UNAVAILABLE'],
  ] as const)('maps domain error %s to a stable safe envelope', async (code, status, mapped) => {
    const handlers = createWorkHandlers(
      host({
        submitWork: async () => {
          throw new WorkError(code);
        },
      }),
    );
    const response = await handlers.SUBMIT(post('/x', body));
    expect(response.status).toBe(status);
    const envelope = await error(response);
    expect(envelope).toMatchObject({ code: mapped, requestId: 'request-1' });
    expect(JSON.stringify(envelope)).not.toContain(code === 'STORAGE_CONTRACT' ? 'STORAGE' : '@@');
  });
  it('validates path identifiers and routes each management command', async () => {
    const calls: string[] = [];
    const offerId = '66666666-6666-4666-8666-666666666666';
    const applicationId = '77777777-7777-4777-8777-777777777777';
    const offer = {
      id: offerId,
      applicationId,
      slotId: engagementId,
      termsVersionId,
      participantId,
      expiresAt: '2026-10-27T00:00:00.000Z',
      state: 'REVOKED',
      acceptedEngagementId: null,
    };
    const application = {
      id: applicationId,
      slotId: engagementId,
      termsVersionId,
      participantId,
      evidenceRefs: [],
      state: 'WITHDRAWN',
    };
    const handlers = createWorkHandlers(
      host({
        revokeOffer: async (c) => {
          calls.push('revoke:' + (c.input as { offerId: string }).offerId);
          return { status: 'EXECUTED', offer };
        },
        withdrawApplication: async (c) => {
          calls.push('withdraw:' + (c.input as { applicationId: string }).applicationId);
          return { status: 'EXECUTED', application };
        },
      }),
    );
    const bad = await handlers.REVOKE_OFFER(post('/x', {}), 'not-a-uuid');
    expect(bad.status).toBe(422);
    expect((await handlers.REVOKE_OFFER(post('/x', {}), offerId)).status).toBe(200);
    expect((await handlers.WITHDRAW(post('/x', {}), applicationId)).status).toBe(200);
    expect(calls).toEqual(['revoke:' + offerId, 'withdraw:' + applicationId]);
  });
  it('submits an application with a strict body and a key, and the result must match the request', async () => {
    const slotId = '55555555-5555-4555-8555-555555555555';
    const application = {
      id: '66666666-6666-4666-8666-666666666666',
      slotId,
      termsVersionId,
      participantId,
      evidenceRefs: [],
      state: 'SUBMITTED',
    };
    const submitApplication = vi.fn(async () => ({ status: 'EXECUTED', application }));
    const handlers = createWorkHandlers(host({ submitApplication }));
    const request = { slotId, termsVersionId, evidenceRefs: [] };
    const ok = await handlers.APPLY(post('/api/v1/work/applications', request));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(submitApplication).toHaveBeenCalledWith({
      actor,
      input: request,
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
    for (const bad of [
      { ...request, extra: true },
      { ...request, slotId: 'nope' },
      { slotId, termsVersionId },
      { ...request, evidenceRefs: new Array(11).fill('e') },
    ])
      expect((await handlers.APPLY(post('/api/v1/work/applications', bad))).status).toBe(422);
    const noKey = await handlers.APPLY(
      new Request('http://localhost/api/v1/work/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
    expect(noKey.status).toBe(422);
    // A host result for another slot is never forwarded.
    const drift = createWorkHandlers(
      host({
        submitApplication: async () => ({
          status: 'EXECUTED',
          application: { ...application, slotId: '77777777-7777-4777-8777-777777777777' },
        }),
      }),
    );
    expect((await drift.APPLY(post('/api/v1/work/applications', request))).status).toBe(503);
    const full = createWorkHandlers(
      host({
        submitApplication: async () => {
          throw new WorkError('APPLICATION_LIMIT');
        },
      }),
    );
    expect((await full.APPLY(post('/api/v1/work/applications', request))).status).toBe(409);
  });
});
