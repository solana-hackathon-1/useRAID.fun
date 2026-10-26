import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkWizard } from '../src/components/work-wizard';
import { createCreationClient } from '../src/work-http/creation-client';
import { WorkClientError, type WorkTransport } from '../src/work-http/workspace-client';
import { CreationStateSchema, toDraftView } from '../src/work-loop/creation-contracts';
import { RaidTermsSchema } from '../src/work-loop/terms';
import { AssetPolicySnapshotSchema } from '../src/contracts/assets';
import { raidTerms } from './helpers/raid-terms-fixture';

const policy = AssetPolicySnapshotSchema.parse(raidTerms().rewards[0].policy);
const terms = RaidTermsSchema.parse({
  ...raidTerms(),
  title: 'Visible title',
  outcome: 'SERVER-DRAFT-OUTCOME',
});
const assets = [{ label: 'Synthetic SOL', policy, funded: true }];
const draft = toDraftView(
  {
    listingId: '11111111-1111-4111-8111-111111111111',
    termsVersionId: '33333333-3333-4333-8333-333333333333',
    revision: 1,
    state: 'DRAFT',
    terms,
    problems: [],
    reserved: false,
  },
  assets,
);
const state = (patch: Record<string, unknown> = {}) =>
  CreationStateSchema.parse({
    version: 'v1',
    assets,
    drafts: [],
    savesAvailable: true,
    publishAvailable: true,
    recommendationsAvailable: false,
    ...patch,
  });
const render = (initial: ReturnType<typeof state>) =>
  renderToStaticMarkup(createElement(WorkWizard, { initialState: initial }));
describe('T018 founder wizard first paint', () => {
  it('renders the first step accessibly and disables controls until the page is interactive', () => {
    const html = render(state());
    expect(html).toContain('Create a Raid');
    expect(html).toContain('Step 1 of 6: Outcome');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('Safe public summary');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('Everything here uses simulated funds');
  });
  it('resumes a saved draft from the server instead of an empty form', () => {
    const html = render(state({ drafts: [draft] }));
    expect(html).toContain('Visible title');
    expect(html).toContain('SERVER-DRAFT-OUTCOME');
  });
  it('says plainly when saving is unavailable and escapes saved text', () => {
    expect(render(state({ savesAvailable: false }))).toContain(
      'Saving drafts is currently unavailable',
    );
    const hostile = RaidTermsSchema.parse({ ...raidTerms(), title: '<script>alert(1)</script>' });
    const html = render(state({ drafts: [toDraftView({ ...draft, terms: hostile }, assets)] }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
describe('T018 creation client', () => {
  const transport = (status: number, body: unknown, seen: unknown[] = []): WorkTransport => ({
    async request(method, path, init) {
      seen.push([method, path, init]);
      return { status, body };
    },
  });
  it('parses the strict state and sends one idempotency key with a save', async () => {
    const seen: unknown[] = [];
    const client = createCreationClient(transport(200, { status: 'EXECUTED', draft }, seen));
    const saved = await client.saveDraft({ listingId: null, expectedRevision: 0, terms }, 'key-1');
    expect(saved.draft.ready).toBe(true);
    expect(seen[0]).toEqual([
      'POST',
      '/api/v1/work/drafts',
      expect.objectContaining({ idempotencyKey: 'key-1' }),
    ]);
    expect((await createCreationClient(transport(200, state())).state()).version).toBe('v1');
  });
  it('fails closed on a contract break and surfaces safe error codes only', async () => {
    await expect(
      createCreationClient(transport(200, { ...state(), surprise: true })).state(),
    ).rejects.toMatchObject({ code: 'CONTRACT' });
    await expect(
      createCreationClient(
        transport(409, { error: { code: 'FUNDING_NOT_VERIFIED', requestId: 'r-1' } }),
      ).publishDraft(draft.listingId, draft.termsVersionId, 'key-2'),
    ).rejects.toEqual(expect.any(WorkClientError));
    await expect(createCreationClient(transport(500, 'oops')).state()).rejects.toMatchObject({
      code: 'CONTRACT',
      status: 500,
    });
  });
  it('publishes to the draft path with the exact version', async () => {
    const seen: unknown[] = [];
    const client = createCreationClient(
      transport(
        200,
        {
          status: 'EXECUTED',
          listingId: draft.listingId,
          termsVersionId: draft.termsVersionId,
          slotId: '22222222-2222-4222-8222-222222222222',
          fundingMode: 'SIMULATED',
        },
        seen,
      ),
    );
    await client.publishDraft(draft.listingId, draft.termsVersionId, 'key-3');
    expect(seen[0]).toEqual([
      'POST',
      `/api/v1/work/drafts/${draft.listingId}/publication`,
      { body: { termsVersionId: draft.termsVersionId }, idempotencyKey: 'key-3' },
    ]);
  });
});
