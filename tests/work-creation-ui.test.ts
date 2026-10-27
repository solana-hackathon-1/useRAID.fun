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
  renderToStaticMarkup(
    createElement(WorkWizard, { accountId: 'founder-1', initialState: initial }),
  );
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

it('keeps exact pending intent when a successful response breaks its result contract', async () => {
  const { saveWizardIntent } = await import('../src/work-loop/creation-recovery');
  const { defaultWizardForm } = await import('../src/work-loop/creation-form');
  const input = { listingId: null, expectedRevision: 0, terms };
  const pending = {
    input,
    key: '11111111-1111-4111-8111-111111111111',
    fingerprint: 'original-form',
  };
  let persisted: unknown;
  await expect(
    saveWizardIntent({
      recovery: {
        version: 'v1',
        accountId: 'founder-1',
        form: defaultWizardForm(),
        binding: null,
        pending,
      },
      input,
      fingerprint: 'edited-form',
      key: '22222222-2222-4222-8222-222222222222',
      persist: (value) => {
        persisted = value;
      },
      save: async () => {
        throw new WorkClientError('CONTRACT', 200);
      },
    }),
  ).rejects.toMatchObject({ code: 'CONTRACT' });
  expect(persisted).toMatchObject({ pending });
});

it('rejects malformed and cross-account stored form envelopes before rendering', async () => {
  const { readWizardRecovery, writeWizardRecovery } =
    await import('../src/work-loop/creation-recovery');
  const { defaultWizardForm } = await import('../src/work-loop/creation-form');
  const values = new Map<string, string>();
  const store = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const recovery = {
    version: 'v1' as const,
    accountId: 'founder-1',
    form: defaultWizardForm(),
    binding: null,
    pending: null,
  };
  writeWizardRecovery(store, recovery);
  expect(readWizardRecovery(store, 'founder-1')).toEqual(recovery);
  expect(readWizardRecovery(store, 'other-person')).toBeNull();
  const key = 'raid-wizard-recovery-v1:founder-1';
  for (const bad of [
    { ...recovery, accountId: 'other-person' },
    { ...recovery, form: { ...recovery.form, skills: null } },
    { ...recovery, form: { ...recovery.form, days: null } },
    { ...recovery, pending: { key: 'malformed', input: {}, fingerprint: '' } },
  ]) {
    store.setItem(key, JSON.stringify(bad));
    expect(readWizardRecovery(store, 'founder-1')).toBeNull();
    expect(store.getItem(key)).toBeNull();
  }
});
it('never sends a new save if exact recovery cannot be persisted first', async () => {
  const { saveWizardIntent } = await import('../src/work-loop/creation-recovery');
  const { defaultWizardForm } = await import('../src/work-loop/creation-form');
  let sent = 0;
  await expect(
    saveWizardIntent({
      recovery: {
        version: 'v1',
        accountId: 'founder-1',
        form: defaultWizardForm(),
        binding: null,
        pending: null,
      },
      input: { listingId: null, expectedRevision: 0, terms },
      fingerprint: 'form',
      key: '11111111-1111-4111-8111-111111111111',
      persist: () => {
        throw Error('Storage unavailable');
      },
      save: async () => {
        sent++;
        return { status: 'EXECUTED', draft };
      },
    }),
  ).rejects.toThrow('Storage unavailable');
  expect(sent).toBe(0);
});

it('retains an unconfirmed first save through expired session until reconciliation', async () => {
  const { saveWizardIntent } = await import('../src/work-loop/creation-recovery');
  const { defaultWizardForm } = await import('../src/work-loop/creation-form');
  const pending = {
    input: { listingId: null, expectedRevision: 0, terms },
    key: '11111111-1111-4111-8111-111111111111',
    fingerprint: 'original',
  };
  let current = {
    version: 'v1' as const,
    accountId: 'founder-1',
    form: defaultWizardForm(),
    binding: null,
    pending,
  };
  await expect(
    saveWizardIntent({
      recovery: current,
      input: pending.input,
      fingerprint: 'edited',
      key: '22222222-2222-4222-8222-222222222222',
      persist: (value) => {
        current = value as typeof current;
      },
      save: async () => {
        throw new WorkClientError('UNAUTHENTICATED', 401);
      },
    }),
  ).rejects.toMatchObject({ status: 401 });
  expect(current.pending).toEqual(pending);
});
it('keeps fresh intent when a successful response breaks its result contract', async () => {
  const { saveWizardIntent } = await import('../src/work-loop/creation-recovery');
  const { defaultWizardForm } = await import('../src/work-loop/creation-form');
  const input = { listingId: null, expectedRevision: 0, terms };
  const key = '11111111-1111-4111-8111-111111111111';
  let persisted: unknown;
  await expect(
    saveWizardIntent({
      recovery: {
        version: 'v1',
        accountId: 'founder-1',
        form: defaultWizardForm(),
        binding: null,
        pending: null,
      },
      input,
      fingerprint: 'form',
      key,
      persist: (value) => {
        persisted = value;
      },
      save: async () => {
        throw new WorkClientError('CONTRACT', 200);
      },
    }),
  ).rejects.toMatchObject({ code: 'CONTRACT' });
  expect(persisted).toMatchObject({ pending: { input, key, fingerprint: 'form' } });
});
it('resolves the original request before edited intent after authorization returns', async () => {
  const { saveWizardIntent } = await import('../src/work-loop/creation-recovery');
  const { defaultWizardForm } = await import('../src/work-loop/creation-form');
  const pending = {
    input: { listingId: null, expectedRevision: 0, terms },
    key: '11111111-1111-4111-8111-111111111111',
    fingerprint: 'original',
  };
  let current: import('../src/work-loop/creation-recovery').WizardRecovery = {
    version: 'v1',
    accountId: 'founder-1',
    form: defaultWizardForm(),
    binding: null,
    pending,
  };
  const base = {
    input: { listingId: null, expectedRevision: 0, terms: { ...terms, title: 'Edited' } },
    fingerprint: 'edited',
    key: '22222222-2222-4222-8222-222222222222',
    persist: (value: typeof current) => {
      current = value;
    },
  };
  await expect(
    saveWizardIntent({
      ...base,
      recovery: current,
      save: async () => {
        throw new WorkClientError('FORBIDDEN', 403);
      },
    }),
  ).rejects.toMatchObject({ status: 403 });
  const sent: {
    input: import('../src/work-http/creation-client').SaveDraftRequest;
    key: string;
  }[] = [];
  await saveWizardIntent({
    ...base,
    recovery: current,
    save: async (input, key) => {
      sent.push({ input, key });
      return {
        status: sent.length === 1 ? 'REPLAYED' : 'EXECUTED',
        draft: { ...draft, revision: sent.length, terms: RaidTermsSchema.parse(input.terms) },
      };
    },
  });
  expect(sent[0]).toEqual({ input: pending.input, key: pending.key });
  expect(sent[1].input.listingId).toBe(draft.listingId);
  expect(sent[1].input.expectedRevision).toBe(1);
  expect(sent[1].key).toBe(base.key);
  expect(current.pending).toBeNull();
});
