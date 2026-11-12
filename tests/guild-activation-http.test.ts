import { describe, expect, it } from 'vitest';
import {
  createGuildActivationHandlers,
  type GuildActivationHttpHost,
} from '../src/guild-profiles/guild-activation-http';
import { CommandReceiptError } from '../src/command-receipts/contracts';
import { GuildStorageError, type GuildActor } from '../src/guild-profiles/guild-storage-contracts';

const draftId = '44444444-4444-4444-8444-444444444444';
const guildId = '11111111-1111-4111-8111-111111111111';
const operator: GuildActor = { accountId: 'operator-1', sessionHash: 'a'.repeat(64) };
const activationBody = {
  guildDraftId: draftId,
  expectedDraftRevision: 3,
  activationRef: 'evidence/record-1',
};
const guildView = (overrides: Record<string, unknown> = {}) => ({
  version: 'v1',
  id: guildId,
  slug: 'synthetic-guild',
  name: 'Synthetic Guild',
  description: 'Synthetic.',
  founderAccountId: 'applicant-1',
  revision: 1,
  state: 'ACTIVE',
  primaryToken: null,
  ...overrides,
});
function host(overrides: Partial<GuildActivationHttpHost> = {}) {
  const calls: unknown[] = [];
  const value: GuildActivationHttpHost = {
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => (calls.push('actor'), operator),
    checkOrigin: () => void calls.push('origin'),
    rateLimit: async (_who, scope) => void calls.push('rateLimit:' + scope),
    activate: async (command) => (
      calls.push(['activate', command]),
      { status: 'EXECUTED', guild: guildView() }
    ),
    ...overrides,
  };
  return { value, calls };
}
const post = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request('https://example.test/api/v1/guild-activations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: JSON.stringify(payload),
  });
const body = async (response: Response) => (await response.json()) as Record<string, any>;
const commandCalls = (calls: unknown[]) => calls.filter((c) => Array.isArray(c));

