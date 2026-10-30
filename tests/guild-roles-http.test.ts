import { describe, expect, it } from 'vitest';
import {
  createGuildRolesHandlers,
  GuildRolesHttpError,
  type GuildRolesHttpHost,
} from '../src/guild-profiles/guild-roles-http';
import { CommandReceiptError } from '../src/command-receipts/contracts';
import { GuildStorageError, type GuildActor } from '../src/guild-profiles/guild-storage-contracts';

const guildId = '11111111-1111-4111-8111-111111111111';
const otherGuildId = '99999999-9999-4999-8999-999999999999';
const grantId = '22222222-2222-4222-8222-222222222222';
const transferId = '33333333-3333-4333-8333-333333333333';
const actor: GuildActor = { accountId: 'founder-1', sessionHash: 'a'.repeat(64) };
const future = '2027-01-01T00:00:00.000Z';
const grantView = (overrides: Record<string, unknown> = {}) => ({
  version: 'v1',
  id: grantId,
  guildId,
  granteeAccountId: 'delegate-1',
  kind: 'PROFILE',
  fields: ['description', 'name'],
  canDelegate: false,
  validFrom: '2026-10-29T06:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  grantedByAccountId: 'founder-1',
  ...overrides,
});
const transferView = (overrides: Record<string, unknown> = {}) => ({
  version: 'v1',
  id: transferId,
  guildId,
  fromAccountId: 'founder-1',
  toAccountId: 'heir-1',
  state: 'PROPOSED',
  expiresAt: future,
  decidedAt: null,
  applied: false,
  ...overrides,
});
function host(overrides: Partial<GuildRolesHttpHost> = {}) {
  const calls: unknown[] = [];
  const value: GuildRolesHttpHost = {
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => (calls.push('actor'), actor),
    checkOrigin: () => void calls.push('origin'),
    rateLimit: async (_who, scope) => void calls.push('rateLimit:' + scope),
    grant: async (command) => (
      calls.push(['grant', command]),
      { status: 'EXECUTED', grant: grantView() }
    ),
    revoke: async (command) => (
      calls.push(['revoke', command]),
      { status: 'EXECUTED', grant: grantView({ revokedAt: '2026-10-29T07:00:00.000Z' }) }
    ),
    propose: async (command) => (
      calls.push(['propose', command]),
      { status: 'EXECUTED', transfer: transferView() }
    ),
    respond: async (command) => (
      calls.push(['respond', command]),
      {
        status: 'EXECUTED',
        transfer: transferView({
          state: 'ACCEPTED',
          decidedAt: '2026-10-29T07:00:00.000Z',
          applied: true,
          toAccountId: 'founder-1',
          fromAccountId: 'old-founder',
        }),
      }
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
const grantBody = {
  guildId,
  granteeAccountId: 'delegate-1',
  kind: 'PROFILE',
  fields: ['name', 'description'],
};
const grantRequest = (payload: unknown = grantBody, h = {}) =>
  post('/api/v1/guild-grants', payload, h);
const revokeRequest = (payload: unknown = { guildId }) =>
  post(`/api/v1/guild-grants/${grantId}/revoke`, payload);
const proposeBody = { guildId, toAccountId: 'heir-1', expiresAt: future };
const proposeRequest = (payload: unknown = proposeBody) =>
  post('/api/v1/guild-ownership-transfers', payload);
const respondRequest = (payload: unknown = { guildId, decision: 'ACCEPT' }) =>
  post(`/api/v1/guild-ownership-transfers/${transferId}`, payload);
const body = async (response: Response) => (await response.json()) as Record<string, any>;
const commandCalls = (calls: unknown[]) =>
  calls.filter((c) => Array.isArray(c)) as [string, Record<string, any>][];

describe('Guild role and ownership management HTTP boundary', () => {
  it('grants with origin, then the cookie-derived actor, then throttle; the actor never comes from the body', async () => {
    const { value, calls } = host();
    const response = await createGuildRolesHandlers(value).GRANT(grantRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect(await body(response)).toEqual({ status: 'EXECUTED', grant: grantView() });
    expect(calls.slice(0, 3)).toEqual(['origin', 'actor', 'rateLimit:WRITE']);
    expect(calls[3]).toEqual([
      'grant',
      {
        actor,
        // Validated here, parsed and normalized again by storage; its normalized form is not valid input.
        input: grantBody,
        idempotencyKey: 'key-1',
        requestId: 'request-1',
      },
    ]);
  });

  it('refuses a bad grant body or key before touching storage', async () => {
    const { value, calls } = host();
    const handlers = createGuildRolesHandlers(value);
    for (const payload of [
      { ...grantBody, grantedByAccountId: 'x' },
      { ...grantBody, actor: { accountId: 'x' } },
      { ...grantBody, kind: 'ADMIN' },
      { ...grantBody, guildId: 'nope' },
      { ...grantBody, fields: undefined },
      { guildId, granteeAccountId: 'delegate-1', kind: 'TREASURY', fields: ['name'] },
      { ...grantBody, canDelegate: 'yes' },
    ]) {
      const response = await handlers.GRANT(grantRequest(payload));
      expect(response.status, JSON.stringify(payload)).toBe(422);
    }
    const noKey = await handlers.GRANT(
      new Request('https://example.test/api/v1/guild-grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(grantBody),
      }),
    );
    expect(noKey.status).toBe(422);
    const wrongType = await handlers.GRANT(
      new Request('https://example.test/api/v1/guild-grants', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'idempotency-key': 'key-1' },
        body: '{}',
      }),
    );
    expect(wrongType.status).toBe(415);
    expect(commandCalls(calls)).toEqual([]);
  });

  it('revokes one grant of one Guild from the path and body, never from a body grant id', async () => {
    const { value, calls } = host();
    const handlers = createGuildRolesHandlers(value);
    const response = await handlers.REVOKE(revokeRequest(), grantId);
    expect(response.status).toBe(200);
    expect((await body(response)).grant.revokedAt).not.toBeNull();
    expect(commandCalls(calls)[0][1].input).toEqual({ guildId, grantId });
    expect((await handlers.REVOKE(revokeRequest({ guildId, grantId }), grantId)).status).toBe(422);
    expect((await handlers.REVOKE(revokeRequest({}), grantId)).status).toBe(422);
    expect((await handlers.REVOKE(revokeRequest(), 'not-a-uuid')).status).toBe(422);
    expect(commandCalls(calls)).toHaveLength(1);
  });

  it('proposes an ownership transfer and lets the recipient or proposer decide it', async () => {
    const { value, calls } = host();
    const handlers = createGuildRolesHandlers(value);
    const proposed = await handlers.PROPOSE(proposeRequest());
    expect(proposed.status).toBe(200);
    expect((await body(proposed)).transfer).toEqual(transferView());
    const accepted = await handlers.RESPOND(respondRequest(), transferId);
    expect(accepted.status).toBe(200);
    const commands = commandCalls(calls);
    expect(commands.map(([name]) => name)).toEqual(['propose', 'respond']);
    expect(commands[0][1].input).toEqual(proposeBody);
    expect(commands[1][1].input).toEqual({ guildId, transferId, decision: 'ACCEPT' });
    for (const payload of [
      { guildId, decision: 'DELETE' },
      { guildId, decision: 'ACCEPT', toAccountId: 'me' },
      { decision: 'ACCEPT' },
    ])
      expect((await handlers.RESPOND(respondRequest(payload), transferId)).status).toBe(422);
    expect((await handlers.RESPOND(respondRequest(), 'nope')).status).toBe(422);
    for (const payload of [
      { ...proposeBody, fromAccountId: 'x' },
      { ...proposeBody, expiresAt: 'tomorrow' },
      { guildId, toAccountId: 'heir-1' },
    ])
      expect((await handlers.PROPOSE(proposeRequest(payload))).status).toBe(422);
  });

  it('never forwards a grant result for a different Guild, grantee, kind, scope or issuer', async () => {
    const wrong: Record<string, unknown>[] = [
      { guildId: otherGuildId },
      { granteeAccountId: 'someone-else' },
      { kind: 'WORK', fields: [] },
      { fields: ['name'] },
      { canDelegate: true },
      { expiresAt: future },
      { revokedAt: '2026-10-29T07:00:00.000Z' },
      { grantedByAccountId: 'impostor' },
      { grantedByAccountId: null },
      { secret: 'x' },
    ];
    for (const override of wrong) {
      const { value } = host({
        grant: async () => ({ status: 'EXECUTED', grant: grantView(override) }),
      });
      const response = await createGuildRolesHandlers(value).GRANT(grantRequest());
      expect(response.status, JSON.stringify(override)).toBe(503);
    }
    // A replay may find the grant revoked since; anything else about it must still match.
    const revokedSince = host({
      grant: async () => ({
        status: 'REPLAYED',
        grant: grantView({ revokedAt: '2026-10-29T07:00:00.000Z' }),
      }),
    });
    expect((await createGuildRolesHandlers(revokedSince.value).GRANT(grantRequest())).status).toBe(
      200,
    );
    const replayOther = host({
      grant: async () => ({ status: 'REPLAYED', grant: grantView({ kind: 'WORK', fields: [] }) }),
    });
    expect((await createGuildRolesHandlers(replayOther.value).GRANT(grantRequest())).status).toBe(
      503,
    );
  });

  it('binds a revocation result to the requested grant and requires it to be revoked, fresh or replayed', async () => {
    const revoked = { revokedAt: '2026-10-29T07:00:00.000Z' };
    for (const [override, status] of [
      [{ id: '44444444-4444-4444-8444-444444444444', ...revoked }, 503],
      [{ guildId: otherGuildId, ...revoked }, 503],
      [{}, 503],
      [{ ...revoked, grantedByAccountId: null }, 200],
      [{ ...revoked, kind: 'TREASURY', fields: [], grantedByAccountId: null }, 200],
      [{ ...revoked, extra: 1 }, 503],
    ] as const) {
      for (const state of ['EXECUTED', 'REPLAYED']) {
        const { value } = host({
          revoke: async () => ({ status: state, grant: grantView(override) }),
        });
        const response = await createGuildRolesHandlers(value).REVOKE(revokeRequest(), grantId);
        expect(response.status, `${state} ${JSON.stringify(override)}`).toBe(status);
      }
    }
  });

  it('binds propose and respond results to the request, the caller and the decision', async () => {
    const decided = '2026-10-29T07:00:00.000Z';
    const proposeCases: [Record<string, unknown>, string, number][] = [
      [{ guildId: otherGuildId }, 'EXECUTED', 503],
      [{ toAccountId: 'other' }, 'EXECUTED', 503],
      [{ fromAccountId: 'impostor' }, 'EXECUTED', 503],
      [{ expiresAt: '2027-02-02T00:00:00.000Z' }, 'EXECUTED', 503],
      [{ state: 'ACCEPTED', decidedAt: decided, applied: true }, 'EXECUTED', 503],
      // A replay may find the proposal decided since.
      [{ state: 'ACCEPTED', decidedAt: decided, applied: true }, 'REPLAYED', 200],
      [{ state: 'EXPIRED', decidedAt: decided }, 'REPLAYED', 200],
      [{ toAccountId: 'other' }, 'REPLAYED', 503],
    ];
    for (const [override, status, expected] of proposeCases) {
      const { value } = host({
        propose: async () => ({ status, transfer: transferView(override) }),
      });
      const response = await createGuildRolesHandlers(value).PROPOSE(proposeRequest());
      expect(response.status, JSON.stringify([override, status])).toBe(expected);
    }
    const respondCases: [string, string, boolean, string, number][] = [
      ['ACCEPT', 'ACCEPTED', true, 'founder-1', 200],
      ['ACCEPT', 'ACCEPTED', false, 'founder-1', 503],
      ['ACCEPT', 'DECLINED', false, 'founder-1', 503],
      ['ACCEPT', 'EXPIRED', false, 'founder-1', 200],
      ['ACCEPT', 'EXPIRED', true, 'founder-1', 503],
      ['ACCEPT', 'ACCEPTED', true, 'someone-else', 503],
      ['DECLINE', 'DECLINED', false, 'founder-1', 200],
      ['DECLINE', 'ACCEPTED', true, 'founder-1', 503],
      ['WITHDRAW', 'WITHDRAWN', false, 'old-founder', 200],
      ['WITHDRAW', 'WITHDRAWN', false, 'someone-else', 503],
      ['WITHDRAW', 'ACCEPTED', true, 'old-founder', 503],
    ];
    for (const [decision, state, applied, party, expected] of respondCases) {
      for (const status of ['EXECUTED', 'REPLAYED']) {
        const caller = decision === 'WITHDRAW' ? 'old-founder' : 'founder-1';
        const view = transferView({
          state,
          applied,
          decidedAt: decided,
          // ACCEPT/DECLINE: the caller is the recipient; WITHDRAW: the caller is the proposer.
          ...(decision === 'WITHDRAW'
            ? { fromAccountId: party, toAccountId: 'heir-1' }
            : { toAccountId: party, fromAccountId: 'old-founder' }),
        });
        const { value } = host({
          actor: async () => ({ ...actor, accountId: caller }),
          respond: async () => ({ status, transfer: view }),
        });
        const response = await createGuildRolesHandlers(value).RESPOND(
          respondRequest({ guildId, decision }),
          transferId,
        );
        expect(response.status, `${decision} ${state} ${applied} ${party} ${status}`).toBe(
          expected,
        );
      }
    }
    const wrongId = host({
      respond: async () => ({
        status: 'EXECUTED',
        transfer: transferView({ id: '55555555-5555-4555-8555-555555555555' }),
      }),
    });
    expect(
      (await createGuildRolesHandlers(wrongId.value).RESPOND(respondRequest(), transferId)).status,
    ).toBe(503);
  });

  it('uses one command throttle scope for every command', async () => {
    const scopes: string[] = [];
    const { value } = host({ rateLimit: async (_who, scope) => void scopes.push(scope) });
    const handlers = createGuildRolesHandlers(value);
    await handlers.GRANT(grantRequest());
    await handlers.REVOKE(revokeRequest(), grantId);
    await handlers.PROPOSE(proposeRequest());
    await handlers.RESPOND(respondRequest(), transferId);
    expect(scopes).toEqual(['WRITE', 'WRITE', 'WRITE', 'WRITE']);
  });

  it('answers authentication, origin and throttle denials before any storage call', async () => {
    for (const [name, status, code] of [
      ['actor', 401, 'AUTHENTICATION_REQUIRED'],
      ['checkOrigin', 403, 'FORBIDDEN'],
      ['rateLimit', 429, 'RATE_LIMITED'],
    ] as const) {
      const { value, calls } = host({
        [name]: async () => {
          throw new GuildRolesHttpError(status);
        },
      } as Partial<GuildRolesHttpHost>);
      const handlers = createGuildRolesHandlers(value);
      for (const response of [
        await handlers.GRANT(grantRequest()),
        await handlers.REVOKE(revokeRequest(), grantId),
        await handlers.PROPOSE(proposeRequest()),
        await handlers.RESPOND(respondRequest(), transferId),
      ]) {
        expect(response.status, name).toBe(status);
        expect((await body(response)).error.code).toBe(code);
      }
      expect(commandCalls(calls)).toEqual([]);
    }
  });

  it('maps storage failures to fixed safe answers without leaking internals', async () => {
    const cases: [unknown, number, string][] = [
      [new GuildStorageError('UNAUTHENTICATED'), 401, 'AUTHENTICATION_REQUIRED'],
      [new GuildStorageError('ACCOUNT_RESTRICTED'), 403, 'ACCOUNT_RESTRICTED'],
      [new GuildStorageError('FORBIDDEN'), 403, 'FORBIDDEN'],
      [new GuildStorageError('NOT_FOUND'), 404, 'NOT_FOUND'],
      [new GuildStorageError('REVISION_CONFLICT'), 409, 'REVISION_CHANGED'],
      [new GuildStorageError('GRANT_REVOKED'), 409, 'REVISION_CHANGED'],
      [new GuildStorageError('GRANT_LIMIT'), 409, 'GUILD_GRANT_LIMIT_REACHED'],
      [new GuildStorageError('TRANSFER_PENDING'), 409, 'GUILD_TRANSFER_PENDING'],
      [new GuildStorageError('WRITES_DISABLED'), 503, 'NOT_AVAILABLE'],
      [new GuildStorageError('INVALID_INPUT'), 422, 'INVALID_COMMAND'],
      [new GuildStorageError('GUILD_EXISTS'), 503, 'SERVICE_UNAVAILABLE'],
      [new GuildStorageError('SLUG_UNAVAILABLE'), 503, 'SERVICE_UNAVAILABLE'],
      [new GuildStorageError('UPDATE_LIMIT'), 503, 'SERVICE_UNAVAILABLE'],
      [new GuildStorageError('STORAGE_CONTRACT'), 503, 'SERVICE_UNAVAILABLE'],
      [new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
      [new Error('connection to db.internal:5432 refused'), 503, 'SERVICE_UNAVAILABLE'],
    ];
    for (const [error, status, code] of cases) {
      const fail = async () => {
        throw error;
      };
      const { value } = host({ grant: fail, revoke: fail, propose: fail, respond: fail });
      const handlers = createGuildRolesHandlers(value);
      for (const response of [
        await handlers.GRANT(grantRequest()),
        await handlers.REVOKE(revokeRequest(), grantId),
        await handlers.PROPOSE(proposeRequest()),
        await handlers.RESPOND(respondRequest(), transferId),
      ]) {
        expect(response.status, code).toBe(status);
        const text = JSON.stringify(await body(response));
        expect(text).toContain(code);
        expect(text).not.toContain('db.internal');
      }
    }
  });

  it('rejects an incomplete host', () => {
    const { value } = host();
    for (const name of [
      'requestId',
      'actor',
      'checkOrigin',
      'rateLimit',
      'grant',
      'revoke',
      'propose',
      'respond',
    ])
      expect(() => createGuildRolesHandlers({ ...value, [name]: undefined } as never)).toThrow();
    expect(() => createGuildRolesHandlers({ ...value, version: 'v2' } as never)).toThrow();
  });

  it('survives a faulty request id generator with a fresh correlation id', async () => {
    const { value } = host({
      requestId: () => {
        throw new Error('broken');
      },
      grant: async () => {
        throw new GuildStorageError('FORBIDDEN');
      },
    });
    const response = await createGuildRolesHandlers(value).GRANT(grantRequest());
    expect(response.status).toBe(403);
    expect((await body(response)).error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
