import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { readFeedAssets, readWorkFeed } from '../src/work-loop/feed-storage';
import { readFeedAssetsFromHost, readFeedFromHost } from '../src/lib/work-feed-host';
import { parseRewardMinimum } from '../src/work-loop/feed-reward-input';
import { FeedQuerySchema } from '../src/work-loop/feed-contracts';
import { assetKey } from '../src/contracts/assets';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkSlot } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

/** T097 (§18.1–18.2, I03): minimum reward inside ONE asset, applied before paging; default-off host flag. */
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const day = 86400000;
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const deadlines = () => ({
  commitment: ahead(6 * day),
  preparation: ahead(7 * day),
  submission: ahead(8 * day),
  review: ahead(9 * day),
  operationalClosure: ahead(10 * day),
});
const native = raidTerms().rewards[0];
const tokenAsset = {
  chain: 'SOLANA' as const,
  networkIdentity: 'synthetic-work',
  kind: 'TOKEN' as const,
  mint: 'So11111111111111111111111111111111111111112',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};
const tokenLeg = (amount: string) => ({
  policy: {
    ...native.policy,
    assetId: tokenAsset,
    verifiedDecimals: 6,
    supportedExtensionProfile: 'none',
  },
  amount,
});
const nativeKey = assetKey({
  chain: 'SOLANA',
  networkIdentity: 'synthetic-work',
  kind: 'NATIVE_SOL',
});
const tokenKey = assetKey(tokenAsset);
const feed = (query: unknown = {}) => run((tx) => readWorkFeed(tx, query));
const post = (title: string, rewards: unknown[]) =>
  seedWorkSlot(db, undefined, { title, rewards: rewards as never, deadlines: deadlines() });
async function seed() {
  // Posted oldest to newest, so "newest first" reads: mixed, tokenBig, big, small.
  const small = await post('Small SOL', [{ ...native, amount: '1000' }]);
  const big = await post('Big SOL', [{ ...native, amount: '5000' }]);
  const tokenBig = await post('Big token', [tokenLeg('9000')]);
  // 2000 SOL base units + 9 token base units: a SOL minimum must look only at SOL, a token minimum only at the token.
  const mixed = await post('Mixed', [{ ...native, amount: '2000' }, tokenLeg('9')]);
  return { small, big, tokenBig, mixed };
}
const ids = async (query: unknown) => (await feed(query)).items.map((i) => i.listingId);
const list = (...s: { listingId: string }[]) => s.map((x) => x.listingId);