describe('Guild activation HTTP boundary', () => {
  it('activates with origin, then the cookie-derived actor, then throttle; the actor never comes from the body', async () => {
    const { value, calls } = host();
    const response = await createGuildActivationHandlers(value).ACTIVATE(post(activationBody));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect(await body(response)).toEqual({ status: 'EXECUTED', guild: guildView() });
    expect(calls.slice(0, 3)).toEqual(['origin', 'actor', 'rateLimit:WRITE']);
    expect(calls[3]).toEqual([
      'activate',
      {
        actor: operator,
        input: activationBody,
        idempotencyKey: 'key-1',
        requestId: 'request-1',
      },
    ]);
  });

  it('refuses a bad body or key before touching storage', async () => {
    const { value, calls } = host();
    const handlers = createGuildActivationHandlers(value);
    for (const payload of [
      { ...activationBody, activatedByAccountId: 'x' },
      { ...activationBody, actor: { accountId: 'x' } },
      { ...activationBody, founderAccountId: 'x' },
      { ...activationBody, guildDraftId: 'nope' },
      { ...activationBody, activationRef: '-starts-with-dash' },
      { ...activationBody, activationRef: 'has space' },
      { ...activationBody, activationRef: '' },
      { ...activationBody, activationRef: 'a'.repeat(201) },
      { ...activationBody, expectedDraftRevision: 0 },
      { guildDraftId: draftId, activationRef: 'evidence-1' },
    ]) {
      const response = await handlers.ACTIVATE(post(payload));
      expect(response.status, JSON.stringify(payload)).toBe(422);
    }
    expect((await handlers.ACTIVATE(post(activationBody, { 'idempotency-key': '' }))).status).toBe(
      422,
    );
    expect(commandCalls(calls)).toEqual([]);
  });

  it('accepts a free-form activationRef that matches the existing pattern', async () => {
    for (const activationRef of ['a', 'ticket:2026-11-07/ops.1_x-y', 'A'.repeat(200)]) {
      const { value, calls } = host();
      const response = await createGuildActivationHandlers(value).ACTIVATE(
        post({ ...activationBody, activationRef }),
      );
      expect(response.status, activationRef).toBe(200);
      expect((commandCalls(calls)[0] as [string, any])[1].input.activationRef).toBe(activationRef);
    }
  });

  it('stops at origin, session and throttle failures before reading the body or storage', async () => {
    for (const [failing, status] of [
      ['checkOrigin', 403],
      ['actor', 401],
      ['rateLimit', 429],
    ] as const) {
      const { value, calls } = host({
        [failing]: async () => {
          const { GuildActivationHttpError } =
            await import('../src/guild-profiles/guild-activation-http');
          throw new GuildActivationHttpError(status);
        },
      } as Partial<GuildActivationHttpHost>);
      const response = await createGuildActivationHandlers(value).ACTIVATE(post(activationBody));
      expect(response.status, failing).toBe(status);
      expect(commandCalls(calls)).toEqual([]);
    }
  });

  it('maps storage refusals to fixed envelopes without detail', async () => {
    const cases: [GuildStorageError['code'], number, string][] = [
      ['FORBIDDEN', 403, 'FORBIDDEN'],
      ['NOT_FOUND', 404, 'NOT_FOUND'],
      ['REVISION_CONFLICT', 409, 'REVISION_CHANGED'],
      ['WRITES_DISABLED', 503, 'NOT_AVAILABLE'],
      ['ACCOUNT_RESTRICTED', 403, 'ACCOUNT_RESTRICTED'],
      ['UNAUTHENTICATED', 401, 'AUTHENTICATION_REQUIRED'],
      ['GUILD_EXISTS', 503, 'SERVICE_UNAVAILABLE'],
      ['STORAGE_CONTRACT', 503, 'SERVICE_UNAVAILABLE'],
    ];
    for (const [code, status, envelope] of cases) {
      const { value } = host({
        activate: async () => {
          throw new GuildStorageError(code);
        },
      });
      const response = await createGuildActivationHandlers(value).ACTIVATE(post(activationBody));
      expect(response.status, code).toBe(status);
      const text = JSON.stringify(await body(response));
      expect(text).toContain(envelope);
      expect(text).not.toContain(draftId);
      expect(text).not.toContain('operator-1');
    }
    const { value } = host({
      activate: async () => {
        throw new CommandReceiptError('IDEMPOTENCY_KEY_REUSED');
      },
    });
    expect((await createGuildActivationHandlers(value).ACTIVATE(post(activationBody))).status).toBe(
      409,
    );
  });

  it('turns a malformed, self-founded or non-initial result into a contract failure, never a forwarded body', async () => {
    for (const result of [
      { status: 'EXECUTED', guild: guildView({ founderAccountId: operator.accountId }) },
      { status: 'EXECUTED', guild: guildView({ revision: 2 }) },
      { status: 'EXECUTED', guild: guildView({ founderAccountId: null }) },
      { status: 'EXECUTED', guild: guildView(), extra: 'x' },
      { status: 'PENDING', guild: guildView() },
      { status: 'EXECUTED', guild: { ...guildView(), sessionHash: 'x'.repeat(64) } },
      null,
    ]) {
      const { value } = host({ activate: async () => result });
      const response = await createGuildActivationHandlers(value).ACTIVATE(post(activationBody));
      expect(response.status, JSON.stringify(result)).toBe(503);
      expect(JSON.stringify(await body(response))).not.toContain('applicant-1');
    }
  });

  it('refuses to start without every host function and the v1 marker', () => {
    const { value } = host();
    for (const name of ['requestId', 'actor', 'checkOrigin', 'rateLimit', 'activate'] as const)
      expect(() =>
        createGuildActivationHandlers({ ...value, [name]: undefined } as never),
      ).toThrow();
    expect(() => createGuildActivationHandlers({ ...value, version: 'v2' } as never)).toThrow();
  });
});
