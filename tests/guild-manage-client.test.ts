import { describe, expect, it, vi } from 'vitest';
import {
  createManageRunner,
  parseProfileResult,
  parseUpdateResult,
} from '../src/guild-profiles/guild-manage-client';

const guildId = '11111111-1111-4111-8111-111111111111';
const updateId = '22222222-2222-4222-8222-222222222222';
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const error = (status: number, code: string) =>
  json(status, { error: { code, message: 'Server text must never be shown.', requestId: 'r' } });
const keys = () => {
  let n = 0;
  return () => 'key-' + ++n;
};
const ok = (body: unknown) => (raw: unknown) => (raw === body ? body : null);
const guild = (patch = {}) => ({
  version: 'v1',
  id: guildId,
  slug: 'synthetic',
  name: 'New name',
  description: 'Same',
  founderAccountId: 'founder',
  revision: 3,
  state: 'ACTIVE',
  primaryToken: null,
  ...patch,
});
const update = (patch = {}) => ({
  version: 'v1',
  id: updateId,
  guildId,
  title: 'T',
  body: 'B',
  state: 'DRAFT',
  authorAccountId: 'a',
  createdAt: '2026-10-30T00:00:00.000Z',
  publishedAt: null,
  ...patch,
});

describe('Guild management command runner', () => {
  it('sends one command with one key, returns the parsed value and drops the key', async () => {
    const run = createManageRunner(keys());
    const send = vi.fn((key: string) => json(200, { status: 'EXECUTED', key }));
    const parse = (b: unknown) => b as { status: string };
    expect(await run.run('intent-a', send, parse)).toEqual({
      kind: 'DONE',
      value: { status: 'EXECUTED', key: 'key-1' },
    });
    await run.run('intent-a', send, parse);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['key-1', 'key-2']);
  });

  it.each([
    ['network failure', () => Promise.reject(new TypeError('offline'))],
    ['server error', () => error(500, 'SERVICE_UNAVAILABLE')],
    [
      'gateway page that is not JSON',
      () => Promise.resolve(new Response('<html>', { status: 502 })),
    ],
    ['key reuse', () => error(409, 'IDEMPOTENCY_KEY_REUSED')],
    ['success whose body fails the contract', () => json(200, { unexpected: true })],
  ])('keeps the SAME key to retry after an unconfirmed %s', async (_name, first) => {
    const run = createManageRunner(keys());
    const send = vi
      .fn()
      .mockImplementationOnce(first)
      .mockImplementation(() => json(200, { ok: 1 }));
    const parse = (b: unknown) => ((b as { ok?: number }).ok ? (b as { ok: number }) : null);
    const outcome = await run.run('same', send, parse);
    expect(outcome).toMatchObject({ kind: 'UNCERTAIN', retrySame: true });
    expect((outcome as { message: string }).message).toContain('could not be confirmed');
    expect((await run.run('same', send, parse)).kind).toBe('DONE');
    expect(send.mock.calls.map((c) => c[0])).toEqual(['key-1', 'key-1']);
  });

  it('never reuses a key for a changed intent', async () => {
    const run = createManageRunner(keys());
    const send = vi.fn().mockImplementation(() => error(503, 'SERVICE_UNAVAILABLE'));
    await run.run('first', send, ok(null));
    await run.run('second', send, ok(null));
    expect(send.mock.calls.map((c) => c[0])).toEqual(['key-1', 'key-2']);
  });

  it.each([
    [401, 'AUTHENTICATION_REQUIRED', 'SIGN_IN', 'Sign in'],
    [403, 'FORBIDDEN', 'DENIED', 'not permitted'],
    [403, 'ACCOUNT_RESTRICTED', 'DENIED', 'not permitted'],
    [404, 'NOT_FOUND', 'GONE', 'no longer'],
    [409, 'REVISION_CHANGED', 'STALE', 'changed'],
    [409, 'GUILD_UPDATE_LIMIT_REACHED', 'LIMIT', 'limit'],
    [422, 'INVALID_COMMAND', 'INVALID', 'Check'],
    [429, 'RATE_LIMITED', 'THROTTLED', 'Too many'],
    [503, 'NOT_AVAILABLE', 'UNAVAILABLE', 'not available'],
  ])(
    'maps %i %s to %s with safe copy and a fresh key next time',
    async (status, code, kind, copy) => {
      const run = createManageRunner(keys());
      const send = vi.fn().mockImplementation(() => error(status, code));
      const outcome = await run.run('x', send, ok(null));
      expect(outcome).toMatchObject({ kind, retrySame: false });
      const message = (outcome as { message: string }).message;
      expect(message.toLowerCase()).toContain(copy.toLowerCase());
      expect(message).not.toContain('Server text');
      await run.run('x', send, ok(null));
      expect(send.mock.calls.map((c) => c[0])).toEqual(['key-1', 'key-2']);
    },
  );

  it('keeps the key when a temporary 401, 403 or 429 follows an unconfirmed attempt', async () => {
    const run = createManageRunner(keys());
    const send = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new TypeError('offline')))
      .mockImplementationOnce(() => error(429, 'RATE_LIMITED'))
      .mockImplementationOnce(() => error(401, 'AUTHENTICATION_REQUIRED'))
      .mockImplementation(() => json(200, { ok: 1 }));
    const parse = (b: unknown) => ((b as { ok?: number }).ok ? (b as { ok: number }) : null);
    await run.run('same', send, parse);
    expect(await run.run('same', send, parse)).toMatchObject({
      kind: 'THROTTLED',
      retrySame: true,
    });
    expect(await run.run('same', send, parse)).toMatchObject({ kind: 'SIGN_IN', retrySame: true });
    expect((await run.run('same', send, parse)).kind).toBe('DONE');
    expect(new Set(send.mock.calls.map((c) => c[0]))).toEqual(new Set(['key-1']));
  });

  it('ignores a second press while the first is in flight', async () => {
    const run = createManageRunner(keys());
    let release!: (r: Response) => void;
    const send = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    const first = run.run('x', send, (b) => b);
    expect(await run.run('x', send, (b) => b)).toEqual({ kind: 'BUSY' });
    release(new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    expect((await first).kind).toBe('DONE');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('Guild management response contracts', () => {
  const sent = { guildId, expectedRevision: 2, profile: { name: 'New name' } };
  it('accepts a profile result that is exactly the command that was sent', () => {
    const body = { status: 'EXECUTED', guild: guild() };
    expect(parseProfileResult(body, sent)).toEqual(body.guild);
    expect(parseProfileResult({ ...body, status: 'REPLAYED' }, sent)).not.toBeNull();
  });
  it.each([
    ['another Guild', { guild: guild({ id: '33333333-3333-4333-8333-333333333333' }) }],
    ['a wrong revision', { guild: guild({ revision: 5 }) }],
    ['a different name', { guild: guild({ name: 'Other' }) }],
    ['an extra field', { guild: guild(), extra: 1 }],
    ['a redacted Founder', { guild: guild({ founderAccountId: null }) }],
  ])('rejects a profile result with %s', (_n, patch) => {
    expect(parseProfileResult({ status: 'EXECUTED', ...patch }, sent)).toBeNull();
  });
  it('checks update results against the exact command', () => {
    const draft = { kind: 'DRAFT' as const, guildId, title: 'T', body: 'B' };
    expect(parseUpdateResult({ status: 'EXECUTED', update: update() }, draft)).not.toBeNull();
    expect(
      parseUpdateResult({ status: 'EXECUTED', update: update({ state: 'PUBLISHED' }) }, draft),
    ).toBeNull();
    expect(
      parseUpdateResult({ status: 'REPLAYED', update: update({ state: 'PUBLISHED' }) }, draft),
    ).not.toBeNull();
    expect(
      parseUpdateResult({ status: 'EXECUTED', update: update({ title: 'X' }) }, draft),
    ).toBeNull();
    const publish = { kind: 'PUBLISH' as const, guildId, updateId };
    const published = update({ state: 'PUBLISHED', publishedAt: '2026-10-30T01:00:00.000Z' });
    expect(parseUpdateResult({ status: 'EXECUTED', update: published }, publish)).not.toBeNull();
    expect(parseUpdateResult({ status: 'EXECUTED', update: update() }, publish)).toBeNull();
    expect(
      parseUpdateResult({ status: 'REPLAYED', update: update({ state: 'WITHDRAWN' }) }, publish),
    ).not.toBeNull();
    const withdraw = { kind: 'WITHDRAW' as const, guildId, updateId };
    expect(
      parseUpdateResult({ status: 'EXECUTED', update: update({ state: 'WITHDRAWN' }) }, withdraw),
    ).not.toBeNull();
    expect(parseUpdateResult({ status: 'REPLAYED', update: published }, withdraw)).toBeNull();
    expect(
      parseUpdateResult(
        { status: 'EXECUTED', update: update({ id: guildId, state: 'WITHDRAWN' }) },
        withdraw,
      ),
    ).toBeNull();
  });
});
