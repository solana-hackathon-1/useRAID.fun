import { describe, expect, it, vi } from 'vitest';
import { CommandReceiptError } from '../src/command-receipts';
import { MetricsError } from '../src/metrics/contracts';
import { MetricsHttpError } from '../src/metrics/http';
import {
  createMetricsExclusionHandlers,
  type MetricsExclusionHttpHost,
} from '../src/metrics/exclusion-http';

const marker = {
  id: '11111111-1111-4111-8111-111111111111',
  subjectType: 'GUILD',
  subjectId: '22222222-2222-4222-8222-222222222222',
  reason: 'FIXTURE',
  evidenceRef: 'ticket-1',
  effect: 'EXCLUDE',
  supersedesMarkerId: null,
  actorAccountId: 'operator-1',
  recordedAt: '2026-11-13T10:00:00.000Z',
};
const body = {
  subjectType: 'GUILD',
  subjectId: marker.subjectId,
  reason: 'FIXTURE',
  evidenceRef: 'ticket-1',
  effect: 'EXCLUDE',
  supersedesMarkerId: null,
};
function host(overrides: Partial<MetricsExclusionHttpHost> = {}) {
  const set = vi.fn<MetricsExclusionHttpHost['set']>(async () => marker);
  const value: MetricsExclusionHttpHost = {
    version: 'v1',
    requestId: () => 'request-1',
    available: () => true,
    checkOrigin: () => {},
    authorize: async () => 'operator-1',
    rateLimit: async () => {},
    set,
    ...overrides,
  };
  return { value, set };
}
const post = (payload: unknown = body, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/v1/admin/metrics/exclusions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
const deny = (status: 401 | 403 | 429) => async () => {
  throw new MetricsHttpError(status);
};

describe('POST /api/v1/admin/metrics/exclusions', () => {
  it('is absent while the flag is off and never reaches authority or storage', async () => {
    const authorize = vi.fn(async () => 'operator-1');
    const { value, set } = host({ available: () => false, authorize });
    const response = await createMetricsExclusionHandlers(value).POST(post());
    expect(response.status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('refuses a wrong origin, signed-out caller, non-operator and throttled operator before storage', async () => {
    for (const [override, status] of [
      [
        {
          checkOrigin: () => {
            throw new MetricsHttpError(403);
          },
        },
        403,
      ],
      [{ authorize: deny(401) }, 401],
      [{ authorize: deny(403) }, 403],
      [{ rateLimit: deny(429) }, 429],
    ] as const) {
      const { value, set } = host(override as Partial<MetricsExclusionHttpHost>);
      const response = await createMetricsExclusionHandlers(value).POST(post());
      expect(response.status).toBe(status);
      expect(set).not.toHaveBeenCalled();
    }
  });

  it('does not read the body for a caller who is not an operator', async () => {
    const { value, set } = host({ authorize: deny(403) });
    const request = post();
    await createMetricsExclusionHandlers(value).POST(request);
    expect(request.bodyUsed).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects an invalid body, an extra field and a client-chosen actor or time', async () => {
    for (const payload of [
      '{not json',
      { ...body, reason: 'SUSPECTED' },
      { ...body, subjectType: 'USER' },
      { ...body, evidenceRef: '' },
      { ...body, effect: 'RELEASE' },
      { ...body, actorAccountId: 'someone-else' },
      { ...body, recordedAt: '2020-01-01T00:00:00.000Z' },
    ]) {
      const { value, set } = host();
      const response = await createMetricsExclusionHandlers(value).POST(post(payload));
      expect(response.status).toBe(422);
      expect(set).not.toHaveBeenCalled();
    }
  });

  it('requires a valid Idempotency-Key and maps a reused key to 409', async () => {
    for (const key of ['', 'has space', 'x'.repeat(201)]) {
      const { value, set } = host();
      const response = await createMetricsExclusionHandlers(value).POST(
        post(body, { 'idempotency-key': key }),
      );
      expect(response.status).toBe(422);
      expect(set).not.toHaveBeenCalled();
    }
    const { value } = host({
      set: async () => {
        throw new CommandReceiptError('IDEMPOTENCY_KEY_REUSED');
      },
    });
    const response = await createMetricsExclusionHandlers(value).POST(post());
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects a body that is not declared as JSON', async () => {
    const { value, set } = host();
    const response = await createMetricsExclusionHandlers(value).POST(
      post(body, { 'content-type': 'text/plain' }),
    );
    expect(response.status).toBe(415);
    expect(set).not.toHaveBeenCalled();
  });

  it('sets the marker as the authorized operator and answers 201 privately', async () => {
    const { value, set } = host();
    const response = await createMetricsExclusionHandlers(value).POST(post());
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(marker);
    expect(set).toHaveBeenCalledWith('operator-1', body, 'key-1', 'request-1');
  });

  it('maps a missing subject to 404 and a chain conflict to 409, and forwards nothing outside the schema', async () => {
    for (const [code, status] of [
      ['SUBJECT_NOT_FOUND', 404],
      ['CONFLICT', 409],
      ['STORAGE_CONTRACT', 503],
    ] as const) {
      const { value } = host({
        set: async () => {
          throw new MetricsError(code);
        },
      });
      expect((await createMetricsExclusionHandlers(value).POST(post())).status).toBe(status);
    }
    const { value } = host({ set: async () => ({ ...marker, secret: 'x' }) });
    expect((await createMetricsExclusionHandlers(value).POST(post())).status).toBe(503);
  });

  it('refuses other methods and a malformed host', async () => {
    const { value } = host();
    const response = await createMetricsExclusionHandlers(value).POST(
      new Request('http://localhost/x', { method: 'PUT' }),
    );
    expect(response.status).toBe(405);
    expect(() => createMetricsExclusionHandlers({ ...value, set: undefined } as never)).toThrow();
  });
});
