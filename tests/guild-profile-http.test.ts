import { describe, expect, it } from 'vitest';
import {
  createGuildProfileHandlers,
  GuildProfileHttpError,
  type GuildProfileHttpHost,
} from '../src/guild-profiles/guild-profile-http';
import { CommandReceiptError } from '../src/command-receipts/contracts';
import { GuildStorageError, type GuildActor } from '../src/guild-profiles/guild-storage-contracts';

const guildId = '11111111-1111-4111-8111-111111111111';
const otherGuildId = '99999999-9999-4999-8999-999999999999';
const actor: GuildActor = { accountId: 'founder-1', sessionHash: 'a'.repeat(64) };
const guild = (overrides: Record<string, unknown> = {}) => ({
  version: 'v1',
  id: guildId,
  slug: 'synthetic-guild',
  name: 'Synthetic Guild',
  description: 'A synthetic Guild for tests.',
  founderAccountId: 'founder-1',
  revision: 2,
  state: 'ACTIVE',
  primaryToken: null,
  ...overrides,
});
const view = (overrides: Record<string, unknown> = {}) => ({
  version: 'v1',
  guild: guild(),
  authority: { founder: true, kinds: ['PROFILE', 'WORK'] },
  writesAvailable: true,
  unavailableReason: null,
  ...overrides,
});
function host(overrides: Partial<GuildProfileHttpHost> = {}) {
  const calls: unknown[] = [];
  const value: GuildProfileHttpHost = {
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => (calls.push('actor'), actor),
    checkOrigin: () => void calls.push('origin'),
    rateLimit: async (_who, scope) =>
      void calls.push(scope === 'READ' ? 'rateLimit:read' : 'rateLimit'),
    read: async (who, id) => (calls.push(['read', who, id]), view()),
    edit: async (command) => (
      calls.push(['edit', command]),
      { status: 'EXECUTED', guild: guild({ name: 'Renamed Guild', revision: 3 }) }
    ),
    ...overrides,
  };
  return { value, calls };
}
const post = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request('https://example.test/api/v1/guild-profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: JSON.stringify(payload),
  });
const edit = (
  payload: unknown = { guildId, expectedRevision: 2, profile: { name: 'Renamed Guild' } },
) => post(payload);
const get = (query = `?guildId=${guildId}`) =>
  new Request('https://example.test/api/v1/guild-profile' + query);
const body = async (response: Response) => (await response.json()) as Record<string, any>;

