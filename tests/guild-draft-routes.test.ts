import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  rate: vi.fn(),
  state: vi.fn(),
  save: vi.fn(),
  cookie: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../src/lib/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/auth')>()),
  requireUser: mocks.user,
  rateLimit: mocks.rate,
}));
vi.mock('../src/lib/guild-draft-host', () => ({
  readGuildDraftState: mocks.state,
  saveDraft: mocks.save,
}));
import { POST } from '../src/app/api/v1/guild-drafts/route';
import { GET } from '../src/app/api/v1/guild-drafts/[id]/route';
const draftId = '11111111-1111-4111-8111-111111111111';
const get = (id = draftId) =>
  GET(new Request('http://localhost:3014/api/v1/guild-drafts/' + id), {
    params: Promise.resolve({ id }),
  });
import { hash, HttpError } from '../src/lib/auth-primitives';
import { config } from '../src/lib/config';
import { GuildDraftStorageError } from '../src/guild-profiles/draft-storage-contracts';
import { CommandReceiptError } from '../src/command-receipts';
import { routeRequest } from './helpers/route';
const profile = {
  name: 'Synthetic Guild',
  slug: 'synthetic-guild',
  description: 'Synthetic draft',
};
const input = { guildDraftId: null, expectedRevision: 0, profile };
const draft = {
  version: 'v1',
  id: draftId,
  state: 'DRAFT_UNVERIFIED',
  revision: 1,
  recordedAt: '2026-10-13T00:00:00.000Z',
  profile,
  founderControlVerified: false,
  publicProfileApproved: false,
  primaryToken: null,
};
const post = (
  body: unknown = input,
  headers: Record<string, string> = {},
  origin = 'http://localhost:3014',
) =>
  POST(
    routeRequest('http://localhost:3014/api/v1/guild-drafts', {
      body,
      origin,
      headers: { 'Idempotency-Key': 'save-1', ...headers },
    }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  config.demo = false;
  config.appUrl = 'http://localhost:3014';
  mocks.user.mockResolvedValue({ id: 'synthetic-self' });
  mocks.cookie.mockReturnValue({ value: 'synthetic-cookie' });
  mocks.state.mockResolvedValue({
    version: 'v1',
    draft,
    writesAvailable: true,
    unavailableReason: null,
  });
  mocks.save.mockResolvedValue({ status: 'EXECUTED', draft });
});
it('resolves account and session only from the own server cookie and returns private no-store data', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toContain('Cookie');
  expect(mocks.state).toHaveBeenCalledWith(
    {
      accountId: 'synthetic-self',
      actorAccountId: 'synthetic-self',
      sessionHash: hash('synthetic-cookie'),
    },
    draftId,
  );
  expect(await response.json()).toMatchObject({ draft });
  const saved = await post();
  expect(saved.status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({
      actor: {
        accountId: 'synthetic-self',
        actorAccountId: 'synthetic-self',
        sessionHash: hash('synthetic-cookie'),
      },
      idempotencyKey: 'save-1',
      input,
    }),
  );
});
it('denies missing authentication and missing own cookie without a storage call', async () => {
  mocks.user.mockRejectedValue(new HttpError(401, 'Sign in'));
  expect((await get()).status).toBe(401);
  expect((await post()).status).toBe(401);
  mocks.user.mockResolvedValue({ id: 'synthetic-self' });
  mocks.cookie.mockReturnValue(undefined);
  expect((await post()).status).toBe(401);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.state).not.toHaveBeenCalled();
});
it('rejects foreign request origins, injected fields and invalid keys before saving', async () => {
  expect((await post(input, {}, 'https://foreign.invalid')).status).toBe(403);
  for (const body of [
    { ...input, actorId: 'foreign' },
    { ...input, sessionHash: 'forged' },
    { ...input, profile: { ...profile, rank: 'S' } },
  ])
    expect((await post(body)).status).toBe(422);
  expect((await post(input, { 'Idempotency-Key': '' })).status).toBe(422);
  expect((await post(input, { 'Idempotency-Key': 'invalid key' })).status).toBe(422);
  expect(mocks.save).not.toHaveBeenCalled();
});
it('bounds streamed input even when content-length is absent or lies', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }] as Record<string, string>[]) {
    const response = await POST(
      routeRequest('http://localhost:3014/api/v1/guild-drafts', {
        method: 'POST',
        origin: 'http://localhost:3014',
        headers: { 'Idempotency-Key': 'save-1', ...headers },
        rawBody: 'x'.repeat(16385),
      }),
    );
    expect(response.status).toBe(413);
  }
  expect(mocks.save).not.toHaveBeenCalled();
});
it('denies malformed JSON and non-JSON content without forwarding private details', async () => {
  expect(
    (
      await POST(
        routeRequest('http://localhost:3014/api/v1/guild-drafts', {
          method: 'POST',
          origin: 'http://localhost:3014',
          headers: { 'Idempotency-Key': 'save-1' },
          rawBody: '{private-malformed',
        }),
      )
    ).status,
  ).toBe(422);
  expect((await post(input, { 'Content-Type': 'text/plain' })).status).toBe(415);
  expect(mocks.save).not.toHaveBeenCalled();
});
it.each([
  ['REVISION_CONFLICT', 409],
  ['ACCOUNT_RESTRICTED', 403],
  ['UNAUTHENTICATED', 401],
  ['STORAGE_UNAVAILABLE', 503],
  ['NOT_FOUND', 404],
  ['SLUG_UNAVAILABLE', 409],
  ['SLUG_IMMUTABLE', 422],
] as const)('maps %s to a sanitized error', async (code, status) => {
  mocks.save.mockRejectedValue(new GuildDraftStorageError(code));
  const response = await post();
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toMatchObject({
    error: { code: expect.any(String), requestId: expect.any(String) },
  });
});
it('maps idempotency conflicts, retryable storage failures and rate denial', async () => {
  mocks.save.mockRejectedValue(new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'));
  expect((await post()).status).toBe(409);
  mocks.save.mockRejectedValue(new CommandReceiptError('RETRY_TRANSACTION'));
  expect((await post()).status).toBe(503);
  mocks.rate.mockRejectedValue(new HttpError(429, 'Limit'));
  expect((await post()).status).toBe(429);
});
it('never logs an unknown driver failure or its private message', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mocks.save.mockRejectedValue(Error('private-cookie-and-portfolio'));
    const res = await post();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('private-cookie-and-portfolio');
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it('times out a stalled request stream and releases its owned reader', async () => {
  vi.useFakeTimers();
  try {
    const request = new Request(
      'http://localhost:3014/api/v1/guild-drafts',
      Object.assign(
        {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3014',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'stalled',
          },
          body: new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
          }),
        },
        { duplex: 'half' },
      ),
    );
    const response = POST(request);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await response).status).toBe(408);
    expect(mocks.save).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('authenticates before resource parsing and returns private uniform absence for missing or foreign drafts', async () => {
  expect((await get('not-a-uuid')).status).toBe(422);
  expect(mocks.state).not.toHaveBeenCalled();
  for (const id of [draftId, '22222222-2222-4222-8222-222222222222']) {
    mocks.state.mockRejectedValue(new GuildDraftStorageError('NOT_FOUND'));
    const r = await get(id);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  }
  mocks.user.mockRejectedValue(new HttpError(401, 'Sign in'));
  expect((await get('not-a-uuid')).status).toBe(401);
});
it('fails closed when a storage host supplies private extra response fields', async () => {
  mocks.state.mockResolvedValue({
    version: 'v1',
    draft,
    writesAvailable: true,
    unavailableReason: null,
    sessionHash: 'private-response',
  });
  const r = await get();
  expect(r.status).toBe(503);
  expect(JSON.stringify(await r.json())).not.toContain('private-response');
});
it('rejects a valid DTO that belongs to another requested draft or command snapshot', async () => {
  mocks.state.mockResolvedValue({
    version: 'v1',
    draft: { ...draft, id: '22222222-2222-4222-8222-222222222222' },
    writesAvailable: true,
    unavailableReason: null,
  });
  expect((await get()).status).toBe(503);
  mocks.save.mockResolvedValue({
    status: 'EXECUTED',
    draft: { ...draft, profile: { ...profile, description: 'Another record' } },
  });
  expect((await post()).status).toBe(503);
  mocks.save.mockResolvedValue({ status: 'REPLAYED', draft: { ...draft, revision: 2 } });
  expect((await post()).status).toBe(503);
});
