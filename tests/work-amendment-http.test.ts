import { describe, expect, it, vi } from 'vitest';
import { WorkError } from '../src/work-loop/contracts';
import { CommandReceiptError } from '../src/command-receipts';
import { WorkHttpError } from '../src/work-http/workspace-http';
import { createAmendmentHandlers, type AmendmentHttpHost } from '../src/work-http/amendment-http';
import { canonicalRequestDigest } from '../src/command-receipts';
import { raidTerms } from './helpers/raid-terms-fixture';

const actor = { accountId: 'founder-1', sessionHash: 'a'.repeat(64) };
const engagementId = '11111111-1111-4111-8111-111111111111';
const amendmentId = '33333333-3333-4333-8333-333333333333';
const expiresAt = '2026-12-01T00:00:00.000Z';
/** A complete, schema-valid TermsSnapshot for the amended engagement. */
function snapshot(over: Record<string, unknown> = {}) {
  const t = raidTerms();
  return {
    id: '44444444-4444-4444-8444-444444444444',
    guildId: 'synthetic-guild',
    revision: 1,
    scope: 'Write the setup guide.',
    acceptanceCriteria: ['Guide verified on a clean machine.'],
    requiredSkills: [],
    roster: [
      {
        participantId: '55555555-5555-4555-8555-555555555555',
        responsibility: 'Author',
        consentRef: 'consent-1',
      },
    ],
    rewards: [
      {
        policy: t.rewards[0].policy,
        amount: '1500000000',
        beneficiaryParticipantId: '55555555-5555-4555-8555-555555555555',
        beneficiaryRef: 'beneficiary-1',
      },
    ],
    deadlines: {
      preparation: '2026-11-02T00:00:00.000Z',
      submission: '2026-11-10T00:00:00.000Z',
      review: '2026-11-15T00:00:00.000Z',
      operationalClosure: '2026-11-20T00:00:00.000Z',
    },
    eligibilityPolicyVersion: 'e1',
    allowedToolsPolicyVersion: 't1',
    revisionPolicyVersion: 'r1',
    withdrawalPolicyVersion: 'w1',
    terminationPolicyVersion: 'x1',
    rubricVersion: null,
    rightsPolicyVersion: 'g1',
    reviewPolicyVersion: 'v1',
    disputePolicyVersion: 'd1',
    finalityPolicyVersion: 'f1',
    createdAt: '2026-10-30T00:00:00.000Z',
    ...over,
  };
}
const terms = snapshot();
const digest = canonicalRequestDigest(terms);
const amendment = (state = 'PROPOSED', over: Record<string, unknown> = {}) => ({
  id: amendmentId,
  engagementId,
  sequence: 1,
  state,
  digest,
  terms,
  expiresAt,
  requiresFunding: true,
  ...over,
});
function host(over: Partial<AmendmentHttpHost> = {}): AmendmentHttpHost {
  return {
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => actor,
    checkOrigin: () => {},
    rateLimit: () => {},
    desk: async () => ({ version: 'v1', proposalsAvailable: true, engagements: [] }),
    propose: async () => ({ status: 'EXECUTED', amendment: amendment() }),
    respond: async () => ({ status: 'EXECUTED', amendment: amendment('ACCEPTED') }),
    withdraw: async () => ({ status: 'EXECUTED', amendment: amendment('WITHDRAWN') }),
    ...over,
  };
}
const post = (payload: unknown, headers: Record<string, string> = {}, url = 'http://localhost/x') =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: JSON.stringify(payload),
  });
const get = (url = 'http://localhost/x') => new Request(url, { method: 'GET' });
const err = async (r: Response) => (await r.json()).error;
const propose = {
  engagementId,
  changes: { rewards: [{ amount: '1500000000' }] },
  expiresAt,
};

