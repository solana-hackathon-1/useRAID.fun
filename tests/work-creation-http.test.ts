import { describe, expect, it, vi } from 'vitest';
import { WorkError } from '../src/work-loop/contracts';
import { WorkHttpError } from '../src/work-http/workspace-http';
import { createCreationHandlers, type CreationHttpHost } from '../src/work-http/creation-http';
import { toDraftView } from '../src/work-loop/creation-contracts';
import { RaidTermsSchema } from '../src/work-loop/terms';
import { AssetPolicySnapshotSchema } from '../src/contracts/assets';
import { raidTerms } from './helpers/raid-terms-fixture';

const actor = { accountId: 'account-1', sessionHash: 'a'.repeat(64) };
const listingId = '11111111111111111111111111111111'.replace(
  /^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/,
  '$1-$2-$3-$4-$5',
);
const versionId = '33333333-3333-4333-8333-333333333333';
const policy = AssetPolicySnapshotSchema.parse(raidTerms().rewards[0].policy);
const terms = RaidTermsSchema.parse(raidTerms());
const draft = toDraftView(
  {
    listingId: '11111111-1111-4111-8111-111111111111',
    termsVersionId: versionId,
    revision: 1,
    state: 'DRAFT',
    terms,
    problems: [],
    reserved: false,
  },
  [{ label: 'Synthetic SOL', policy, funded: true }],
);
const state = {
  version: 'v1' as const,
  assets: [{ label: 'Synthetic SOL', policy, funded: true }],
  drafts: [draft],
  savesAvailable: true,
  publishAvailable: true,
  recommendationsAvailable: false,
};
function host(overrides: Partial<CreationHttpHost> = {}): CreationHttpHost {
  return {
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => actor,
    checkOrigin: () => {},
    rateLimit: () => {},
    state: async () => state,
    saveDraft: async () => ({ status: 'EXECUTED', draft }),
    publishDraft: async () => ({
      status: 'EXECUTED',
      listingId: draft.listingId,
      termsVersionId: versionId,
      slotId: '22222222-2222-4222-8222-222222222222',
      fundingMode: 'SIMULATED',
    }),
    recommend: async () => {
      throw new WorkError('STORAGE_CONTRACT');
    },
    ...overrides,
  };
}
const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: JSON.stringify(payload),
  });
