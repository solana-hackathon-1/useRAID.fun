import bs58 from 'bs58';
import { expect, it, vi } from 'vitest';
import {
  createGuildProjectProposalHandlers,
  GuildProjectProposalHttpError,
  type GuildProjectProposalHttpHost,
} from '../src/guild-profiles/project-proposal-http';
import { GuildDraftStorageError } from '../src/guild-profiles/draft-storage-contracts';
import { CommandReceiptError } from '../src/command-receipts';
const draftId = '11111111-1111-4111-8111-111111111111';
const candidateToken = {
  chain: 'SOLANA',
  networkIdentity: 'synthetic-genesis',
  kind: 'TOKEN',
  mint: bs58.encode(new Uint8Array(32).fill(17)),
  tokenProgram: bs58.encode(new Uint8Array(32).fill(18)),
};
const body = {
  expectedDraftRevision: 1,
  expectedProposalRevision: 0,
  candidateToken,
  publicEvidenceRefs: ['https://public.example/project'],
};
const proposal = {
  version: 'v1',
  id: '22222222-2222-4222-8222-222222222222',
  guildDraftId: draftId,
  revision: 1,
  draftRevision: 1,
  recordedAt: '2026-10-13T10:00:00.000Z',
  projectType: 'EXISTING_PROJECT',
  state: 'PENDING_VERIFICATION',
  persisted: true,
  candidateToken,
  publicEvidenceRefs: body.publicEvidenceRefs,
  founderControlVerified: false,
  recognizesGuild: false,
  activatesToken: false,
  createsPermissionGrant: false,
  publicProfileApproved: false,
};
const actor = {
  accountId: 'synthetic-owner',
  actorAccountId: 'synthetic-owner',
  sessionHash: 'a'.repeat(64),
};
const configuration = { writesAvailable: true, unavailableReason: null };
function host(overrides: Partial<GuildProjectProposalHttpHost> = {}) {
  return {
    version: 'v1' as const,
    actor: vi.fn(async () => actor),
    checkOrigin: vi.fn(() => {}),
    rateLimit: vi.fn(async () => {}),
    read: vi.fn(async () => ({ version: 'v1', guildDraftId: draftId, proposal, ...configuration })),
    save: vi.fn(async () => ({
      version: 'v1',
      guildDraftId: draftId,
      status: 'EXECUTED',
      proposal,
      ...configuration,
    })),
    requestId: () => 'request-1',
    ...overrides,
  };
}
const request = (input: unknown = body, headers: Record<string, string> = {}) =>
  new Request('https://raid.example/api/v1/guild-drafts/' + draftId + '/project-proposal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://raid.example',
      'Idempotency-Key': 'proposal-1',
      ...headers,
    },
    body: JSON.stringify(input),
  });
