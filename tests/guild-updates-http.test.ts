import { describe, expect, it } from 'vitest';
import {
  createGuildUpdatesHandlers,
  GuildUpdatesHttpError,
  type GuildUpdatesHttpHost,
} from '../src/guild-profiles/guild-updates-http';
import { CommandReceiptError } from '../src/command-receipts/contracts';
import { GuildStorageError, type GuildActor } from '../src/guild-profiles/guild-storage-contracts';

const guildId = '11111111-1111-4111-8111-111111111111';
const otherGuildId = '99999999-9999-4999-8999-999999999999';
const updateId = '22222222-2222-4222-8222-222222222222';
const actor: GuildActor = { accountId: 'founder-1', sessionHash: 'a'.repeat(64) };
const managed = (overrides: Record<string, unknown> = {}) => ({
  version: 'v1',
  id: updateId,
  guildId,
  title: 'Shipped',
  body: 'We shipped.',
  state: 'DRAFT',
  authorAccountId: 'founder-1',
  createdAt: '2026-10-29T06:00:00.000Z',
  publishedAt: null,
  ...overrides,
});
const state = (updates = [managed()]) => ({
  version: 'v1',
  updates,
  writesAvailable: true,
  unavailableReason: null,
});
function host(overrides: Partial<GuildUpdatesHttpHost> = {}) {
  const calls: unknown[] = [];
  const value: GuildUpdatesHttpHost = {
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => (calls.push('actor'), actor),
    checkOrigin: () => void calls.push('origin'),
    rateLimit: async () => void calls.push('rateLimit'),
    list: async (who, id) => (calls.push(['list', who, id]), state()),
    draft: async (command) => (
      calls.push(['draft', command]),
      { status: 'EXECUTED', update: managed() }
    ),
    publish: async (command) => (
      calls.push(['publish', command]),
      {
        status: 'EXECUTED',
        update: managed({ state: 'PUBLISHED', publishedAt: '2026-10-29T07:00:00.000Z' }),
      }
    ),
    withdraw: async (command) => (
      calls.push(['withdraw', command]),
      { status: 'EXECUTED', update: managed({ state: 'WITHDRAWN' }) }
    ),
    ...overrides,
  };
  return { value, calls };
}
const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
  new Request('https://example.test' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: JSON.stringify(payload),
  });
const draftRequest = (
  payload: unknown = { guildId, title: 'Shipped', body: 'We shipped.' },
  h = {},
) => post('/api/v1/guild-updates', payload, h);
const stepRequest = (action: string, payload: unknown = { guildId, action }) =>
  post('/api/v1/guild-updates/' + updateId, payload);
const body = async (response: Response) => (await response.json()) as Record<string, any>;

