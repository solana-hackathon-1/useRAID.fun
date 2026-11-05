import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { readProductMetrics } from '../src/metrics/storage';
import { ProductMetricsSchema } from '../src/metrics/contracts';
import { seedWorkHuman } from './helpers/work-loop-db';
import { engage, publishGuildSlot } from './helpers/metrics-fixture';
import { syntheticGuild } from './helpers/guild-public-page-fixture';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const metrics = () => runCommandTransaction(db, (tx) => readProductMetrics(tx));
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
    });
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
    ]) {
      expect(metric.denominatorDefinition.length).toBeGreaterThan(10);
      expect(metric.exclusions.length).toBeGreaterThan(0);
    }
    const text = JSON.stringify({ ...page, notMeasured: undefined });
    expect(text).not.toMatch(/usd|dollar|price|total|amount|volume/i);
    expect(text).not.toContain('honest-worker');
    expect(page.notMeasured).toEqual(
      expect.arrayContaining([
        'dollarValue',
        'fixtureExclusion',
        'knownAbuseExclusion',
        'paidVolume',
      ]),
    );
  });
});
