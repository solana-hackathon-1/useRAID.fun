import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { readWorkMetrics } from '../src/work-loop/metrics-storage';
import { WorkMetricsSchema } from '../src/work-loop/metrics-contracts';
import { assetKey } from '../src/contracts/assets';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedEngagement } from './helpers/work-lifecycle';
import { seedWorkSlot } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const native = raidTerms().rewards[0];
const nativeAsset = {
  chain: 'SOLANA',
  networkIdentity: 'synthetic-work',
  kind: 'NATIVE_SOL',
} as const;
const tokenAsset = {
  chain: 'SOLANA' as const,
  networkIdentity: 'synthetic-work',
  kind: 'TOKEN' as const,
  mint: 'So11111111111111111111111111111111111111112',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};
const nativeLeg = (amount: string) => ({ ...native, amount });
const tokenLeg = (amount: string) => ({
  policy: {
    ...native.policy,
    assetId: tokenAsset,
    verifiedDecimals: 6,
    supportedExtensionProfile: 'none',
  },
  amount,
});
const metrics = () => run((tx) => readWorkMetrics(tx));
const volume = (page: { volumes: { assetKey: string }[] }, key: string) =>
  page.volumes.find((v) => v.assetKey === key);
integration('T043 work-loop metrics', { timeout: 60000 }, () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('reports an empty loop as zeros without inventing values', async () => {
    const page = WorkMetricsSchema.parse(await metrics());
    expect(page.engagements).toEqual({});
    expect(page.submissions).toBe(0);
    expect(page.volumes).toEqual([]);
    expect(page.timings.matching).toEqual({ samples: 0, medianSeconds: null, p90Seconds: null });
    expect(page.timings.review.samples).toBe(0);
  });
  it('keeps funded, committed and work-accepted volume apart and never mixes assets', async () => {
    const accepted = await seedEngagement(db, { rewards: [nativeLeg('3000000000')] });
    const sub = await accepted.submit();
    await accepted.decide(sub.submission.id, 'ACCEPT');
    await seedEngagement(db, { rewards: [tokenLeg('7000')] });
    await seedWorkSlot(db, undefined, { rewards: [nativeLeg('1000000000')] });
    await seedWorkSlot(db, undefined, { rewards: [tokenLeg('500')] });
    const page = WorkMetricsSchema.parse(await metrics());
    expect(page.fundingMode).toBe('SIMULATED');
    expect(page.engagements).toEqual({ ACCEPTED: 1, IN_PROGRESS: 1 });
    expect(page.closures).toEqual({ ACCEPTED: 1 });
    expect(page.slots).toEqual({ FILLED: 2, AVAILABLE: 2 });
    expect(page.listings).toEqual({ OPEN: 4 });
    expect(page.submissions).toBe(1);
    expect(page.reviews).toEqual({ ACCEPT: 1 });
    expect(page.volumes).toHaveLength(2);
    expect(volume(page, assetKey(nativeAsset))).toMatchObject({
      decimals: 9,
      openFunded: '1000000000',
      committed: '0',
      workAccepted: '3000000000',
      paid: null,
    });
    expect(volume(page, assetKey(tokenAsset))).toMatchObject({
      decimals: 6,
      openFunded: '500',
      committed: '7000',
      workAccepted: '0',
      paid: null,
    });
    // Nothing is summed across assets and no price or total is invented.
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/usd|dollar|total/i);
    expect(page.notMeasured).toEqual(
      expect.arrayContaining(['paidVolume', 'settlementCompletion', 'disputeBurden']),
    );
  });
  it('measures matching time and review delay from database timestamps, only over real samples', async () => {
    const done = await seedEngagement(db);
    const sub = await done.submit();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await done.decide(sub.submission.id, 'ACCEPT');
    await seedEngagement(db);
    const page = WorkMetricsSchema.parse(await metrics());
    expect(page.timings.matching.samples).toBe(2);
    expect(page.timings.matching.medianSeconds).toBeGreaterThanOrEqual(0);
    expect(page.timings.review.samples).toBe(1);
    expect(page.timings.review.medianSeconds).toBeGreaterThan(0.1);
    expect(page.timings.review.p90Seconds).toBeGreaterThanOrEqual(
      page.timings.review.medianSeconds!,
    );
  });
});