function privacy(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toContain('Cookie');
}
it('serves private own pending state and writes only URL-bound currentactor/revision/candidate data', async () => {
  const h = host(),
    api = createGuildProjectProposalHandlers(h);
  const read = await api.GET(new Request('https://raid.example'), Promise.resolve(draftId));
  expect(read.status).toBe(200);
  privacy(read);
  expect((await read.json()).proposal).toEqual(proposal);
  const saved = await api.POST(request(), Promise.resolve(draftId));
  expect(saved.status).toBe(200);
  privacy(saved);
  expect((await saved.json()).proposal).toEqual(proposal);
  expect(h.save).toHaveBeenCalledWith({
    actor,
    input: { guildDraftId: draftId, ...body },
    idempotencyKey: 'proposal-1',
    requestId: 'request-1',
  });
  expect(h.checkOrigin).toHaveBeenCalledOnce();
  expect(h.rateLimit).toHaveBeenCalledWith(actor);
});
it('returns own null state and supports original replay while newwrites are disabled', async () => {
  const h = host({
    read: async () => ({
      version: 'v1',
      guildDraftId: draftId,
      proposal: null,
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    }),
    save: async () => ({
      version: 'v1',
      guildDraftId: draftId,
      proposal,
      status: 'REPLAYED',
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    }),
  });
  const api = createGuildProjectProposalHandlers(h);
  const read = await api.GET(new Request('https://raid.example'), draftId);
  expect(read.status).toBe(200);
  expect((await read.json()).proposal).toBeNull();
  const post = await api.POST(request(), draftId);
  expect(post.status).toBe(200);
  expect((await post.json()).status).toBe('REPLAYED');
});
it.each([401, 403, 429] as const)(
  'rejects host authority %s before mutations without leaking secrets',
  async (status) => {
    const h = host({
      actor: async () => {
        throw new GuildProjectProposalHttpError(status);
      },
    });
    const api = createGuildProjectProposalHandlers(h);
    for (const response of [
      await api.GET(new Request('https://raid.example'), draftId),
      await api.POST(request(), draftId),
    ]) {
      expect(response.status).toBe(status);
      privacy(response);
    }
    expect(h.save).not.toHaveBeenCalled();
  },
);
it('rejects foreign origin/rate denial before writing', async () => {
  for (const field of ['checkOrigin', 'rateLimit'] as const) {
    const h = host({
      [field]: async () => {
        throw new GuildProjectProposalHttpError(field === 'checkOrigin' ? 403 : 429);
      },
    });
    const response = await createGuildProjectProposalHandlers(h).POST(request(), draftId);
    expect(response.status).toBe(field === 'checkOrigin' ? 403 : 429);
    privacy(response);
    expect(h.save).not.toHaveBeenCalled();
  }
});
it.each([
  'actor',
  'guildDraftId',
  'role',
  'founderControlVerified',
  'recognizesGuild',
  'signature',
])('rejects injected caller %s', (field) => {
  const h = host();
  return createGuildProjectProposalHandlers(h)
    .POST(request({ ...body, [field]: 'forged' }), draftId)
    .then(async (response) => {
      expect(response.status).toBe(422);
      privacy(response);
      expect(h.save).not.toHaveBeenCalled();
    });
});
it.each([
  'UNAUTHENTICATED',
  'ACCOUNT_RESTRICTED',
  'WRONG_ACTOR',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'WRITES_DISABLED',
  'INVALID_INPUT',
  'STORAGE_UNAVAILABLE',
] as const)('maps storage %s without private details', async (code) => {
  const h = host({
    save: async () => {
      throw new GuildDraftStorageError(code);
    },
  });
  const response = await createGuildProjectProposalHandlers(h).POST(request(), draftId);
  const status = {
    UNAUTHENTICATED: 401,
    ACCOUNT_RESTRICTED: 403,
    WRONG_ACTOR: 403,
    NOT_FOUND: 404,
    REVISION_CONFLICT: 409,
    WRITES_DISABLED: 503,
    INVALID_INPUT: 422,
    STORAGE_UNAVAILABLE: 503,
  }[code];
  expect(response.status).toBe(status);
  privacy(response);
  expect(JSON.stringify(await response.json())).not.toMatch(
    /synthetic-owner|synthetic-genesis|public.example|11111111|a{64}/,
  );
});
it('maps changed-body receipt conflict and suppresses unknown provider error text', async () => {
  for (const [error, status] of [
    [new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'), 409],
    [new Error('private-provider-secret'), 503],
  ] as const) {
    const response = await createGuildProjectProposalHandlers(
      host({
        save: async () => {
          throw error;
        },
      }),
    ).POST(request(), draftId);
    expect(response.status).toBe(status);
    privacy(response);
    expect(JSON.stringify(await response.json())).not.toContain('private-provider-secret');
  }
});
it.each([
  { guildDraftId: '33333333-3333-4333-8333-333333333333' },
  { revision: 2 },
  { draftRevision: 2 },
  { candidateToken: { ...candidateToken, networkIdentity: 'other-genesis' } },
  { candidateToken: { ...candidateToken, mint: bs58.encode(new Uint8Array(32).fill(20)) } },
  { publicEvidenceRefs: ['https://public.example/other'] },
  { founderControlVerified: true },
  { privateNotes: 'private-secret' },
])('rejects success-shaped wrongresource/snapshot/private DTO %j', async (patch) => {
  const h = host({
    save: async () => ({
      version: 'v1',
      guildDraftId: draftId,
      status: 'EXECUTED',
      proposal: { ...proposal, ...patch },
      ...configuration,
    }),
  });
  const response = await createGuildProjectProposalHandlers(h).POST(request(), draftId);
  expect(response.status).toBe(503);
  privacy(response);
  expect(JSON.stringify(await response.json())).not.toContain('private-secret');
});
it('rejects wrong-resource read including null and malformed capability state', async () => {
  for (const value of [
    {
      version: 'v1',
      guildDraftId: '33333333-3333-4333-8333-333333333333',
      proposal: null,
      ...configuration,
    },
    {
      version: 'v1',
      guildDraftId: draftId,
      proposal,
      writesAvailable: false,
      unavailableReason: null,
    },
    {
      version: 'v1',
      guildDraftId: draftId,
      proposal: { ...proposal, guildDraftId: '33333333-3333-4333-8333-333333333333' },
      ...configuration,
    },
  ]) {
    const response = await createGuildProjectProposalHandlers(
      host({ read: async () => value }),
    ).GET(new Request('https://raid.example'), draftId);
    expect(response.status).toBe(503);
    privacy(response);
  }
});
it('accepts uppercase equivalent UUIDs and normalizes references before binding saved snapshots', async () => {
  const mixed = 'abcdefab-abcd-4bcd-8bcd-abcdefabcdef';
  const h = host({
    save: async () => ({
      version: 'v1',
      guildDraftId: mixed,
      status: 'EXECUTED',
      proposal: {
        ...proposal,
        guildDraftId: mixed,
        publicEvidenceRefs: ['https://public.example/'],
      },
      ...configuration,
    }),
  });
  const response = await createGuildProjectProposalHandlers(h).POST(
    request({ ...body, publicEvidenceRefs: ['https://PUBLIC.EXAMPLE'] }),
    mixed.toUpperCase(),
  );
  expect(response.status).toBe(200);
});
it('rejects malformed route/key/content type/actual bytes without dispatch', async () => {
  for (const [req, id, status] of [
    [request(), 'bad-id', 422],
    [request(body, { 'Idempotency-Key': '' }), draftId, 422],
    [request(body, { 'Content-Type': 'text/plain' }), draftId, 415],
    [
      request(
        { ...body, publicEvidenceRefs: ['https://public.example/' + 'x'.repeat(17000)] },
        { 'Content-Length': '1' },
      ),
      draftId,
      413,
    ],
  ] as const) {
    const h = host();
    const response = await createGuildProjectProposalHandlers(h).POST(req, id);
    expect(response.status).toBe(status);
    privacy(response);
    expect(h.save).not.toHaveBeenCalled();
  }
});
it('rejects unsupported hostversion and uses a safe requestid fallback', async () => {
  expect(() => createGuildProjectProposalHandlers({ ...host(), version: 'v2' as 'v1' })).toThrow(
    'STORAGE_CONTRACT',
  );
  const h = host({
    requestId: () => {
      throw Error('private-secret');
    },
    save: async () => {
      throw new Error('private-secret');
    },
  });
  const response = await createGuildProjectProposalHandlers(h).POST(request(), draftId);
  expect(response.status).toBe(503);
  const result = await response.json();
  expect(result.error.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(result)).not.toContain('private-secret');
});

it('keeps shared preparation cache policy private when an importing host tries to change it', async () => {
  const { guildPreparationHeaders } = await import('../src/guild-profiles/http-errors');
  const cache = guildPreparationHeaders['Cache-Control'];
  try {
    Reflect.set(guildPreparationHeaders, 'Cache-Control', 'public, max-age=3600');
    const response = await createGuildProjectProposalHandlers(host()).GET(
      new Request('https://raid.example'),
      draftId,
    );
    privacy(response);
  } finally {
    Reflect.set(guildPreparationHeaders, 'Cache-Control', cache);
  }
});
