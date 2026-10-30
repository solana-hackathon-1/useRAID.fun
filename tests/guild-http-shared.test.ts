import { describe, expect, it } from 'vitest';
import { CommandReceiptError } from '../src/command-receipts/contracts';
import { JsonBodyFailure } from '../src/http-contracts/json';
import {
  assertGuildHttpHost,
  GuildHttpAuthorityError,
  guildCorrelation,
  guildHttpFailure,
  guildHttpHeaders,
  guildStorageCodes,
  readGuildCommand,
} from '../src/guild-profiles/guild-http-shared';
import { GuildStorageError } from '../src/guild-profiles/guild-storage-contracts';
import { GuildProfileHttpError } from '../src/guild-profiles/guild-profile-http';
import { GuildUpdatesHttpError } from '../src/guild-profiles/guild-updates-http';

const codes = guildStorageCodes();
const body = async (response: Response) => (await response.json()) as Record<string, any>;

describe('shared Guild management HTTP helper', () => {
  it('maps every host authority error, whichever module raised it, to a fixed private envelope', async () => {
    for (const [error, status, code] of [
      [new GuildHttpAuthorityError(401), 401, 'AUTHENTICATION_REQUIRED'],
      [new GuildProfileHttpError(403), 403, 'FORBIDDEN'],
      [new GuildUpdatesHttpError(429), 429, 'RATE_LIMITED'],
    ] as const) {
      const response = guildHttpFailure(error, 'request-1', codes);
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('Vary')).toBe('Cookie');
      expect((await body(response)).error).toMatchObject({ code, requestId: 'request-1' });
    }
    expect(Object.isFrozen(guildHttpHeaders)).toBe(true);
    expect(new GuildProfileHttpError(401).name).toBe('GuildProfileHttpError');
    expect(new GuildUpdatesHttpError(401)).toBeInstanceOf(GuildHttpAuthorityError);
  });

  it('keeps unexpected errors and unlisted storage codes opaque, and honours per-module overrides', async () => {
    const opaque = guildHttpFailure(new Error('secret SQL detail'), 'request-1', codes);
    expect(opaque.status).toBe(503);
    expect(JSON.stringify(await body(opaque))).not.toContain('secret');
    expect(guildHttpFailure(new GuildStorageError('GRANT_REVOKED'), 'r1', codes).status).toBe(503);
    const wider = guildStorageCodes({ GRANT_REVOKED: 'REVISION_CHANGED' });
    expect(guildHttpFailure(new GuildStorageError('GRANT_REVOKED'), 'r1', wider).status).toBe(409);
    // The shared base is never mutated by one module's overrides.
    expect(guildStorageCodes().GRANT_REVOKED).toBe('SERVICE_UNAVAILABLE');
    expect(Object.isFrozen(wider)).toBe(true);
    expect(guildHttpFailure(new JsonBodyFailure(413), 'r1', codes).status).toBe(413);
    expect(
      (await body(guildHttpFailure(new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'), 'r1', codes)))
        .error.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('uses a valid host request id, and a fresh one when the host fails or returns junk', () => {
    expect(guildCorrelation({ requestId: () => 'request-1' })).toBe('request-1');
    expect(
      guildCorrelation({
        requestId: () => {
          throw new Error('broken');
        },
      }),
    ).toMatch(/^[0-9a-f-]{36}$/);
    expect(guildCorrelation({ requestId: () => '' })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('requires the v1 marker and every named host function', () => {
    const ok = { version: 'v1', a: () => 1 };
    expect(() => assertGuildHttpHost(ok, ['a'])).not.toThrow();
    for (const bad of [null, undefined, {}, { ...ok, version: 'v2' }, { version: 'v1', a: 1 }])
      expect(() => assertGuildHttpHost(bad, ['a'])).toThrow(GuildStorageError);
  });

  it('requires an idempotency key and strict bounded JSON for a command', async () => {
    const send = (headers: Record<string, string>, text = '{"a":1}') =>
      new Request('https://example.test/x', { method: 'POST', headers, body: text });
    const read = await readGuildCommand(
      send({ 'content-type': 'application/json', 'idempotency-key': 'key-1' }),
    );
    expect(read).toEqual({ key: 'key-1', json: { a: 1 } });
    await expect(
      readGuildCommand(send({ 'content-type': 'application/json' })),
    ).rejects.toBeInstanceOf(JsonBodyFailure);
  });
});