const save = { listingId: null, expectedRevision: 0, terms };
const code = async (r: Response) => (await r.json()).error.code;
void listingId;
describe('T018 creation HTTP boundary', () => {
  it('returns private no-store schema-checked server-derived state', async () => {
    const response = await createCreationHandlers(host()).STATE(
      new Request('http://localhost/api/v1/work/creation'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.drafts[0]).toMatchObject({ ready: true, review: { coverage: 'ALL_FUNDED' } });
  });
  it('fails closed when the host breaks its own contract or claims a draft is ready without coverage', async () => {
    const broken = createCreationHandlers(
      host({ state: async () => ({ ...state, drafts: [{ ...draft, surprise: 1 }] }) }),
    );
    const r = await broken.STATE(new Request('http://localhost/api/v1/work/creation'));
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('SERVICE_UNAVAILABLE');
  });
  it('derives readiness from funding coverage and rejects a host claiming otherwise', async () => {
    const partial = toDraftView(
      {
        listingId: draft.listingId,
        termsVersionId: versionId,
        revision: 1,
        state: 'DRAFT',
        terms,
        problems: [],
        reserved: false,
      },
      [{ label: 'Synthetic SOL', policy, funded: false }],
    );
    expect(partial.ready).toBe(false);
    expect(partial.review.coverage).toBe('NONE');
    expect(partial.problems).toContain('FUNDING_NOT_COVERED');
    const lying = createCreationHandlers(
      host({ state: async () => ({ ...state, drafts: [{ ...partial, ready: true }] }) }),
    );
    const r = await lying.STATE(new Request('http://localhost/api/v1/work/creation'));
    expect(r.status).toBe(503);
  });
  it('requires origin, authentication, rate limit and an idempotency key before any write', async () => {
    const saveDraft = vi.fn();
    for (const [status, mutate] of [
      [403, { checkOrigin: () => Promise.reject(new WorkHttpError(403)) }],
      [401, { actor: () => Promise.reject(new WorkHttpError(401)) }],
      [429, { rateLimit: () => Promise.reject(new WorkHttpError(429)) }],
    ] as const) {
      const r = await createCreationHandlers(host({ saveDraft, ...mutate })).SAVE(
        post('/api/v1/work/drafts', save),
      );
      expect(r.status).toBe(status);
    }
    const noKey = await createCreationHandlers(host({ saveDraft })).SAVE(
      new Request('http://localhost/api/v1/work/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(save),
      }),
    );
    expect(noKey.status).toBe(422);
    expect(saveDraft).not.toHaveBeenCalled();
  });
  it('saves a draft only for strictly valid terms and checks the result matches the request', async () => {
    const saveDraft = vi.fn(async () => ({ status: 'EXECUTED', draft }));
    const handlers = createCreationHandlers(host({ saveDraft }));
    const ok = await handlers.SAVE(post('/api/v1/work/drafts', save));
    expect(ok.status).toBe(200);
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'key-1', input: save }),
    );
    expect((await handlers.SAVE(post('/api/v1/work/drafts', { ...save, extra: 1 }))).status).toBe(
      422,
    );
    expect(
      (
        await handlers.SAVE(
          post('/api/v1/work/drafts', { ...save, terms: { ...terms, title: '' } }),
        )
      ).status,
    ).toBe(422);
    const mismatch = createCreationHandlers(
      host({
        saveDraft: async () => ({
          status: 'EXECUTED',
          draft: { ...draft, terms: { ...terms, title: 'Other' } },
        }),
      }),
    );
    expect((await mismatch.SAVE(post('/api/v1/work/drafts', save))).status).toBe(503);
  });
  it('publishes by listing path and exact version, mapping domain failures to safe codes', async () => {
    const publishDraft = vi.fn(async () => ({
      status: 'EXECUTED' as const,
      listingId: draft.listingId,
      termsVersionId: versionId,
      slotId: '22222222-2222-4222-8222-222222222222',
      fundingMode: 'SIMULATED' as const,
    }));
    const handlers = createCreationHandlers(host({ publishDraft }));
    const ok = await handlers.PUBLISH(
      post('/api/v1/work/drafts/x/publication', { termsVersionId: versionId }),
      draft.listingId,
    );
    expect(ok.status).toBe(200);
    expect(publishDraft).toHaveBeenCalledWith(
      expect.objectContaining({ input: { listingId: draft.listingId, termsVersionId: versionId } }),
    );
    for (const [domain, expected] of [
      ['FUNDING_REQUIRED', 'FUNDING_NOT_VERIFIED'],
      ['PUBLICATION_BLOCKED', 'REVISION_CHANGED'],
      ['TERMS_FROZEN', 'REVISION_CHANGED'],
      ['FORBIDDEN', 'FORBIDDEN'],
    ] as const) {
      const failing = createCreationHandlers(
        host({
          publishDraft: async () => {
            throw new WorkError(domain);
          },
        }),
      );
      const r = await failing.PUBLISH(
        post('/api/v1/work/drafts/x/publication', { termsVersionId: versionId }),
        draft.listingId,
      );
      const text = JSON.stringify(await r.json());
      expect(JSON.parse(text).error.code).toBe(expected);
      expect(text).not.toMatch(/sql|stack|synthetic/i);
    }
    expect(
      (await handlers.PUBLISH(post('/p', { termsVersionId: versionId }), 'not-a-uuid')).status,
    ).toBe(422);
    const otherVersion = createCreationHandlers(
      host({
        publishDraft: async () => ({
          status: 'EXECUTED',
          listingId: draft.listingId,
          termsVersionId: '44444444-4444-4444-8444-444444444444',
          slotId: versionId,
          fundingMode: 'SIMULATED',
        }),
      }),
    );
    expect(
      (await otherVersion.PUBLISH(post('/p', { termsVersionId: versionId }), draft.listingId))
        .status,
    ).toBe(503);
    const wrongSlot = createCreationHandlers(
      host({
        publishDraft: async () => ({
          status: 'EXECUTED',
          listingId: versionId,
          termsVersionId: versionId,
          slotId: versionId,
          fundingMode: 'SIMULATED',
        }),
      }),
    );
    expect(
      (await wrongSlot.PUBLISH(post('/p', { termsVersionId: versionId }), draft.listingId)).status,
    ).toBe(503);
  });
  it('treats recommendations as optional advice that is unavailable unless configured', async () => {
    const handlers = createCreationHandlers(host());
    const r = await handlers.RECOMMEND(
      post('/api/v1/work/recommendations', {
        outcome: 'x',
        acceptanceCriteria: ['y'],
        skillDomains: [{ skillId: 'writing', role: 'PRIMARY' }],
        integrations: 0,
        dependencies: 0,
        uncertainty: 'LOW',
        consequenceOfError: 'LOW',
        verificationCost: 'LOW',
        deadlinePressure: 'NORMAL',
      }),
    );
    expect(r.status).toBe(503);
    expect((await handlers.RECOMMEND(post('/r', { outcome: '' }))).status).toBe(422);
  });
});
