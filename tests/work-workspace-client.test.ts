import { describe, expect, it, vi } from 'vitest';
import {
  WorkClientError,
  createWorkClient,
  describeWorkFailure,
  type WorkTransport,
} from '../src/work-http/workspace-client';
const empty = { version: 'v1', engagements: [], applications: [] };
const submissionInput = {
  engagementId: '11111111-1111-4111-8111-111111111111',
  expectedSubmissionNumber: 1,
  explanation: 'Done.',
  artifacts: [{ kind: 'COMMIT' as const, ref: 'synthetic://r', immutableVersion: 'a'.repeat(40) }],
  dependencies: [],
  aiUsage: null,
};
const transport = (status: number, body: unknown) => ({
  request: vi.fn(async (...args: [string, string, unknown?]) => (void args, { status, body })),
});
describe('T022 work workspace browser client', () => {
  it('reads and validates the member view', async () => {
    const t = transport(200, empty);
    expect(await createWorkClient(t).me()).toEqual(empty);
    expect(t.request).toHaveBeenCalledWith('GET', '/api/v1/work/me', undefined);
  });
  it('treats a response outside the strict contract as a contract failure', async () => {
    const client = createWorkClient(transport(200, { ...empty, extra: true }));
    await expect(client.me()).rejects.toMatchObject({ code: 'CONTRACT' });
  });
  it('sends commands with the supplied idempotency key and the exact body', async () => {
    const t = transport(503, {
      error: { code: 'SERVICE_UNAVAILABLE', message: 'x', retryable: true, requestId: 'r' },
    });
    await expect(createWorkClient(t).submitWork(submissionInput, 'key-1')).rejects.toBeInstanceOf(
      WorkClientError,
    );
    expect(t.request).toHaveBeenCalledWith('POST', '/api/v1/work/submissions', {
      body: submissionInput,
      idempotencyKey: 'key-1',
    });
  });
  it('routes management commands to their paths', async () => {
    const t = transport(500, {});
    const client = createWorkClient(t);
    const offerId = '66666666-6666-4666-8666-666666666666';
    const applicationId = '77777777-7777-4777-8777-777777777777';
    await client.revokeOffer(offerId, 'k').catch(() => {});
    await client.withdrawApplication(applicationId, 'k').catch(() => {});
    await client.startEngagement(applicationId, 'k').catch(() => {});
    await client
      .submitApplication({ slotId: applicationId, termsVersionId: offerId, evidenceRefs: [] }, 'k')
      .catch(() => {});
    await client
      .recordConsent(
        { slotId: applicationId, termsVersionId: offerId, termsDigest: 'a'.repeat(64) },
        'k',
      )
      .catch(() => {});
    await client
      .acceptRaid({ slotId: applicationId, termsVersionId: offerId }, 'k')
      .catch(() => {});
    await client
      .issueOffer({ applicationId, expiresAt: '2026-10-27T00:00:00.000Z' }, 'k')
      .catch(() => {});
    expect(t.request.mock.calls.map((c) => c[1])).toEqual([
      `/api/v1/work/offers/${offerId}/revocation`,
      `/api/v1/work/applications/${applicationId}/withdrawal`,
      `/api/v1/work/engagements/${applicationId}/start`,
      '/api/v1/work/applications',
      '/api/v1/work/consents',
      '/api/v1/work/engagements',
      '/api/v1/work/offers',
    ]);
  });
  it.each([
    [409, 'REVISION_CHANGED', 'REFRESH'],
    [409, 'OFFER_EXPIRED', 'REFRESH'],
    [409, 'CAPACITY_CONFLICT', 'NONE'],
    [401, 'AUTHENTICATION_REQUIRED', 'SIGN_IN'],
    [403, 'FORBIDDEN', 'NONE'],
    [429, 'RATE_LIMITED', 'RETRY_SAME_REQUEST'],
    [503, 'SERVICE_UNAVAILABLE', 'RETRY_SAME_REQUEST'],
    [409, 'IDEMPOTENCY_KEY_REUSED', 'NONE'],
  ] as const)('guides %s %s to %s without exposing internals', async (status, code, kind) => {
    const client = createWorkClient(
      transport(status, {
        error: { code, message: 'server text', retryable: false, requestId: 'req-9' },
      }),
    );
    const failure = await client.me().catch((e: unknown) => e);
    const described = describeWorkFailure(failure);
    expect(described.kind).toBe(kind);
    expect(described.message.length).toBeGreaterThan(10);
    expect(described.message).not.toContain('server text');
  });
  it('treats an unreachable server as an unconfirmed result that may be retried with the same key', async () => {
    const t: WorkTransport = {
      request: async () => {
        throw new TypeError('network');
      },
    };
    const failure = await createWorkClient(t)
      .submitWork(submissionInput, 'key-2')
      .catch((e: unknown) => e);
    expect(describeWorkFailure(failure).kind).toBe('RETRY_SAME_REQUEST');
    expect(describeWorkFailure(new Error('boom')).kind).toBe('RETRY_SAME_REQUEST');
  });
});