describe('Guild updates management HTTP boundary', () => {
  it('drafts with origin, then the cookie-derived actor, then throttle; the actor never comes from the body', async () => {
    const { value, calls } = host();
    const response = await createGuildUpdatesHandlers(value).DRAFT(draftRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect((await body(response)).update.state).toBe('DRAFT');
    expect(calls.slice(0, 3)).toEqual(['origin', 'actor', 'rateLimit']);
    expect(calls[3]).toEqual([
      'draft',
      {
        actor,
        input: { guildId, title: 'Shipped', body: 'We shipped.' },
        idempotencyKey: 'key-1',
        requestId: 'request-1',
      },
    ]);
  });

  it('refuses a bad draft body or key before touching storage', async () => {
    const { value, calls } = host();
    const handlers = createGuildUpdatesHandlers(value);
    for (const payload of [
      { guildId, title: 'T', body: 'B', authorAccountId: 'x' },
      { guildId, title: 'T', body: 'B', actor: { accountId: 'x' } },
      { guildId, title: '', body: 'B' },
      { guildId: 'nope', title: 'T', body: 'B' },
      { title: 'T', body: 'B' },
    ]) {
      const response = await handlers.DRAFT(draftRequest(payload));
      expect(response.status, JSON.stringify(payload)).toBe(422);
    }
    const noKey = await handlers.DRAFT(
      new Request('https://example.test/api/v1/guild-updates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ guildId, title: 'T', body: 'B' }),
      }),
    );
    expect(noKey.status).toBe(422);
    const wrongType = await handlers.DRAFT(
      new Request('https://example.test/api/v1/guild-updates', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'idempotency-key': 'key-1' },
        body: '{}',
      }),
    );
    expect(wrongType.status).toBe(415);
    expect(calls.filter((c) => Array.isArray(c))).toEqual([]);
  });

  it('publishes and withdraws through one resource, binding the result to the request', async () => {
    const { value, calls } = host();
    const handlers = createGuildUpdatesHandlers(value);
    const published = await handlers.STEP(stepRequest('PUBLISH'), updateId);
    expect(published.status).toBe(200);
    expect((await body(published)).update.state).toBe('PUBLISHED');
    const withdrawn = await handlers.STEP(stepRequest('WITHDRAW'), updateId);
    expect((await body(withdrawn)).update.state).toBe('WITHDRAWN');
    const commands = calls.filter((c) => Array.isArray(c)) as [string, { input: unknown }][];
    expect(commands.map(([name]) => name)).toEqual(['publish', 'withdraw']);
    expect(commands[0][1].input).toEqual({ guildId, updateId });
    for (const [action, payload] of [
      ['PUBLISH', { guildId, action: 'DELETE' }],
      ['PUBLISH', { guildId, action: 'PUBLISH', extra: 1 }],
      ['PUBLISH', { action: 'PUBLISH' }],
    ] as const) {
      expect((await handlers.STEP(stepRequest(action, payload), updateId)).status).toBe(422);
    }
    expect((await handlers.STEP(stepRequest('PUBLISH'), 'not-a-uuid')).status).toBe(422);
  });

  it('never forwards a result for a different update, Guild or state', async () => {
    const wrong: Record<string, unknown>[] = [
      { id: '33333333-3333-4333-8333-333333333333' },
      { guildId: otherGuildId },
      { state: 'DRAFT' },
      { title: 'Different' },
      { secret: 'x' },
    ];
    for (const override of wrong) {
      const { value } = host({
        publish: async () => ({
          status: 'EXECUTED',
          update: managed({
            state: 'PUBLISHED',
            publishedAt: '2026-10-29T07:00:00.000Z',
            ...override,
          }),
        }),
      });
      const response = await createGuildUpdatesHandlers(value).STEP(
        stepRequest('PUBLISH'),
        updateId,
      );
      expect(response.status, JSON.stringify(override)).toBe(override.title ? 200 : 503);
    }
    for (const override of [
      { guildId: otherGuildId },
      { title: 'Different' },
      { state: 'PUBLISHED' },
    ]) {
      const { value } = host({
        draft: async () => ({ status: 'EXECUTED', update: managed(override) }),
      });
      expect((await createGuildUpdatesHandlers(value).DRAFT(draftRequest())).status).toBe(503);
    }
  });

  it('lists the caller’s view after authentication, with no origin check and strict query', async () => {
    const { value, calls } = host();
    const handlers = createGuildUpdatesHandlers(value);
    const response = await handlers.LIST(
      new Request(`https://example.test/api/v1/guild-updates?guildId=${guildId}`),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(state());
    expect(calls).toEqual(['actor', 'rateLimit', ['list', actor, guildId]]);
    for (const query of [
      '',
      '?guildId=nope',
      `?guildId=${guildId}&guildId=${guildId}`,
      `?guildId=${guildId}&x=1`,
    ]) {
      const refused = await handlers.LIST(
        new Request('https://example.test/api/v1/guild-updates' + query),
      );
      expect(refused.status, query).toBe(422);
    }
    const foreign = host({ list: async () => state([managed({ guildId: otherGuildId })]) });
    const leaked = await createGuildUpdatesHandlers(foreign.value).LIST(
      new Request(`https://example.test/api/v1/guild-updates?guildId=${guildId}`),
    );
    expect(leaked.status).toBe(503);
  });

  it('answers authentication, origin and throttle denials before any storage call', async () => {
    for (const [name, status, code] of [
      ['actor', 401, 'AUTHENTICATION_REQUIRED'],
      ['checkOrigin', 403, 'FORBIDDEN'],
      ['rateLimit', 429, 'RATE_LIMITED'],
    ] as const) {
      const { value, calls } = host({
        [name]: async () => {
          throw new GuildUpdatesHttpError(status);
        },
      } as Partial<GuildUpdatesHttpHost>);
      const response = await createGuildUpdatesHandlers(value).DRAFT(draftRequest());
      expect(response.status, name).toBe(status);
      expect((await body(response)).error.code).toBe(code);
      expect(calls.filter((c) => Array.isArray(c))).toEqual([]);
    }
  });

  it('maps storage failures to fixed safe answers without leaking internals', async () => {
    const cases: [unknown, number, string][] = [
      [new GuildStorageError('UNAUTHENTICATED'), 401, 'AUTHENTICATION_REQUIRED'],
      [new GuildStorageError('ACCOUNT_RESTRICTED'), 403, 'ACCOUNT_RESTRICTED'],
      [new GuildStorageError('FORBIDDEN'), 403, 'FORBIDDEN'],
      [new GuildStorageError('NOT_FOUND'), 404, 'NOT_FOUND'],
      [new GuildStorageError('REVISION_CONFLICT'), 409, 'REVISION_CHANGED'],
      [new GuildStorageError('UPDATE_LIMIT'), 409, 'GUILD_UPDATE_LIMIT_REACHED'],
      [new GuildStorageError('WRITES_DISABLED'), 503, 'NOT_AVAILABLE'],
      [new GuildStorageError('INVALID_INPUT'), 422, 'INVALID_COMMAND'],
      [new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
      [new Error('connection to db.internal:5432 refused'), 503, 'SERVICE_UNAVAILABLE'],
    ];
    for (const [error, status, code] of cases) {
      const { value } = host({
        draft: async () => {
          throw error;
        },
      });
      const response = await createGuildUpdatesHandlers(value).DRAFT(draftRequest());
      expect(response.status, code).toBe(status);
      const text = JSON.stringify(await body(response));
      expect(text).toContain(code);
      expect(text).not.toContain('db.internal');
    }
  });

  it('rejects an incomplete host', () => {
    const { value } = host();
    expect(() =>
      createGuildUpdatesHandlers({
        ...value,
        withdraw: undefined,
      } as unknown as GuildUpdatesHttpHost),
    ).toThrow();
  });
});
