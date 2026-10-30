import { describe, expect, it, vi } from 'vitest';
import { WorkError } from '../src/work-loop/contracts';
import { CommandReceiptError } from '../src/command-receipts';
import { WorkHttpError } from '../src/work-http/workspace-http';
import { createClosureHandlers, type ClosureHttpHost } from '../src/work-http/closure-http';

const actor = { accountId: 'operator-1', sessionHash: 'a'.repeat(64) };
const engagementId = '11111111-1111-4111-8111-111111111111';
const closure = {
  engagementId,
  finalState: 'TERMINATED',
  reason: 'REVIEW_TIMEOUT',
  financialResolution: 'OPEN',
  closedAt: '2026-10-30T00:00:00.000Z',
};
function host(overrides: Partial<ClosureHttpHost> = {}): ClosureHttpHost {
  return {
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => actor,
    checkOrigin: () => {},
    rateLimit: () => {},
    closeEngagement: async () => ({ status: 'EXECUTED', closure }),
    ...overrides,
  };
}
const post = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/v1/work/engagements/x/closure', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: JSON.stringify(payload),
  });
const error = async (response: Response) => (await response.json()).error;

describe('T024 closure HTTP boundary', () => {
  it('passes the actor, key, target and observed revision to the command and returns the closure privately', async () => {
    const closeEngagement = vi.fn(async () => ({ status: 'EXECUTED', closure }));
    const handlers = createClosureHandlers(host({ closeEngagement }));
    const response = await handlers.CLOSE(post({ expectedRevision: 3 }), engagementId);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ status: 'EXECUTED', closure });
    expect(closeEngagement).toHaveBeenCalledWith({
      actor,
      input: { engagementId, expectedRevision: 3 },
      idempotencyKey: 'key-1',
      requestId: 'request-1',
    });
  });
  it('requires origin, authentication and rate-limit approval before the command', async () => {
    const closeEngagement = vi.fn();
    for (const [status, code, overrides] of [
      [403, 'FORBIDDEN', { checkOrigin: () => Promise.reject(new WorkHttpError(403)) }],
      [401, 'AUTHENTICATION_REQUIRED', { actor: () => Promise.reject(new WorkHttpError(401)) }],
      [429, 'RATE_LIMITED', { rateLimit: () => Promise.reject(new WorkHttpError(429)) }],
    ] as const) {
      const handlers = createClosureHandlers(host({ closeEngagement, ...overrides }));
      const response = await handlers.CLOSE(post({ expectedRevision: 1 }), engagementId);
      expect(response.status).toBe(status);
      expect((await error(response)).code).toBe(code);
    }
    expect(closeEngagement).not.toHaveBeenCalled();
  });
  it('requires a UUID target, an idempotency key and a strict body', async () => {
    const closeEngagement = vi.fn();
    const handlers = createClosureHandlers(host({ closeEngagement }));
    expect((await handlers.CLOSE(post({ expectedRevision: 1 }), 'not-a-uuid')).status).toBe(422);
    const noKey = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect((await handlers.CLOSE(noKey, engagementId)).status).toBe(422);
    for (const bad of [{}, { expectedRevision: 0 }, { expectedRevision: 1, reason: 'x' }])
      expect((await handlers.CLOSE(post(bad), engagementId)).status).toBe(422);
    expect(
      (await handlers.CLOSE(post({ expectedRevision: 1 }, { 'idempotency-key': '' }), engagementId))
        .status,
    ).toBe(422);
    expect(closeEngagement).not.toHaveBeenCalled();
  });
  it('rejects query strings and foreign methods', async () => {
    const closeEngagement = vi.fn();
    const handlers = createClosureHandlers(host({ closeEngagement }));
    const get = await handlers.CLOSE(
      new Request('http://localhost/x', { method: 'GET' }),
      engagementId,
    );
    expect(get.status).toBe(405);
    const query = new Request('http://localhost/x?force=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect((await handlers.CLOSE(query, engagementId)).status).toBe(422);
    expect(closeEngagement).not.toHaveBeenCalled();
  });
  it.each([
    ['FORBIDDEN', 403, 'FORBIDDEN'],
    ['WRITES_DISABLED', 503, 'NOT_AVAILABLE'],
    ['REVISION_CONFLICT', 409, 'REVISION_CHANGED'],
    ['ENGAGEMENT_STATE', 409, 'REVISION_CHANGED'],
    ['DEADLINE_NOT_REACHED', 409, 'REVISION_CHANGED'],
    ['UNAUTHENTICATED', 401, 'AUTHENTICATION_REQUIRED'],
  ] as const)('maps %s without leaking detail', async (workCode, status, code) => {
    const handlers = createClosureHandlers(
      host({
        closeEngagement: async () => {
          throw new WorkError(workCode);
        },
      }),
    );
    const response = await handlers.CLOSE(post({ expectedRevision: 1 }), engagementId);
    expect((await error(response)).code).toBe(code);
    expect(response.status).toBe(status);
  });
  it('reports a reused idempotency key and a receipt storage outage with the shared codes', async () => {
    const reused = createClosureHandlers(
      host({
        closeEngagement: async () => {
          throw new CommandReceiptError('IDEMPOTENCY_KEY_REUSED');
        },
      }),
    );
    expect(
      (await error(await reused.CLOSE(post({ expectedRevision: 1 }), engagementId))).code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    const outage = createClosureHandlers(
      host({
        closeEngagement: async () => {
          throw new CommandReceiptError('STORAGE_UNAVAILABLE');
        },
      }),
    );
    expect(
      (await error(await outage.CLOSE(post({ expectedRevision: 1 }), engagementId))).code,
    ).toBe('SERVICE_UNAVAILABLE');
  });
  it('fails closed when the host result breaks its schema or describes another engagement', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    for (const result of [
      { status: 'EXECUTED', closure: { ...closure, engagementId: other } },
      { status: 'EXECUTED', closure: { ...closure, financialResolution: 'SETTLED' } },
      { status: 'EXECUTED', closure, extra: true },
    ]) {
      const handlers = createClosureHandlers(host({ closeEngagement: async () => result }));
      const response = await handlers.CLOSE(post({ expectedRevision: 1 }), engagementId);
      expect(response.status).toBe(503);
      expect((await error(response)).code).toBe('SERVICE_UNAVAILABLE');
    }
  });
  it('refuses a host that does not implement the contract', () => {
    expect(() =>
      createClosureHandlers({ ...host(), closeEngagement: undefined } as never),
    ).toThrow();
    expect(() => createClosureHandlers({ ...host(), version: 'v2' } as never)).toThrow();
  });
});
