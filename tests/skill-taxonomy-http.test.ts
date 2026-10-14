import { expect, it, vi, afterEach } from 'vitest';
import {
  createSkillTaxonomyHandlers,
  SkillTaxonomyHttpError,
  type SkillTaxonomyHttpHost,
} from '../src/skills/taxonomy-http';
import { SkillTaxonomyStorageError } from '../src/skills/taxonomy-storage-contracts';
import { SkillClaimContractError } from '../src/skills/contracts';
import { CommandReceiptError } from '../src/command-receipts';
const actor = { accountId: 'actual-admin', sessionHash: 'a'.repeat(64) };
const skills = [
  {
    id: 'frontend',
    domain: 'software.frontend',
    name: 'Frontend',
    status: 'ACTIVE',
    aliases: ['frontend', 'web-ui'],
  },
];
const input = { expectedRevision: 0, skills };
const taxonomy = {
  version: 'v1',
  id: 'actual-catalog',
  revision: 1,
  state: 'PUBLISHED',
  publishedByAccountId: actor.accountId,
  publishedAt: '2026-10-14T00:00:00.000Z',
  skills,
};
const saved = {
  version: 'v1',
  status: 'EXECUTED',
  taxonomy,
  writesAvailable: true,
  unavailableReason: null,
};
function request(body: unknown = input, headers: Record<string, string> = {}) {
  return new Request('https://raid.example/api/v1/admin/skill-taxonomies/actual-catalog', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://raid.example',
      'idempotency-key': 'original-key',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
function fixture(patch: Partial<SkillTaxonomyHttpHost> = {}) {
  const host: SkillTaxonomyHttpHost = {
    version: 'v1',
    actor: vi.fn(async () => actor),
    checkOrigin: vi.fn(() => {}),
    rateLimit: vi.fn(async () => {}),
    publish: vi.fn(async () => saved),
    requestId: () => 'correlation-1',
    ...patch,
  };
  return { host, api: createSkillTaxonomyHandlers(host) };
}
async function denied(r: Response, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(r.headers.get('vary')).toBe('Cookie');
  const body = await r.json();
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBeTruthy();
  expect(JSON.stringify(body)).not.toContain('PRIVATE-SECRET');
}
afterEach(() => vi.useRealTimers());
it('publishes normalized categories bound to URL, current server actor and exact original command identity', async () => {
  const { host, api } = fixture();
  const r = await api.POST(
    request({
      ...input,
      skills: [{ ...skills[0], name: ' Frontend ', aliases: [' Frontend ', 'WEB-UI'] }],
    }),
    Promise.resolve('actual-catalog'),
  );
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(r.headers.get('vary')).toBe('Cookie');
  expect(await r.json()).toEqual(saved);
  expect(host.publish).toHaveBeenCalledWith({
    actor,
    input: { ...input, taxonomyId: 'actual-catalog' },
    idempotencyKey: 'original-key',
    requestId: 'correlation-1',
  });
});
it('keeps original publication replay available with new writes disabled', async () => {
  const value = {
    ...saved,
    status: 'REPLAYED',
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  };
  const { api } = fixture({ publish: async () => value });
  expect(await (await api.POST(request(), 'actual-catalog')).json()).toEqual(value);
});
it.each([401, 403, 429] as const)(
  'denies current authority %i before publication',
  async (status) => {
    const { api, host } = fixture({
      actor: async () => {
        throw new SkillTaxonomyHttpError(status);
      },
    });
    await denied(
      await api.POST(request(), 'actual-catalog'),
      status,
      status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'FORBIDDEN' : 'RATE_LIMITED',
    );
    expect(host.publish).not.toHaveBeenCalled();
  },
);
it('checks origin and account rate before consuming command bytes', async () => {
  const first = fixture({
    checkOrigin: () => {
      throw new SkillTaxonomyHttpError(403);
    },
  });
  await denied(await first.api.POST(request(), 'actual-catalog'), 403, 'FORBIDDEN');
  expect(first.host.actor).not.toHaveBeenCalled();
  const limited = fixture({
    rateLimit: async () => {
      throw new SkillTaxonomyHttpError(429);
    },
  });
  await denied(await limited.api.POST(request(), 'actual-catalog'), 429, 'RATE_LIMITED');
  expect(limited.host.publish).not.toHaveBeenCalled();
});
it.each([
  'taxonomyId',
  'actor',
  'accountId',
  'isAdmin',
  'publishedByAccountId',
  'publishedAt',
  'assessedRank',
  'allowNewWrites',
  'canPublish',
])('rejects client %s authority', async (field) => {
  const { api, host } = fixture();
  await denied(
    await api.POST(request({ ...input, [field]: 'PRIVATE-SECRET' }), 'actual-catalog'),
    422,
    'INVALID_COMMAND',
  );
  expect(host.publish).not.toHaveBeenCalled();
});
it.each([
  'duplicate-id',
  'duplicate-alias',
  'missing-alias',
  'invalid-status',
  'excessive-revision',
])('rejects invalid catalog %s before storage', async (kind) => {
  const body = structuredClone(input);
  if (kind === 'duplicate-id') body.skills.push({ ...skills[0], aliases: ['other'] });
  if (kind === 'duplicate-alias') body.skills.push({ ...skills[0], id: 'other' });
  if (kind === 'missing-alias') body.skills[0].aliases = [];
  if (kind === 'invalid-status') body.skills[0].status = 'VERIFIED';
  if (kind === 'excessive-revision') body.expectedRevision = 2147483647;
  const { api, host } = fixture();
  await denied(await api.POST(request(body), 'actual-catalog'), 422, 'INVALID_COMMAND');
  expect(host.publish).not.toHaveBeenCalled();
});
it.each([
  'wrong-id',
  'wrong-revision',
  'wrong-publisher',
  'wrong-name',
  'wrong-alias-order',
  'extra-field',
  'inconsistent-availability',
])('fails closed on %s acknowledgment without exposing unbound data', async (kind) => {
  const value = structuredClone(saved);
  if (kind === 'wrong-id') value.taxonomy.id = 'PRIVATE-SECRET';
  if (kind === 'wrong-revision') value.taxonomy.revision++;
  if (kind === 'wrong-publisher') value.taxonomy.publishedByAccountId = 'other-admin';
  if (kind === 'wrong-name') value.taxonomy.skills[0].name = 'PRIVATE-SECRET';
  if (kind === 'wrong-alias-order') value.taxonomy.skills[0].aliases.reverse();
  if (kind === 'extra-field') Object.assign(value.taxonomy, { assessedRank: 'S' });
  if (kind === 'inconsistent-availability') value.writesAvailable = false;
  const { api } = fixture({ publish: async () => value });
  await denied(await api.POST(request(), 'actual-catalog'), 503, 'SERVICE_UNAVAILABLE');
});
it.each([
  [new SkillTaxonomyStorageError('AUTHENTICATION_REQUIRED'), 401, 'AUTHENTICATION_REQUIRED'],
  [new SkillTaxonomyStorageError('ACCOUNT_RESTRICTED'), 403, 'ACCOUNT_RESTRICTED'],
  [new SkillTaxonomyStorageError('FORBIDDEN'), 403, 'FORBIDDEN'],
  [new SkillTaxonomyStorageError('WRITES_DISABLED'), 503, 'SERVICE_UNAVAILABLE'],
  [new SkillClaimContractError('REVISION_CHANGED'), 409, 'REVISION_CHANGED'],
  [new SkillClaimContractError('HISTORY_CONFLICT'), 422, 'INVALID_COMMAND'],
  [new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
  [new Error('PRIVATE-SECRET driver password'), 503, 'SERVICE_UNAVAILABLE'],
] as const)('sanitizes %s under canonical private error envelope', async (error, status, code) => {
  const { api } = fixture({
    publish: async () => {
      throw error;
    },
  });
  await denied(await api.POST(request(), 'actual-catalog'), status, code);
});
it.each(['', 'invalid/id', 'bad id'])(
  'rejects invalid resource %s and idempotency keys before storage',
  async (id) => {
    const { api, host } = fixture();
    await denied(await api.POST(request(), id), 422, 'INVALID_COMMAND');
    await denied(
      await api.POST(request(input, { 'idempotency-key': '' }), 'actual-catalog'),
      422,
      'INVALID_COMMAND',
    );
    expect(host.publish).not.toHaveBeenCalled();
  },
);
it('rejects malformed trusted actor and safely supplies correlation when the host fails', async () => {
  const bad = fixture({
    actor: async () => ({ ...actor, isAdmin: true }),
    requestId: () => {
      throw new Error('PRIVATE-SECRET');
    },
  });
  await denied(await bad.api.POST(request(), 'actual-catalog'), 503, 'SERVICE_UNAVAILABLE');
  expect(bad.host.publish).not.toHaveBeenCalled();
});
it.each([
  [{ 'content-type': 'text/plain' }, 415],
  [{ 'content-length': '16385' }, 413],
  [{ 'content-length': 'bad' }, 422],
] as const)('rejects unsupported or unbounded JSON before publication', async (headers, status) => {
  const { api, host } = fixture();
  await denied(
    await api.POST(request(input, headers), 'actual-catalog'),
    status,
    'INVALID_COMMAND',
  );
  expect(host.publish).not.toHaveBeenCalled();
});
it('enforces 16KiB streamed body bytes and fatal UTF8 without trusting content length', async () => {
  for (const bytes of [new Uint8Array(16385).fill(32), new Uint8Array([0xff])]) {
    const { api, host } = fixture();
    const r = request();
    const streamed = new Request(r.url, { method: 'POST', headers: r.headers, body: bytes });
    await denied(
      await api.POST(streamed, 'actual-catalog'),
      bytes.length > 16384 ? 413 : 422,
      'INVALID_COMMAND',
    );
    expect(host.publish).not.toHaveBeenCalled();
  }
});
it('cancels stalled body after the shared five-second deadline without publication', async () => {
  vi.useFakeTimers();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const r = new Request(request().url, {
    method: 'POST',
    headers: request().headers,
    body,
    duplex: 'half',
  } as RequestInit);
  const { api, host } = fixture();
  const pending = api.POST(r, 'actual-catalog');
  await vi.advanceTimersByTimeAsync(5001);
  await denied(await pending, 408, 'INVALID_COMMAND');
  expect(canceled).toBe(true);
  expect(host.publish).not.toHaveBeenCalled();
});
