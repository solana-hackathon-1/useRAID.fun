import { afterEach, describe, expect, it, vi } from 'vitest';
import { workAmendmentsEnabled } from '../src/lib/config';
import { createRootAmendmentHost, readAmendmentDeskFromHost } from '../src/lib/work-amendment-host';
import { TermsSnapshotSchema } from '../src/contracts/entities';
import type { AssetPolicySnapshot } from '../src/contracts/assets';
import { raidTerms } from './helpers/raid-terms-fixture';

const { transaction, historyRead } = vi.hoisted(() => ({
  transaction: vi.fn(),
  historyRead: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({ runCommandTransaction: transaction }));
vi.mock('../src/work-loop/amendment-storage', async (original) => ({
  ...(await original<typeof import('../src/work-loop/amendment-storage')>()),
  readEngagementAmendments: historyRead,
}));

const policy = raidTerms().rewards[0].policy as unknown as AssetPolicySnapshot;
const otherPolicy = {
  ...policy,
  assetId: { ...policy.assetId, networkIdentity: 'other-network' },
} as AssetPolicySnapshot;
const tx = {} as never;
const actor = { accountId: 'founder-1', sessionHash: 'a'.repeat(64) };
const target = { engagementId: 'e', guildId: 'g' };
const id = '33333333-3333-4333-8333-333333333333';
const reserve = (host: ReturnType<typeof createRootAmendmentHost>, increase: unknown[]) =>
  host.reserveAdditionalFunding(tx, {
    engagementId: 'e',
    amendmentId: id,
    increase: increase as never,
    terms: {} as never,
  });

describe('T025 root amendment host ports', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('defaults the amendment flag off and requires the exact string true', () => {
    for (const value of ['', 'TRUE', 'false', '1']) {
      vi.stubEnv('WORK_AMENDMENTS_ENABLED', value);
      expect(workAmendmentsEnabled()).toBe(false);
    }
    vi.stubEnv('WORK_AMENDMENTS_ENABLED', 'true');
    expect(workAmendmentsEnabled()).toBe(true);
  });
  it('grants Founder authority only to the synthetic operator allowlist, ignoring the Guild id', async () => {
    const host = createRootAmendmentHost({
      allowNewWrites: true,
      isOperator: (a) => a === 'founder-1',
      catalog: [],
    });
    expect(await host.authorize(tx, actor, target)).toBe(true);
    expect(await host.authorize(tx, { ...actor, accountId: 'other' }, target)).toBe(false);
    expect(await host.authorizeProposer?.(tx, { accountId: 'founder-1' }, target)).toBe(true);
    expect(await host.authorizeProposer?.(tx, { accountId: 'other' }, target)).toBe(false);
    const none = createRootAmendmentHost({ allowNewWrites: true, isOperator: () => false });
    expect(await none.authorize(tx, actor, target)).toBe(false);
  });
  it('mirrors the write switch', () => {
    expect(createRootAmendmentHost({ allowNewWrites: false, catalog: [] }).allowNewWrites).toBe(
      false,
    );
  });
  it('reserves simulated coverage only when every increased leg is funded by the exact catalog policy', async () => {
    const funded = createRootAmendmentHost({
      allowNewWrites: true,
      catalog: [{ label: 'SOL', policy, funded: true }],
    });
    const leg = { policy, amount: '5' };
    expect(await reserve(funded, [leg])).toBe('sim-amendment-reservation:' + id);
    expect(await reserve(funded, [])).toBeNull();
    // A leg whose policy is not the catalog's, or two legs of one asset, are not covered.
    expect(await reserve(funded, [{ policy: otherPolicy, amount: '5' }])).toBeNull();
    expect(await reserve(funded, [leg, leg])).toBeNull();
    expect(await reserve(funded, [leg, { policy: otherPolicy, amount: '5' }])).toBeNull();
    const unfunded = createRootAmendmentHost({
      allowNewWrites: true,
      catalog: [{ label: 'SOL', policy, funded: false }],
    });
    expect(await reserve(unfunded, [leg])).toBeNull();
    expect(
      await reserve(createRootAmendmentHost({ allowNewWrites: true, catalog: [] }), [leg]),
    ).toBeNull();
  });
  it('rechecks the same reservation and coverage at consent time', async () => {
    const catalog = [{ label: 'SOL', policy, funded: true }];
    const host = createRootAmendmentHost({ allowNewWrites: true, catalog });
    const binding = {
      engagementId: 'e',
      amendmentId: id,
      fundingRef: 'sim-amendment-reservation:' + id,
      increase: [{ policy, amount: '5' }],
    };
    expect(await host.fundingAvailable(tx, binding)).toBe(true);
    expect(
      await host.fundingAvailable(tx, { ...binding, fundingRef: 'sim-reservation:slot' }),
    ).toBe(false);
    expect(await host.fundingAvailable(tx, { ...binding, amendmentId: 'other' })).toBe(false);
    const lapsed = createRootAmendmentHost({
      allowNewWrites: true,
      catalog: [{ label: 'SOL', policy, funded: false }],
    });
    expect(await lapsed.fundingAvailable(tx, binding)).toBe(false);
    // #361-7: coverage that now reaches only some of several increased legs is not coverage at consent either.
    const partial = {
      ...binding,
      increase: [
        { policy, amount: '5' },
        { policy: otherPolicy, amount: '5' },
      ],
    };
    expect(await host.fundingAvailable(tx, partial)).toBe(false);
  });
  it('records consent only when the member named the exact digest of this proposal', async () => {
    const digest = 'a'.repeat(64);
    const context = {
      actor,
      participantId: 'p1',
      engagementId: 'e',
      amendmentId: id,
      digest,
      terms: {} as never,
    };
    const named = createRootAmendmentHost({ allowNewWrites: true, expectedDigest: digest });
    expect(await named.assessConsent(tx, context)).toEqual({
      consentRef: `root-amendment-consent:p1:${digest}`,
    });
    const other = createRootAmendmentHost({ allowNewWrites: true, expectedDigest: 'b'.repeat(64) });
    expect(await other.assessConsent(tx, context)).toBeNull();
    expect(
      await createRootAmendmentHost({ allowNewWrites: true }).assessConsent(tx, context),
    ).toBeNull();
  });
});

describe('#361-4 desk reads the Founder current terms after the history', () => {
  const engagementId = '44444444-4444-4444-8444-444444444444';
  const snapshot = (scope: string) =>
    TermsSnapshotSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      guildId: 'synthetic-guild',
      revision: 1,
      scope,
      acceptanceCriteria: ['A clean installation completes.'],
      requiredSkills: [],
      roster: [
        {
          participantId: '55555555-5555-4555-8555-555555555555',
          responsibility: 'Author',
          consentRef: 'consent-1',
        },
      ],
      rewards: [
        {
          policy: raidTerms().rewards[0].policy,
          amount: '1000000000',
          beneficiaryParticipantId: '55555555-5555-4555-8555-555555555555',
          beneficiaryRef: 'beneficiary-1',
        },
      ],
      deadlines: {
        preparation: '2026-11-02T00:00:00.000Z',
        submission: '2026-11-10T00:00:00.000Z',
        review: '2026-11-15T00:00:00.000Z',
        operationalClosure: '2026-11-20T00:00:00.000Z',
      },
      eligibilityPolicyVersion: 'e1',
      allowedToolsPolicyVersion: 't1',
      revisionPolicyVersion: 'r1',
      withdrawalPolicyVersion: 'w1',
      terminationPolicyVersion: 'x1',
      rubricVersion: null,
      rightsPolicyVersion: 'g1',
      reviewPolicyVersion: 'v1',
      disputePolicyVersion: 'd1',
      finalityPolicyVersion: 'f1',
      createdAt: '2026-10-30T00:00:00.000Z',
    });
  const before = snapshot('Scope before the consent.');
  const after = snapshot('Scope after the consent.');
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it('shows terms agreed between the engagement list and the history read, not the listed copy', async () => {
    vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
    vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', 'founder-1');
    let consented = false;
    historyRead.mockImplementation(async () => {
      // The member's consent commits after the engagement list was read and before the history is.
      consented = true;
      return [];
    });
    transaction.mockImplementation(async (_db, work) =>
      work({
        query: async (sql: string) => {
          if (sql.includes('"creatorAccountId"'))
            return [{ id: engagementId, state: 'IN_PROGRESS', title: 'Task', terms: before }];
          if (sql.includes('p."accountId"=$1')) return [];
          if (sql.includes('raid_effective_terms')) return [{ terms: consented ? after : before }];
          throw new Error('unexpected query: ' + sql);
        },
      }),
    );
    const desk = await readAmendmentDeskFromHost(actor);
    expect(desk.engagements).toHaveLength(1);
    expect(desk.engagements[0]).toMatchObject({ role: 'FOUNDER', engagementId });
    expect(desk.engagements[0].effectiveTerms.scope).toBe('Scope after the consent.');
    // The history read still proves Founder authority first; the fresh copy is read in that same transaction.
    expect(historyRead).toHaveBeenCalledTimes(1);
  });
});