describe('Guild profile edit HTTP boundary', () => {
  it('edits with origin, then the cookie-derived actor, then throttle; the actor never comes from the body', async () => {
    const { value, calls } = host();
    const response = await createGuildProfileHandlers(value).EDIT(edit());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect(calls.slice(0, 3)).toEqual(['origin', 'actor', 'rateLimit']);
    expect(calls[3]).toEqual([
      'edit',
      {
        actor,
        input: { guildId, expectedRevision: 2, profile: { name: 'Renamed Guild' } },
        idempotencyKey: 'key-1',
        requestId: 'request-1',
      },
    ]);
    expect((await body(response)).guild.revision).toBe(3);
    const smuggled = host();
    const refused = await createGuildProfileHandlers(smuggled.value).EDIT(
      edit({
        guildId,
        expectedRevision: 2,
        profile: { name: 'Renamed Guild' },
        actor: { accountId: 'someone-else' },
      }),
    );
    expect(refused.status).toBe(422);
    expect(smuggled.calls.filter((c) => Array.isArray(c))).toEqual([]);
  });

  it('refuses a bad body, field or key before touching storage', async () => {
    const bad: unknown[] = [
      { guildId, expectedRevision: 2, profile: {} },
      { guildId, expectedRevision: 2, profile: { slug: 'new-slug' } },
      { guildId, expectedRevision: 0, profile: { name: 'Renamed Guild' } },
      { guildId: 'not-a-uuid', expectedRevision: 2, profile: { name: 'Renamed Guild' } },
      { expectedRevision: 2, profile: { name: 'Renamed Guild' } },
    ];
    for (const payload of bad) {
      const { value, calls } = host();
      const response = await createGuildProfileHandlers(value).EDIT(edit(payload));
      expect(response.status, JSON.stringify(payload)).toBe(422);
      expect(calls.filter((c) => Array.isArray(c))).toEqual([]);
    }
    for (const headers of [{ 'idempotency-key': '' }, { 'content-type': 'text/plain' }]) {
      const { value, calls } = host();
      const response = await createGuildProfileHandlers(value).EDIT(
        new Request('https://example.test/api/v1/guild-profile', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
          body: JSON.stringify({
            guildId,
            expectedRevision: 2,
            profile: { name: 'Renamed Guild' },
          }),
        }),
      );
      expect([415, 422]).toContain(response.status);
      expect(calls.filter((c) => Array.isArray(c))).toEqual([]);
    }
  });

  it('never forwards a result for a different Guild, revision or content', async () => {
    const results: unknown[] = [
      {
        status: 'EXECUTED',
        guild: guild({ id: otherGuildId, name: 'Renamed Guild', revision: 3 }),
      },
      { status: 'EXECUTED', guild: guild({ name: 'Renamed Guild', revision: 2 }) },
      { status: 'EXECUTED', guild: guild({ name: 'Renamed Guild', revision: 9 }) },
      { status: 'EXECUTED', guild: guild({ name: 'Another name', revision: 3 }) },
      { status: 'REPLAYED', guild: guild({ name: 'Another name', revision: 3 }) },
      { status: 'EXECUTED', guild: guild({ name: 'Renamed Guild', revision: 3, extra: true }) },
      { status: 'MAYBE', guild: guild({ name: 'Renamed Guild', revision: 3 }) },
    ];
    for (const result of results) {
      const { value } = host({ edit: async () => result });
      const response = await createGuildProfileHandlers(value).EDIT(edit());
      expect(response.status, JSON.stringify(result)).toBe(503);
      expect((await body(response)).error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('accepts an exact replay, and checks only the fields that were requested', async () => {
    const replay = host({
      edit: async () => ({
        status: 'REPLAYED',
        guild: guild({ name: 'Renamed Guild', revision: 3 }),
      }),
    });
    const response = await createGuildProfileHandlers(replay.value).EDIT(edit());
    expect(response.status).toBe(200);
    expect((await body(response)).status).toBe('REPLAYED');
    const both = host({
      edit: async () => ({
        status: 'EXECUTED',
        guild: guild({ name: 'Renamed Guild', description: 'New words.', revision: 3 }),
      }),
    });
    const described = await createGuildProfileHandlers(both.value).EDIT(
      edit({
        guildId,
        expectedRevision: 2,
        profile: { name: 'Renamed Guild', description: 'New words.' },
      }),
    );
    expect(described.status).toBe(200);
    const onlyDescription = host({
      edit: async () => ({
        status: 'EXECUTED',
        guild: guild({ description: 'New words.', revision: 3 }),
      }),
    });
    const unchangedName = await createGuildProfileHandlers(onlyDescription.value).EDIT(
      edit({ guildId, expectedRevision: 2, profile: { description: 'New words.' } }),
    );
    expect(unchangedName.status).toBe(200);
  });

  it('reads the caller’s view after authentication, with no origin check and a strict query', async () => {
    const { value, calls } = host();
    const handlers = createGuildProfileHandlers(value);
    const response = await handlers.READ(get());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(calls).toEqual(['actor', 'rateLimit:read', ['read', actor, guildId]]);
    expect((await body(response)).guild.id).toBe(guildId);
    for (const query of [
      '',
      '?guildId=nope',
      `?guildId=${guildId}&guildId=${guildId}`,
      `?guildId=${guildId}&extra=1`,
    ]) {
      const fresh = host();
      const refused = await createGuildProfileHandlers(fresh.value).READ(get(query));
      expect(refused.status, query).toBe(422);
      expect(fresh.calls.filter((c) => Array.isArray(c))).toEqual([]);
    }
    const wrong = host({ read: async () => view({ guild: guild({ id: otherGuildId }) }) });
    expect((await createGuildProfileHandlers(wrong.value).READ(get())).status).toBe(503);
    const incoherent = host({ read: async () => view({ unavailableReason: 'DISABLED' }) });
    expect((await createGuildProfileHandlers(incoherent.value).READ(get())).status).toBe(503);
  });

  it('uses separate throttle scopes so polling cannot block an edit', async () => {
    const scopes: string[] = [];
    const { value } = host({
      rateLimit: async (_who, scope) => {
        scopes.push(scope);
        if (scope === 'READ') throw new GuildProfileHttpError(429);
      },
    });
    const handlers = createGuildProfileHandlers(value);
    expect((await handlers.READ(get())).status).toBe(429);
    expect((await handlers.EDIT(edit())).status).toBe(200);
    expect(scopes).toEqual(['READ', 'WRITE']);
  });

  it('answers authentication, origin and throttle denials before any storage call', async () => {
    for (const [name, status, code] of [
      ['actor', 401, 'AUTHENTICATION_REQUIRED'],
      ['checkOrigin', 403, 'FORBIDDEN'],
      ['rateLimit', 429, 'RATE_LIMITED'],
    ] as const) {
      const { value, calls } = host({
        [name]: async () => {
          throw new GuildProfileHttpError(status);
        },
      } as Partial<GuildProfileHttpHost>);
      const response = await createGuildProfileHandlers(value).EDIT(edit());
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
      [new GuildStorageError('WRITES_DISABLED'), 503, 'NOT_AVAILABLE'],
      [new GuildStorageError('INVALID_INPUT'), 422, 'INVALID_COMMAND'],
      [new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
      [new Error('connection to db.internal:5432 refused'), 503, 'SERVICE_UNAVAILABLE'],
    ];
    for (const [error, status, code] of cases) {
      const { value } = host({
        edit: async () => {
          throw error;
        },
      });
      const response = await createGuildProfileHandlers(value).EDIT(edit());
      expect(response.status, code).toBe(status);
      const text = JSON.stringify(await body(response));
      expect(text).toContain(code);
      expect(text).not.toContain('db.internal');
    }
  });

  it('rejects an incomplete host', () => {
    const { value } = host();
    expect(() =>
      createGuildProfileHandlers({ ...value, edit: undefined } as unknown as GuildProfileHttpHost),
    ).toThrow();
  });
});
