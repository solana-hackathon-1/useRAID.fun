import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { readProductMetrics } from '../src/metrics/storage';
import { ProductMetricsSchema } from '../src/metrics/contracts';
import { seedWorkHuman } from './helpers/work-loop-db';
import { assetKey } from '../src/contracts/assets';
import { raidTerms } from './helpers/raid-terms-fixture';
import { draftGuildListing, engage, publishGuildSlot } from './helpers/metrics-fixture';
import { syntheticGuild } from './helpers/guild-public-page-fixture';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const metrics = () => runCommandTransaction(db, (tx) => readProductMetrics(tx));
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
/** Runs raw statements with row triggers off (replica role), for history the commands cannot produce on demand. */
const asHistory = (...sql: string[]) =>
  db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    for (const statement of sql) await tx.$executeRawUnsafe(statement);
  });
const forAsset = <T extends { assetKey: string }>(
  rows: T[],
  asset: Parameters<typeof assetKey>[0],
) => rows.find((row) => row.assetKey === assetKey(asset));
/** Every field name in the report: prose may say "not dollars", but no field may carry a price, dollar value or total. */
const fieldNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(fieldNames)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, child]) => [key, ...fieldNames(child)])
      : [];
const MONEY_FIELD = /usd|dollar|price|total|volume|worth|sum/i;
const guild = async (slug: string) =>
  (await syntheticGuild(slug, 'Guild ' + slug, 'Synthetic ' + slug)).guild.id as string;

