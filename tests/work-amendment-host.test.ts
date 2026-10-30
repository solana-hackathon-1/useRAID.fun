import { afterEach, describe, expect, it, vi } from 'vitest';
import { workAmendmentsEnabled } from '../src/lib/config';
import { createRootAmendmentHost } from '../src/lib/work-amendment-host';
import type { AssetPolicySnapshot } from '../src/contracts/assets';
import { raidTerms } from './helpers/raid-terms-fixture';

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