describe('T025 amendment HTTP boundary', () => {
  it('proposes with the actor, key and strict input, and returns the amendment privately', async () => {
    const proposeFn = vi.fn(async () => ({ status: 'EXECUTED', amendment: amendment() }));
    const h = createAmendmentHandlers(host({ propose: proposeFn }));
    const r = await h.PROPOSE(post(propose));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await r.json()).amendment.state).toBe('PROPOSED');
    expect(proposeFn).toHaveBeenCalledWith({
      actor,
      input: propose,
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
  });
  it('responds with the digest the member saw, and the command input stays the two-key storage shape', async () => {
    const respond = vi.fn<AmendmentHttpHost['respond']>(async () => ({
      status: 'EXECUTED',
      amendment: amendment('ACCEPTED'),
    }));
    const h = createAmendmentHandlers(host({ respond }));
    const r = await h.RESPOND(post({ decision: 'ACCEPT', digest }), amendmentId);
    expect(r.status).toBe(200);
    expect(respond).toHaveBeenCalledWith(
      {
        actor,
        input: { amendmentId, decision: 'ACCEPT' },
        idempotencyKey: 'key-1',
        requestId: 'request-1',
      },
      digest,
    );
    const declined = vi.fn<AmendmentHttpHost['respond']>(async () => ({
      status: 'EXECUTED',
      amendment: amendment('DECLINED'),
    }));
    const d = createAmendmentHandlers(host({ respond: declined }));
    expect((await d.RESPOND(post({ decision: 'DECLINE' }), amendmentId)).status).toBe(200);
    expect(declined.mock.calls[0][1]).toBeNull();
  });
  it('withdraws by id with an empty body', async () => {
    const withdraw = vi.fn(async () => ({ status: 'EXECUTED', amendment: amendment('WITHDRAWN') }));
    const h = createAmendmentHandlers(host({ withdraw }));
    expect((await h.WITHDRAW(post({}), amendmentId)).status).toBe(200);
    expect(withdraw).toHaveBeenCalledWith({
      actor,
      input: { amendmentId },
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
  });
  it('reads the desk privately with GET only', async () => {
    const h = createAmendmentHandlers(host());
    const r = await h.DESK(get());
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(await r.json()).toEqual({ version: 'v1', proposalsAvailable: true, engagements: [] });
    expect((await h.DESK(post({}))).status).toBe(405);
    expect((await h.DESK(get('http://localhost/x?engagementId=1'))).status).toBe(422);
  });
  it('requires origin, authentication and the right throttle before any command', async () => {
    const propose_ = vi.fn();
    const kinds: string[] = [];
    for (const [status, code, over] of [
      [403, 'FORBIDDEN', { checkOrigin: () => Promise.reject(new WorkHttpError(403)) }],
      [401, 'AUTHENTICATION_REQUIRED', { actor: () => Promise.reject(new WorkHttpError(401)) }],
      [429, 'RATE_LIMITED', { rateLimit: () => Promise.reject(new WorkHttpError(429)) }],
    ] as const) {
      const h = createAmendmentHandlers(host({ propose: propose_, ...over }));
      const r = await h.PROPOSE(post(propose));
      expect(r.status).toBe(status);
      expect((await err(r)).code).toBe(code);
    }
    expect(propose_).not.toHaveBeenCalled();
    const h = createAmendmentHandlers(host({ rateLimit: (_a, kind) => void kinds.push(kind) }));
    await h.DESK(get());
    await h.PROPOSE(post(propose));
    expect(kinds).toEqual(['read', 'command']);
  });
  it('rejects a read of a GET with no origin check but a cross-site write', async () => {
    const checkOrigin = vi.fn();
    const h = createAmendmentHandlers(host({ checkOrigin }));
    await h.DESK(get());
    expect(checkOrigin).not.toHaveBeenCalled();
    await h.WITHDRAW(post({}), amendmentId);
    expect(checkOrigin).toHaveBeenCalledTimes(1);
  });
  it('requires UUID targets, an idempotency key, a strict bounded body and no query', async () => {
    const respond = vi.fn();
    const propose_ = vi.fn();
    const h = createAmendmentHandlers(host({ respond, propose: propose_ }));
    expect((await h.RESPOND(post({ decision: 'DECLINE' }), 'not-a-uuid')).status).toBe(422);
    const noKey = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(propose),
    });
    expect((await h.PROPOSE(noKey)).status).toBe(422);
    for (const bad of [
      {},
      { ...propose, extra: 1 },
      { ...propose, changes: {} },
      { ...propose, engagementId: 'x' },
      { ...propose, expiresAt: 'tomorrow' },
      { ...propose, changes: { rewards: [{ amount: '0' }] } },
    ])
      expect((await h.PROPOSE(post(bad))).status).toBe(422);
    for (const bad of [
      {},
      { decision: 'ACCEPT' },
      { decision: 'ACCEPT', digest: 'short' },
      { decision: 'DECLINE', digest },
      { decision: 'MAYBE' },
      { decision: 'ACCEPT', digest, amendmentId },
    ])
      expect((await h.RESPOND(post(bad), amendmentId)).status).toBe(422);
    expect((await h.PROPOSE(post(propose, {}, 'http://localhost/x?force=1'))).status).toBe(422);
    const huge = post({ ...propose, scope: 'x'.repeat(70000) });
    expect((await h.PROPOSE(huge)).status).toBe(413);
    const wrongMethod = new Request('http://localhost/x', { method: 'GET' });
    expect((await h.RESPOND(wrongMethod, amendmentId)).status).toBe(405);
    expect(respond).not.toHaveBeenCalled();
    expect(propose_).not.toHaveBeenCalled();
  });
  it.each([
    ['FORBIDDEN', 403, 'FORBIDDEN'],
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['WRITES_DISABLED', 503, 'NOT_AVAILABLE'],
    ['AMENDMENT_UNAVAILABLE', 409, 'NO_LONGER_OPEN'],
    ['AMENDMENT_EXISTS', 409, 'REVISION_CHANGED'],
    ['ENGAGEMENT_STATE', 409, 'REVISION_CHANGED'],
    ['CONSENT_REQUIRED', 409, 'CONSENT_REQUIRED'],
    ['FUNDING_REQUIRED', 409, 'FUNDING_NOT_VERIFIED'],
    ['UNAUTHENTICATED', 401, 'AUTHENTICATION_REQUIRED'],
    ['STORAGE_CONTRACT', 503, 'SERVICE_UNAVAILABLE'],
    ['SOMETHING_INTERNAL', 503, 'SERVICE_UNAVAILABLE'],
  ] as const)('maps %s without leaking detail', async (workCode, status, code) => {
    const fail = async () => {
      throw new WorkError(workCode as never);
    };
    const h = createAmendmentHandlers(host({ propose: fail, respond: fail, withdraw: fail }));
    for (const r of [
      await h.PROPOSE(post(propose)),
      await h.RESPOND(post({ decision: 'ACCEPT', digest }), amendmentId),
      await h.WITHDRAW(post({}), amendmentId),
    ]) {
      expect(r.status).toBe(status);
      const e = await err(r);
      expect(e.code).toBe(code);
      expect(JSON.stringify(e)).not.toContain(workCode === code ? 'zzz' : workCode);
    }
  });
  it('reports a reused key and a receipt outage with the shared codes', async () => {
    const reused = createAmendmentHandlers(
      host({
        propose: async () => {
          throw new CommandReceiptError('IDEMPOTENCY_KEY_REUSED');
        },
      }),
    );
    expect((await err(await reused.PROPOSE(post(propose)))).code).toBe('IDEMPOTENCY_KEY_REUSED');
    const outage = createAmendmentHandlers(
      host({
        propose: async () => {
          throw new CommandReceiptError('STORAGE_UNAVAILABLE');
        },
      }),
    );
    expect((await err(await outage.PROPOSE(post(propose)))).code).toBe('SERVICE_UNAVAILABLE');
  });
  it('fails closed when a result breaks its schema or describes another request', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const bad = [
      { status: 'EXECUTED', amendment: amendment('PROPOSED', { engagementId: other }) },
      { status: 'EXECUTED', amendment: amendment('PROPOSED', { digest: 'f'.repeat(64) }) },
      { status: 'EXECUTED', amendment: amendment('PROPOSED'), extra: true },
      // The stored terms must carry the reward the founder asked for.
      {
        status: 'EXECUTED',
        amendment: amendment('PROPOSED', {
          terms: snapshot({
            rewards: [{ ...terms.rewards[0], amount: '1' }],
          }),
        }),
      },
    ];
    for (const result of bad) {
      const h = createAmendmentHandlers(host({ propose: async () => result }));
      const r = await h.PROPOSE(post(propose));
      expect(r.status).toBe(503);
      expect((await err(r)).code).toBe('SERVICE_UNAVAILABLE');
    }
    // A response must report the decision asked for, for the amendment asked about, bound to the digest seen.
    const wrongState = createAmendmentHandlers(
      host({ respond: async () => ({ status: 'EXECUTED', amendment: amendment('DECLINED') }) }),
    );
    expect(
      (await wrongState.RESPOND(post({ decision: 'ACCEPT', digest }), amendmentId)).status,
    ).toBe(503);
    const otherId = '99999999-9999-4999-8999-999999999999';
    const wrongId = createAmendmentHandlers(
      host({
        respond: async () => ({ status: 'EXECUTED', amendment: amendment('ACCEPTED') }),
      }),
    );
    expect((await wrongId.RESPOND(post({ decision: 'ACCEPT', digest }), otherId)).status).toBe(503);
    const wrongDigest = createAmendmentHandlers(host());
    expect(
      (await wrongDigest.RESPOND(post({ decision: 'ACCEPT', digest: 'b'.repeat(64) }), amendmentId))
        .status,
    ).toBe(503);
    const notWithdrawn = createAmendmentHandlers(
      host({ withdraw: async () => ({ status: 'EXECUTED', amendment: amendment('ACCEPTED') }) }),
    );
    expect((await notWithdrawn.WITHDRAW(post({}), amendmentId)).status).toBe(503);
    const badDesk = createAmendmentHandlers(host({ desk: async () => ({ version: 'v1' }) }));
    expect((await badDesk.DESK(get())).status).toBe(503);
  });
  it('answers a replay with the recorded result even after the proposal has moved on', async () => {
    const h = createAmendmentHandlers(
      host({
        propose: async () => ({ status: 'REPLAYED', amendment: amendment('ACCEPTED') }),
      }),
    );
    const r = await h.PROPOSE(post(propose));
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('REPLAYED');
  });
  it('refuses a host that does not implement the contract', () => {
    expect(() => createAmendmentHandlers({ ...host(), propose: undefined } as never)).toThrow();
    expect(() => createAmendmentHandlers({ ...host(), version: 'v2' } as never)).toThrow();
  });
});