integration('T043 product activation and repeat metrics', { timeout: 120000 }, () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());

  it('reports an empty platform with zero counts, null rates and null timings, never zero-as-a-sample', async () => {
    const page = ProductMetricsSchema.parse(await metrics());
    expect(page.fundingMode).toBe('SIMULATED');
    for (const metric of [
      page.guildActivation,
      page.guildFirstOutcome,
      page.guildRepeat,
      page.raiderActivation,
      page.raiderFirstOutcome,
      page.raiderRepeat,
    ])
      expect(metric).toMatchObject({ numerator: 0, denominator: 0, rate: null });
    for (const timing of Object.values(page.timings))
      expect(timing).toEqual({ samples: 0, medianSeconds: null, p90Seconds: null });
    expect(page.excluded).toEqual({
      listingsWithoutVerifiedGuild: 0,
      engagementsWithoutVerifiedGuild: 0,
      submissionsWithoutVerifiedGuild: 0,
    });
    expect(page.launchConversion.drafted.count).toBe(0);
    for (const step of [
      page.launchConversion.fundedFromDrafted,
      page.launchConversion.acceptedFromFunded,
      page.launchConversion.workAcceptedFromAccepted,
      page.launchConversion.workAcceptedFromDrafted,
      page.reviewDelay.decided,
    ])
      expect(step).toMatchObject({ numerator: 0, denominator: 0, rate: null });
    expect(page.reviewDelay.timing).toEqual({ samples: 0, medianSeconds: null, p90Seconds: null });
    expect(page.reviewDelay.distribution.every((bucket) => bucket.count === 0)).toBe(true);
    expect(page.settlement.byAsset).toEqual([]);
    expect(page.disputes).toMatchObject({ raised: 0, open: 0, byAsset: [] });
  });

  it('counts verified Guild and participant activation, first outcome and repeat with explicit denominators', async () => {
    const [a, b, c] = [
      await guild('metrics-a'),
      await guild('metrics-b'),
      await guild('metrics-c'),
    ];
    const w1 = await seedWorkHuman(db, 'w1');
    const w2 = await seedWorkHuman(db, 'w2');
    const w3 = await seedWorkHuman(db, 'w3');
    // Guild A: two funded offerings, both accepted by w1 (a repeat Guild and a repeat contributor).
    await engage(db, await publishGuildSlot(db, a), w1, 'ACCEPTED');
    await engage(db, await publishGuildSlot(db, a), w1, 'ACCEPTED');
    // Guild C: a funded offering whose engagement (w2) is still in progress; Guild B never publishes.
    await engage(db, await publishGuildSlot(db, c), w2, 'IN_PROGRESS');
    // w3 only applied, to an open slot of Guild A; and Guild-less work is excluded from every figure.
    const open = await publishGuildSlot(db, a, 'APPLICATION');
    await db.raidApplication.create({
      data: {
        slotId: open.slotId,
        termsVersionId: open.termsVersionId,
        participantId: w3.participantId,
        evidenceRefs: [],
      },
    });
    await engage(
      db,
      await publishGuildSlot(db, 'synthetic-unverified-guild'),
      await seedWorkHuman(db, 'w4'),
      'ACCEPTED',
    );
    expect(b).toBeTruthy();

    const page = ProductMetricsSchema.parse(await metrics());
    expect(page.guildActivation).toMatchObject({ numerator: 2, denominator: 3, rate: 2 / 3 });
    expect(page.guildFirstOutcome).toMatchObject({ numerator: 1, denominator: 3 });
    expect(page.guildRepeat).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    // Denominator: participants who applied to or hold an engagement on a verified-Guild slot (w1, w2, w3).
    expect(page.raiderActivation).toMatchObject({ numerator: 2, denominator: 3 });
    expect(page.raiderFirstOutcome).toMatchObject({ numerator: 1, denominator: 2 });
    expect(page.raiderRepeat).toMatchObject({ numerator: 1, denominator: 1 });
    expect(page.excluded).toEqual({
      listingsWithoutVerifiedGuild: 1,
      engagementsWithoutVerifiedGuild: 1,
      submissionsWithoutVerifiedGuild: 1,
    });
    expect(page.timings.guildToFirstFundedOffering.samples).toBe(2);
    expect(page.timings.guildToFirstOutcome.samples).toBe(1);
    expect(page.timings.raiderToFirstOutcome.samples).toBe(1);
    expect(page.timings.guildToFirstOutcome.medianSeconds).toBeGreaterThanOrEqual(0);
  });

  it('states denominator and exclusions for every metric and publishes no money, price or account', async () => {
    const a = await guild('metrics-honest');
    const worker = await seedWorkHuman(db, 'honest-worker');
    await engage(db, await publishGuildSlot(db, a), worker, 'ACCEPTED');
    const page = ProductMetricsSchema.parse(await metrics());
    for (const metric of [
      page.guildActivation,
      page.guildFirstOutcome,
      page.guildRepeat,
      page.raiderActivation,
      page.raiderFirstOutcome,
      page.raiderRepeat,
      page.launchConversion.fundedFromDrafted,
      page.launchConversion.acceptedFromFunded,
      page.launchConversion.workAcceptedFromAccepted,
      page.launchConversion.workAcceptedFromDrafted,
      page.reviewDelay.decided,
    ]) {
      expect(metric.denominatorDefinition.length).toBeGreaterThan(10);
      expect(metric.exclusions.length).toBeGreaterThan(0);
    }
    const text = JSON.stringify(page);
    // Amounts exist only per asset (see the by-asset tests); there is never a price, dollar value or cross-asset total.
    expect(fieldNames(page).filter((name) => MONEY_FIELD.test(name))).toEqual([]);
    expect(text).not.toContain('honest-worker');
    expect(page.notMeasured).toEqual(
      expect.arrayContaining([
        'dollarValue',
        'fixtureExclusion',
        'knownAbuseExclusion',
        'paidVolume',
        'timeToSettlement',
      ]),
    );
  });

  it('separates drafted, funded, accepted, work-accepted and paid, each step over the one before', async () => {
    const a = await guild('funnel-a');
    const [w1, w2, w3] = [
      await seedWorkHuman(db, 'f1'),
      await seedWorkHuman(db, 'f2'),
      await seedWorkHuman(db, 'f3'),
    ];
    await draftGuildListing(db, a); // drafted only
    await publishGuildSlot(db, a); // funded, nobody engaged
    await engage(db, await publishGuildSlot(db, a), w1, 'IN_PROGRESS'); // accepted
    await engage(db, await publishGuildSlot(db, a), w2, 'SUBMITTED'); // accepted, awaiting review
    await engage(db, await publishGuildSlot(db, a), w3, 'ACCEPTED'); // work accepted
    // Work under an unpersisted Guild id is left out of every step.
    await draftGuildListing(db, 'synthetic-unverified-funnel');
    await engage(
      db,
      await publishGuildSlot(db, 'synthetic-unverified-funnel'),
      await seedWorkHuman(db, 'f4'),
      'ACCEPTED',
    );

    const { launchConversion: funnel } = ProductMetricsSchema.parse(await metrics());
    expect(funnel.unit).toBe('WORK_LISTING');
    expect(funnel.drafted.count).toBe(5);
    expect(funnel.fundedFromDrafted).toMatchObject({ numerator: 4, denominator: 5, rate: 0.8 });
    expect(funnel.acceptedFromFunded).toMatchObject({ numerator: 3, denominator: 4, rate: 0.75 });
    expect(funnel.workAcceptedFromAccepted).toMatchObject({ numerator: 1, denominator: 3 });
    expect(funnel.workAcceptedFromDrafted).toMatchObject({ numerator: 1, denominator: 5 });
    // Settlement is not built, so no listing can be reported as paid and absence is never zero.
    expect(funnel.paid).toBeNull();
    for (const step of [
      funnel.fundedFromDrafted,
      funnel.acceptedFromFunded,
      funnel.workAcceptedFromAccepted,
    ])
      expect(step.exclusions.join(' ')).toMatch(/persisted/i);
  });

  it('reports settlement and dispute counts and amounts per asset, never summed or valued', async () => {
    const a = await guild('assets-a');
    const slot = (rewards: ReturnType<typeof nativeLeg | typeof tokenLeg>[]) =>
      publishGuildSlot(db, a, 'INSTANT', rewards as never);
    const worker = (name: string) => seedWorkHuman(db, name);
    // Accepted work: native 3e9; token 7000; and one engagement paying native 1e9 plus token 500.
    await engage(db, await slot([nativeLeg('3000000000')]), await worker('a1'), 'ACCEPTED');
    await engage(db, await slot([tokenLeg('7000')]), await worker('a2'), 'ACCEPTED');
    await engage(
      db,
      await slot([nativeLeg('1000000000'), tokenLeg('500')]),
      await worker('a3'),
      'ACCEPTED',
    );
    // Open disputes: native 2e9 and token 40. Submitted work that is not disputed is not a dispute.
    await engage(db, await slot([nativeLeg('2000000000')]), await worker('a4'), 'DISPUTED');
    await engage(db, await slot([tokenLeg('40')]), await worker('a5'), 'DISPUTED');
    await engage(db, await slot([nativeLeg('9')]), await worker('a6'), 'SUBMITTED');
    // Unverified-Guild work, accepted and disputed, is excluded from every amount.
    const stray = 'synthetic-unverified-assets';
    const strayRewards = (amount: string) => [nativeLeg(amount)] as never;
    await engage(
      db,
      await publishGuildSlot(db, stray, 'INSTANT', strayRewards('777')),
      await worker('s1'),
      'ACCEPTED',
    );
    await engage(
      db,
      await publishGuildSlot(db, stray, 'INSTANT', strayRewards('555')),
      await worker('s2'),
      'DISPUTED',
    );

    const page = ProductMetricsSchema.parse(await metrics());
    expect(page.settlement.byAsset).toHaveLength(2);
    expect(forAsset(page.settlement.byAsset, nativeAsset)).toMatchObject({
      decimals: 9,
      dueEngagements: 2,
      dueAmount: '4000000000',
      resolvedEngagements: 0,
      resolvedAmount: '0',
    });
    expect(forAsset(page.settlement.byAsset, tokenAsset)).toMatchObject({
      decimals: 6,
      dueEngagements: 2,
      dueAmount: '7500',
      resolvedEngagements: 0,
      resolvedAmount: '0',
    });
    expect(page.disputes).toMatchObject({ raised: 2, open: 2 });
    expect(forAsset(page.disputes.byAsset, nativeAsset)).toMatchObject({
      raisedEngagements: 1,
      raisedAmount: '2000000000',
      openEngagements: 1,
      openAmount: '2000000000',
    });
    expect(forAsset(page.disputes.byAsset, tokenAsset)).toMatchObject({
      raisedEngagements: 1,
      raisedAmount: '40',
      openEngagements: 1,
      openAmount: '40',
    });
    // No price, valuation or cross-asset total exists, and the report says the amounts are unvalued.
    expect(page.settlement.valuation).toBe('NOT_VALUED');
    expect(page.disputes.valuation).toBe('NOT_VALUED');
    expect(fieldNames(page).filter((name) => MONEY_FIELD.test(name))).toEqual([]);
  });

  it('counts only a resolved closure as settled, and a closed dispute as raised but no longer open', async () => {
    const a = await guild('resolved-a');
    const slot = (amount: string) =>
      publishGuildSlot(db, a, 'INSTANT', [nativeLeg(amount)] as never);
    const done = await engage(db, await slot('600'), await seedWorkHuman(db, 'r1'), 'ACCEPTED');
    await engage(db, await slot('400'), await seedWorkHuman(db, 'r2'), 'ACCEPTED');
    const disputed = await engage(db, await slot('50'), await seedWorkHuman(db, 'r3'), 'DISPUTED');
    // The review-timeout closure that follows an unresolved dispute (history written without the live timers).
    await asHistory(
      `INSERT INTO "EngagementClosure" ("engagementId","reason","finalState","closedByAccountId")
        SELECT '${disputed}'::uuid,'REVIEW_TIMEOUT','TERMINATED',"reviewerAccountId" FROM "WorkReview" WHERE "engagementId"='${disputed}'::uuid`,
      `UPDATE "Engagement" SET "state"='TERMINATED' WHERE "id"='${disputed}'::uuid`,
    );
    let page = ProductMetricsSchema.parse(await metrics());
    expect(forAsset(page.settlement.byAsset, nativeAsset)).toMatchObject({
      dueEngagements: 2,
      dueAmount: '1000',
      resolvedEngagements: 0,
      resolvedAmount: '0',
    });
    expect(page.disputes).toMatchObject({ raised: 1, open: 0 });
    expect(forAsset(page.disputes.byAsset, nativeAsset)).toMatchObject({
      raisedAmount: '50',
      openEngagements: 0,
      openAmount: '0',
    });
    // The column only ever holds OPEN today; a future settlement slice writes another value and is counted then.
    const constraint = `"EngagementClosure_financialResolution_check"`;
    await db.$executeRawUnsafe(`ALTER TABLE "EngagementClosure" DROP CONSTRAINT ${constraint}`);
    try {
      await asHistory(
        `UPDATE "EngagementClosure" SET "financialResolution"='SETTLED' WHERE "engagementId"='${done}'::uuid`,
      );
      page = ProductMetricsSchema.parse(await metrics());
      expect(forAsset(page.settlement.byAsset, nativeAsset)).toMatchObject({
        dueEngagements: 2,
        dueAmount: '1000',
        resolvedEngagements: 1,
        resolvedAmount: '600',
      });
    } finally {
      await asHistory(`UPDATE "EngagementClosure" SET "financialResolution"='OPEN'`);
      await db.$executeRawUnsafe(
        `ALTER TABLE "EngagementClosure" ADD CONSTRAINT ${constraint} CHECK ("financialResolution"='OPEN')`,
      );
    }
  });

  it('measures review delay from submission to decision as a distribution over decided submissions', async () => {
    const a = await guild('delay-a');
    const decided = async (name: string, outcome: 'ACCEPTED' | 'DISPUTED', guildId = a) =>
      engage(db, await publishGuildSlot(db, guildId), await seedWorkHuman(db, name), outcome);
    const quick = await decided('d1', 'ACCEPTED');
    const slow = await decided('d2', 'DISPUTED');
    await engage(db, await publishGuildSlot(db, a), await seedWorkHuman(db, 'd3'), 'SUBMITTED'); // undecided
    const stray = await decided('d4', 'ACCEPTED', 'synthetic-unverified-delay');
    // Submissions are immutable, so they are moved back in time instead: a 30 minute and a 2 day wait.
    const age = (engagement: string, interval: string) =>
      `UPDATE "WorkSubmission" SET "createdAt"="createdAt" - interval '${interval}' WHERE "engagementId"='${engagement}'::uuid`;
    await asHistory(age(quick, '30 minutes'), age(slow, '48 hours'), age(stray, '1 hour'));

    const page = ProductMetricsSchema.parse(await metrics());
    // Denominator: submissions of verified-Guild engagements (3); numerator: those with a substantive decision (2).
    expect(page.reviewDelay.decided).toMatchObject({ numerator: 2, denominator: 3 });
    expect(page.reviewDelay.timing.samples).toBe(2);
    expect(page.reviewDelay.timing.medianSeconds).toBeCloseTo((1800 + 172800) / 2, -1);
    expect(page.reviewDelay.timing.p90Seconds).toBeGreaterThan(
      page.reviewDelay.timing.medianSeconds!,
    );
    const counts = Object.fromEntries(
      page.reviewDelay.distribution.map((b) => [b.bucket, b.count]),
    );
    expect(counts).toEqual({ LE_1H: 1, LE_4H: 0, LE_1D: 0, LE_3D: 1, GT_3D: 0 });
    expect(page.excluded.submissionsWithoutVerifiedGuild).toBe(1);
    expect(page.reviewDelay.decided.exclusions.join(' ')).toMatch(/pause/i);
    expect(page.notMeasured).toContain('reviewDelayExcludingPauses');
  });

  it('names the missing fixture, duplicate and known-abuse markers instead of inventing a policy', async () => {
    const page = ProductMetricsSchema.parse(await metrics());
    expect(page.notMeasured).toEqual(
      expect.arrayContaining([
        'fixtureExclusion',
        'knownAbuseExclusion',
        'duplicateExclusion',
        'challengeOutcomes',
        'disputeCategoryAndFinding',
        'tokenLaunchConversion',
      ]),
    );
    expect(page.notMeasured).not.toContain('launchConversion');
    expect(page.notMeasured).not.toContain('settlementCompletion');
  });
});