integration('T097 minimum reward within one asset', { timeout: 60000 }, () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('keeps only Raids whose reward in the chosen asset reaches the minimum, never mixing assets', async () => {
    const { small, big, tokenBig, mixed } = await seed();
    expect(await ids({ assetKey: nativeKey, minReward: '1000' })).toEqual(list(mixed, big, small));
    expect(await ids({ assetKey: nativeKey, minReward: '2000' })).toEqual(list(mixed, big));
    expect(await ids({ assetKey: nativeKey, minReward: '5001' })).toEqual([]);
    // 9000 token units do not satisfy a SOL minimum, and 5000 lamports do not satisfy a token minimum.
    expect(await ids({ assetKey: tokenKey, minReward: '9' })).toEqual(list(mixed, tokenBig));
    expect(await ids({ assetKey: tokenKey, minReward: '10' })).toEqual(list(tokenBig));
    const page = await feed({ assetKey: nativeKey, minReward: '2000', sort: 'reward' });
    expect(page.rewardComparable).toBe(true);
    expect(page.items.map((i) => i.listingId)).toEqual(list(big, mixed));
  });
  it('applies the minimum before paging so no page is empty and the cursor skips nothing', async () => {
    const { small, big, tokenBig, mixed } = await seed();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await feed({ assetKey: nativeKey, minReward: '2000', limit: 1, cursor });
      expect(page.items).toHaveLength(1);
      seen.push(...page.items.map((i) => i.listingId));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(seen).toEqual(list(mixed, big));
    expect(pages).toBe(2);
    expect(seen).not.toContain(small.listingId);
    expect(seen).not.toContain(tokenBig.listingId);
  });
  it('leaves the feed untouched when no minimum is given', async () => {
    const { small, big, tokenBig, mixed } = await seed();
    expect(await ids({})).toEqual(list(mixed, tokenBig, big, small));
  });
  it('refuses a minimum without one asset, and a malformed or non-integer minimum', () => {
    for (const bad of [
      { minReward: '10' },
      { assetKey: nativeKey, minReward: '-1' },
      { assetKey: nativeKey, minReward: '1.5' },
      { assetKey: nativeKey, minReward: '01' },
      { assetKey: nativeKey, minReward: '' },
      { assetKey: nativeKey, minReward: 10 },
    ])
      expect(FeedQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(FeedQuerySchema.safeParse({ assetKey: nativeKey, minReward: '0' }).success).toBe(true);
  });
  it('is closed by default on the host and honoured only while WORK_FEED_REWARD_FILTER_ENABLED is exactly true', async () => {
    const { big, mixed } = await seed();
    const query = FeedQuerySchema.parse({ assetKey: nativeKey, minReward: '2000' });
    const was = process.env.WORK_FEED_REWARD_FILTER_ENABLED;
    try {
      delete process.env.WORK_FEED_REWARD_FILTER_ENABLED;
      await expect(readFeedFromHost(query)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      process.env.WORK_FEED_REWARD_FILTER_ENABLED = 'TRUE';
      await expect(readFeedFromHost(query)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      // The plain feed and the asset filter alone are unchanged while the flag is off.
      expect((await readFeedFromHost({ assetKey: nativeKey })).items).toHaveLength(3);
      process.env.WORK_FEED_REWARD_FILTER_ENABLED = 'true';
      const on = await readFeedFromHost(query);
      expect(on.items.map((i) => i.listingId)).toEqual(list(mixed, big));
    } finally {
      if (was === undefined) delete process.env.WORK_FEED_REWARD_FILTER_ENABLED;
      else process.env.WORK_FEED_REWARD_FILTER_ENABLED = was;
    }
  });
  it('converts a typed display amount with the decimals the live listings were published with, per asset', async () => {
    const { tokenBig, mixed } = await seed();
    const assets = await run((tx) => readFeedAssets(tx));
    expect(assets.map((a) => [a.assetKey, a.decimals])).toEqual(
      [
        [nativeKey, native.policy.verifiedDecimals],
        [tokenKey, 6],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    );
    const unit = (key: string) => {
      const found = assets.find((a) => a.assetKey === key)!;
      return { label: key === tokenKey ? 'token' : 'SOL', decimals: found.decimals };
    };
    // 0.000009 of a 6-decimal token is 9 base units: it keeps the two token Raids and no SOL-only Raid.
    const parsed = parseRewardMinimum('0.000009', unit(tokenKey));
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.baseUnits).toBe('9');
    expect(await ids({ assetKey: tokenKey, minReward: parsed.baseUnits })).toEqual(
      list(mixed, tokenBig),
    );
    // The same typed text means a different quantity in another asset: it is never carried across assets.
    const sol = parseRewardMinimum('0.000009', unit(nativeKey));
    if (!sol.ok) throw new Error(sol.problem);
    expect(sol.baseUnits).not.toBe(parsed.baseUnits);
  });
  it('keeps the asset list closed on the host until the reward filter flag is exactly true', async () => {
    await seed();
    const was = process.env.WORK_FEED_REWARD_FILTER_ENABLED;
    try {
      delete process.env.WORK_FEED_REWARD_FILTER_ENABLED;
      await expect(readFeedAssetsFromHost()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      process.env.WORK_FEED_REWARD_FILTER_ENABLED = 'true';
      expect((await readFeedAssetsFromHost()).map((a) => a.assetKey).sort()).toEqual(
        [nativeKey, tokenKey].sort(),
      );
    } finally {
      if (was === undefined) delete process.env.WORK_FEED_REWARD_FILTER_ENABLED;
      else process.env.WORK_FEED_REWARD_FILTER_ENABLED = was;
    }
  });
});
