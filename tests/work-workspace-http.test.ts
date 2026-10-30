import { describe, expect, it, vi } from 'vitest';
import { WorkError } from '../src/work-loop/contracts';
import { CommandReceiptError } from '../src/command-receipts';
import { RootAcceptanceUnavailableError } from '../src/lib/work-acceptance-host';
import { TermsSnapshotSchema } from '../src/contracts/entities';
import { raidTerms } from './helpers/raid-terms-fixture';
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
    me: async () => ({
      version: 'v1',
      capacity: { limit: 1, held: false, engagementId: null, title: null },
      engagements: [],
      applications: [],
    }),
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
    recordConsent: async () => {
      throw new Error('unused');
    },
    commitEngagement: async () => {
      throw new Error('unused');
    },
    startEngagement: async () => {
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
    expect(await response.json()).toEqual({
      version: 'v1',
      capacity: { limit: 1, held: false, engagementId: null, title: null },
      engagements: [],
      applications: [],
    });
  });
  it('fails closed when the host breaks its own response contract', async () => {
    const handlers = createWorkHandlers(
      host({ me: async () => ({ version: 'v1', surprise: true }) }),
    );
    const response = await handlers.ME(new Request('http://localhost/api/v1/work/me'));
    expect(response.status).toBe(503);
    expect((await error(response)).code).toBe('SERVICE_UNAVAILABLE');
  });
  it.each([
    ['typed root outage', () => new RootAcceptanceUnavailableError()],
    ['receipt storage outage', () => new CommandReceiptError('STORAGE_UNAVAILABLE')],
  ])('reports a %s as a retryable SERVICE_UNAVAILABLE', async (_name, make) => {
    const handlers = createWorkHandlers(
      host({
        commitEngagement: async () => {
          throw make();
        },
      }),
    );
    const response = await handlers.ACCEPT(post('/x', { slotId, termsVersionId }));
    expect(response.status).toBe(503);
    expect(await error(response)).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
  });
  it.each([
    ['STORAGE_CONTRACT', () => new CommandReceiptError('STORAGE_CONTRACT')],
    ['INVALID_INPUT', () => new CommandReceiptError('INVALID_INPUT')],
    ['RETRY_TRANSACTION', () => new CommandReceiptError('RETRY_TRANSACTION')],
    // commitEngagement raises a WorkError (not a receipt error) for a broken storage contract: the WorkError branch.
    ['STORAGE_CONTRACT', () => new WorkError('STORAGE_CONTRACT')],
  ] as const)(
    'reports a %s storage error as SERVICE_UNAVAILABLE without leaking its code',
    async (code, make) => {
      const handlers = createWorkHandlers(
        host({
          commitEngagement: async () => {
            throw make();
          },
        }),
      );
      const response = await handlers.ACCEPT(post('/x', { slotId, termsVersionId }));
      expect(response.status).toBe(503);
      const body = await error(response);
      expect(body.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(body)).not.toContain(code);
    },
  );
  it('rejects query strings and foreign methods before reading', async () => {
    const me = vi.fn(async () => ({
      version: 'v1',
      capacity: { limit: 1, held: false, engagementId: null, title: null },
      engagements: [],
      applications: [],
    }));
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
    ['OFFER_EXPIRED', 409, 'OFFER_EXPIRED'],
    ['FORBIDDEN', 403, 'FORBIDDEN'],
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['UNAUTHENTICATED', 401, 'AUTHENTICATION_REQUIRED'],
    ['WRITES_DISABLED', 503, 'NOT_AVAILABLE'],
    ['APPLICATION_LIMIT', 409, 'APPLICATION_LIMIT_REACHED'],
    ['APPLICATION_EXISTS', 409, 'APPLICATION_EXISTS'],
    ['APPLICATION_CLOSED', 409, 'NO_LONGER_OPEN'],
    ['DEADLINE_PASSED', 409, 'NO_LONGER_OPEN'],
    ['PUBLICATION_BLOCKED', 409, 'NO_LONGER_OPEN'],
    ['ELIGIBILITY_REJECTED', 403, 'ELIGIBILITY_NOT_MET'],
    ['CONSENT_REQUIRED', 409, 'CONSENT_REQUIRED'],
    ['RESOURCES_NOT_READY', 409, 'SETUP_NOT_READY'],
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
    const slotId = '55555555-5555-4555-8555-555555555555';
    const offer = {
      id: offerId,
      applicationId,
      slotId,
      termsVersionId,
      participantId,
      expiresAt: '2026-10-27T00:00:00.000Z',
      state: 'REVOKED',
      acceptedEngagementId: null,
    };
    const application = {
      id: applicationId,
      slotId,
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
  const slotId = '55555555-5555-4555-8555-555555555555';
  const digest = 'd'.repeat(64);
  it('records consent with a strict body and a key, and the result must name the same exact terms', async () => {
    const consent = {
      id: '66666666-6666-4666-8666-666666666666',
      participantId,
      slotId,
      termsVersionId,
      termsDigest: digest,
      consentedAt: '2026-10-27T00:00:00.000Z',
    };
    const recordConsent = vi.fn(async () => ({ status: 'EXECUTED', consent }));
    const handlers = createWorkHandlers(host({ recordConsent }));
    const request = { slotId, termsVersionId, termsDigest: digest };
    const ok = await handlers.CONSENT(post('/api/v1/work/consents', request));
    expect(ok.status).toBe(200);
    expect(recordConsent).toHaveBeenCalledWith({
      actor,
      input: request,
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
    for (const bad of [
      { ...request, extra: 1 },
      { ...request, termsDigest: 'short' },
      { slotId, termsVersionId },
    ])
      expect((await handlers.CONSENT(post('/api/v1/work/consents', bad))).status).toBe(422);
    const drift = createWorkHandlers(
      host({
        recordConsent: async () => ({
          status: 'EXECUTED',
          consent: { ...consent, termsDigest: 'e'.repeat(64) },
        }),
      }),
    );
    expect((await drift.CONSENT(post('/api/v1/work/consents', request))).status).toBe(503);
  });
  const committed = () => {
    const terms = raidTerms();
    const snapshot = TermsSnapshotSchema.parse({
      id: termsVersionId,
      guildId: 'synthetic-guild',
      revision: 1,
      scope: '{}',
      acceptanceCriteria: terms.acceptanceCriteria,
      requiredSkills: terms.requiredSkills,
      roster: [{ participantId, responsibility: 'PRIMARY_EXECUTOR', consentRef: 'consent-1' }],
      rewards: terms.rewards.map((r) => ({
        ...r,
        beneficiaryParticipantId: participantId,
        beneficiaryRef: 'simulated-beneficiary:' + participantId,
      })),
      deadlines: {
        preparation: terms.deadlines.preparation,
        submission: terms.deadlines.submission,
        review: terms.deadlines.review,
        operationalClosure: terms.deadlines.operationalClosure,
      },
      eligibilityPolicyVersion: 'root-skill-admission-v1',
      allowedToolsPolicyVersion: 'p1',
      revisionPolicyVersion: 'p2',
      withdrawalPolicyVersion: 'p3',
      terminationPolicyVersion: 'p4',
      rubricVersion: null,
      rightsPolicyVersion: 'p5',
      reviewPolicyVersion: 'p6',
      disputePolicyVersion: 'p7',
      finalityPolicyVersion: 'p8',
      createdAt: '2026-10-27T00:00:00.000Z',
    });
    return {
      status: 'EXECUTED',
      fundingMode: 'SIMULATED',
      generation: 1,
      offerId: null as string | null,
      engagement: {
        id: engagementId,
        guildId: 'synthetic-guild',
        revision: 1,
        state: 'ACCESS_PENDING',
        source: { kind: 'RAID_SLOT', raidSlotId: slotId },
        acceptedTerms: snapshot,
      },
    };
  };
  it('accepts a Raid with a strict body, and the committed engagement must be for the requested slot and terms', async () => {
    const commitEngagement = vi.fn(async () => committed());
    const handlers = createWorkHandlers(host({ commitEngagement }));
    const request = { slotId, termsVersionId };
    const ok = await handlers.ACCEPT(post('/api/v1/work/engagements', request));
    expect(ok.status).toBe(200);
    expect(commitEngagement).toHaveBeenCalledWith({
      actor,
      input: request,
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
    const offerId = '77777777-7777-4777-8777-777777777777';
    // The result must name the offer that was accepted: none for a direct acceptance, the requested one otherwise.
    expect((await handlers.ACCEPT(post('/x', { ...request, offerId }))).status).toBe(503);
    const throughOffer = createWorkHandlers(
      host({ commitEngagement: async () => ({ ...committed(), offerId }) }),
    );
    expect((await throughOffer.ACCEPT(post('/x', { ...request, offerId }))).status).toBe(200);
    expect((await throughOffer.ACCEPT(post('/x', request))).status).toBe(503);
    const otherOffer = createWorkHandlers(
      host({
        commitEngagement: async () => ({
          ...committed(),
          offerId: '88888888-8888-4888-8888-888888888888',
        }),
      }),
    );
    expect((await otherOffer.ACCEPT(post('/x', { ...request, offerId }))).status).toBe(503);
    for (const bad of [{ ...request, extra: 1 }, { slotId }, { ...request, offerId: 'nope' }])
      expect((await handlers.ACCEPT(post('/x', bad))).status).toBe(422);
    const wrongSlot = createWorkHandlers(
      host({
        commitEngagement: async () => {
          const result = committed();
          result.engagement.source = { kind: 'RAID_SLOT', raidSlotId: 'another-slot' };
          return result;
        },
      }),
    );
    expect((await wrongSlot.ACCEPT(post('/x', request))).status).toBe(503);
    const rejected = createWorkHandlers(
      host({
        commitEngagement: async () => {
          throw new WorkError('ELIGIBILITY_REJECTED');
        },
      }),
    );
    expect((await rejected.ACCEPT(post('/x', request))).status).toBe(403);
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
    // A host result for other terms is never forwarded either.
    const otherTerms = createWorkHandlers(
      host({
        submitApplication: async () => ({
          status: 'EXECUTED',
          application: { ...application, termsVersionId: '88888888-8888-4888-8888-888888888888' },
        }),
      }),
    );
    expect((await otherTerms.APPLY(post('/api/v1/work/applications', request))).status).toBe(503);
    // A slot that does not carry the requested terms is refused by the command and answered as changed terms.
    const mismatched = createWorkHandlers(
      host({
        submitApplication: async () => {
          throw new WorkError('TERMS_VERSION_CHANGED');
        },
      }),
    );
    const pair = await mismatched.APPLY(
      post('/api/v1/work/applications', {
        ...request,
        termsVersionId: '88888888-8888-4888-8888-888888888888',
      }),
    );
    expect(pair.status).toBe(409);
    expect(await error(pair)).toMatchObject({ code: 'TERMS_VERSION_CHANGED' });
    const full = createWorkHandlers(
      host({
        submitApplication: async () => {
          throw new WorkError('APPLICATION_LIMIT');
        },
      }),
    );
    expect((await full.APPLY(post('/api/v1/work/applications', request))).status).toBe(409);
  });
  it('starts an engagement from its path with an empty body and a key, and the result must match', async () => {
    const started = {
      status: 'EXECUTED',
      engagement: { id: engagementId, state: 'IN_PROGRESS', revision: 2 },
    };
    const startEngagement = vi.fn(async () => started);
    const handlers = createWorkHandlers(host({ startEngagement }));
    const ok = await handlers.START(post('/x', {}), engagementId);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(started);
    expect(startEngagement).toHaveBeenCalledWith({
      actor,
      input: { engagementId },
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
    expect((await handlers.START(post('/x', { extra: 1 }), engagementId)).status).toBe(422);
    expect((await handlers.START(post('/x', {}), 'not-a-uuid')).status).toBe(422);
    const other = createWorkHandlers(
      host({
        startEngagement: async () => ({
          ...started,
          engagement: { ...started.engagement, id: '77777777-7777-4777-8777-777777777777' },
        }),
      }),
    );
    expect((await other.START(post('/x', {}), engagementId)).status).toBe(503);
    const notReady = createWorkHandlers(
      host({
        startEngagement: async () => {
          throw new WorkError('RESOURCES_NOT_READY');
        },
      }),
    );
    const unavailable = await notReady.START(post('/x', {}), engagementId);
    expect(unavailable.status).toBe(409);
    expect(await error(unavailable)).toMatchObject({ code: 'SETUP_NOT_READY', retryable: false });
  });
});
