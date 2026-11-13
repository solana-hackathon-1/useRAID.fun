import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { readProductMetrics } from '../src/metrics/storage';
import { setMetricsExclusion, type SetMetricsExclusionInput } from '../src/metrics/exclusion';
import { ProductMetricsSchema } from '../src/metrics/contracts';
import { seedWorkHuman } from './helpers/work-loop-db';
import { engage, publishGuildSlot } from './helpers/metrics-fixture';
import { syntheticGuild } from './helpers/guild-public-page-fixture';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const metrics = async () =>
  ProductMetricsSchema.parse(await runCommandTransaction(db, (tx) => readProductMetrics(tx)));
type Input = SetMetricsExclusionInput;
const guild = async (slug: string) =>
  (await syntheticGuild(slug, 'Guild ' + slug, 'Synthetic ' + slug)).guild.id as string;
let operator: string;
const mark = (input: Partial<Input> & Pick<Input, 'subjectType' | 'subjectId'>, actor = operator) =>
  runCommandTransaction(db, (tx) =>
    setMetricsExclusion(tx, {
      operatorAccountId: actor,
      input: {
        reason: 'FIXTURE',
        evidenceRef: 'synthetic-evidence-1',
        effect: 'EXCLUDE',
        supersedesMarkerId: null,
        ...input,
      } as Input,
    }),
  );
/** Two verified Guilds, each with one accepted engagement by its own worker. */
async function twoGuilds() {
  const [a, b] = [await guild('excl-a'), await guild('excl-b')];
  const [w1, w2] = [await seedWorkHuman(db, 'w1'), await seedWorkHuman(db, 'w2')];
  const slotA = await publishGuildSlot(db, a);
  const slotB = await publishGuildSlot(db, b);
  const engagementA = await engage(db, slotA, w1, 'ACCEPTED');
  const engagementB = await engage(db, slotB, w2, 'ACCEPTED');
  const [{ listingId }] = await db.$queryRawUnsafe<{ listingId: string }[]>(
    `SELECT "listingId" FROM "RaidSlot" WHERE "id"=$1::uuid`,
    slotA.slotId,
  );
  return { a, b, w1, w2, engagementA, engagementB, listingA: listingId };
}

integration('DEC-2026-11-13-10 MetricsExclusion marker (T043)', { timeout: 120000 }, () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    // The marker table rejects UPDATE, DELETE and TRUNCATE; only the test database's superuser may empty it.
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "MetricsExclusion"`),
    ]);
    operator = (
      await db.user.create({
        data: { handle: 'op-' + randomUUID(), role: 'ADMIN', xId: 'x-' + randomUUID() },
      })
    ).id;
  });
  afterAll(() => db.$disconnect());

  describe('append-only', () => {
    it('rejects UPDATE, DELETE and TRUNCATE of a marker', async () => {
      const { a } = await twoGuilds();
      const marker = await mark({ subjectType: 'GUILD', subjectId: a });
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "MetricsExclusion" SET "reason"='DUPLICATE' WHERE "id"=$1::uuid`,
          marker.id,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.$executeRawUnsafe(`DELETE FROM "MetricsExclusion" WHERE "id"=$1::uuid`, marker.id),
      ).rejects.toThrow(/append-only/);
      await expect(db.$executeRawUnsafe(`TRUNCATE "MetricsExclusion"`)).rejects.toThrow(
        /append-only/,
      );
      expect(await db.$queryRawUnsafe(`SELECT 1 FROM "MetricsExclusion"`)).toHaveLength(1);
    });
  });

  describe('operator-only and audited', () => {
    it('records the operator actor, the reason, the evidence reference and a database time', async () => {
      const { a } = await twoGuilds();
      const marker = await mark({
        subjectType: 'GUILD',
        subjectId: a,
        reason: 'INTERNAL_DEMO',
        evidenceRef: 'ticket-77',
      });
      expect(marker).toMatchObject({
        subjectType: 'GUILD',
        subjectId: a,
        reason: 'INTERNAL_DEMO',
        evidenceRef: 'ticket-77',
        effect: 'EXCLUDE',
        actorAccountId: operator,
        supersedesMarkerId: null,
      });
      expect(Date.parse(marker.recordedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('the database itself rejects a marker whose actor is not an active administrator', async () => {
      const { a } = await twoGuilds();
      const creator = await db.user.create({ data: { handle: 'creator-' + randomUUID() } });
      const suspended = await db.user.create({
        data: {
          handle: 'sus-' + randomUUID(),
          role: 'ADMIN',
          xId: 'x-' + randomUUID(),
          suspended: true,
        },
      });
      for (const actor of [creator.id, suspended.id, 'no-such-user'])
        await expect(mark({ subjectType: 'GUILD', subjectId: a }, actor)).rejects.toThrow();
      // Raw SQL that bypasses the module is refused by the same trigger.
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "MetricsExclusion" ("subjectType","subjectId","reason","evidenceRef","effect","actorAccountId") VALUES ('GUILD',$1,'FIXTURE','e','EXCLUDE',$2)`,
          a,
          creator.id,
        ),
      ).rejects.toThrow(/administrator/i);
      expect(await db.$queryRawUnsafe(`SELECT 1 FROM "MetricsExclusion"`)).toHaveLength(0);
    });

    it('rejects an unknown subject type, reason, malformed subject id and blank evidence', async () => {
      const { a } = await twoGuilds();
      const bad: Partial<Input>[] = [
        { subjectType: 'USER' as never },
        { subjectType: 'SKILL_EVIDENCE_FINGERPRINT' as never },
        { reason: 'SUSPECTED' as never },
        { subjectId: 'has space' },
        { evidenceRef: '' },
        { evidenceRef: 'x'.repeat(201) },
        { effect: 'RELEASE' }, // a release must name the marker it releases
      ];
      for (const patch of bad)
        await expect(mark({ subjectType: 'GUILD', subjectId: a, ...patch })).rejects.toThrow();
      // The same checks hold below the module.
      for (const values of [
        `'USER','${a}','FIXTURE','e','EXCLUDE'`,
        `'GUILD','${a}','SUSPECTED','e','EXCLUDE'`,
        `'GUILD','${a}','FIXTURE','','EXCLUDE'`,
        `'GUILD','${a}','FIXTURE','e','RELEASE'`,
      ])
        await expect(
          db.$executeRawUnsafe(
            `INSERT INTO "MetricsExclusion" ("subjectType","subjectId","reason","evidenceRef","effect","actorAccountId") VALUES (${values},'${operator}')`,
          ),
        ).rejects.toThrow();
      expect(await db.$queryRawUnsafe(`SELECT 1 FROM "MetricsExclusion"`)).toHaveLength(0);
    });

    it('refuses a subject that does not exist', async () => {
      await expect(mark({ subjectType: 'GUILD', subjectId: randomUUID() })).rejects.toMatchObject({
        code: 'SUBJECT_NOT_FOUND',
      });
      await expect(
        mark({ subjectType: 'PARTICIPANT', subjectId: 'no-such-participant' }),
      ).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' });
    });
  });

  describe('chain integrity', () => {
    it('allows one marker chain per subject: a second root, a stale or foreign supersede is refused', async () => {
      const { a, b } = await twoGuilds();
      const first = await mark({ subjectType: 'GUILD', subjectId: a });
      await expect(mark({ subjectType: 'GUILD', subjectId: a })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      const second = await mark({
        subjectType: 'GUILD',
        subjectId: a,
        reason: 'KNOWN_ABUSE',
        supersedesMarkerId: first.id,
      });
      // The first marker is no longer the head of its chain.
      await expect(
        mark({ subjectType: 'GUILD', subjectId: a, supersedesMarkerId: first.id }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // A marker for another subject cannot be superseded by this one.
      await expect(
        mark({ subjectType: 'GUILD', subjectId: b, supersedesMarkerId: second.id }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await db.$queryRawUnsafe(`SELECT 1 FROM "MetricsExclusion"`)).toHaveLength(2);
    });

    it('two operators superseding the same head concurrently: exactly one wins', async () => {
      const { a } = await twoGuilds();
      const head = await mark({ subjectType: 'GUILD', subjectId: a });
      const results = await Promise.allSettled([
        mark({
          subjectType: 'GUILD',
          subjectId: a,
          reason: 'DUPLICATE',
          supersedesMarkerId: head.id,
        }),
        mark({
          subjectType: 'GUILD',
          subjectId: a,
          reason: 'KNOWN_ABUSE',
          supersedesMarkerId: head.id,
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await db.$queryRawUnsafe(`SELECT 1 FROM "MetricsExclusion"`)).toHaveLength(2);
    });
  });

  describe('metrics honor the marker', () => {
    it('a marked Guild is out of every Guild, funnel, settlement and review figure, and only there', async () => {
      const { a } = await twoGuilds();
      const before = await metrics();
      expect(before.guildActivation).toMatchObject({ numerator: 2, denominator: 2 });
      const engagementsBefore = await db.engagement.count();
      await mark({ subjectType: 'GUILD', subjectId: a });
      const after = await metrics();
      expect(after.guildActivation).toMatchObject({ numerator: 1, denominator: 1 });
      expect(after.guildFirstOutcome).toMatchObject({ numerator: 1, denominator: 1 });
      expect(after.raiderActivation).toMatchObject({ numerator: 1, denominator: 1 });
      expect(after.workListingFunnel.drafted.count).toBe(1);
      expect(after.settlement.byAsset.every((row) => row.dueEngagements === 1)).toBe(true);
      expect(after.reviewDelay.decided).toMatchObject({ numerator: 1, denominator: 1 });
      expect(after.timings.guildToFirstOutcome.samples).toBe(1);
      // Marked work is excluded by an operator, not "without a verified Guild": that count does not move.
      expect(after.excluded).toEqual(before.excluded);
      // A marker changes metrics only: the work record is untouched.
      expect(await db.engagement.count()).toBe(engagementsBefore);
    });

    it('a marked listing leaves the funnel, funding and its engagements, but not the Guild count', async () => {
      const { listingA } = await twoGuilds();
      await mark({ subjectType: 'WORK_LISTING', subjectId: listingA, reason: 'SELF_DEALING' });
      const page = await metrics();
      expect(page.guildActivation).toMatchObject({ numerator: 1, denominator: 2 });
      expect(page.workListingFunnel.drafted.count).toBe(1);
      expect(page.workListingFunnel.fundedFromDrafted).toMatchObject({
        numerator: 1,
        denominator: 1,
      });
      expect(page.guildFirstOutcome).toMatchObject({ numerator: 1, denominator: 2 });
      expect(page.settlement.byAsset.every((row) => row.dueEngagements === 1)).toBe(true);
      expect(page.excluded.listingsWithoutVerifiedGuild).toBe(0);
    });

    it('a marked engagement is not an outcome, a settlement, a review or a raider activation', async () => {
      const { engagementA } = await twoGuilds();
      await mark({ subjectType: 'ENGAGEMENT', subjectId: engagementA, reason: 'DUPLICATE' });
      const page = await metrics();
      expect(page.guildFirstOutcome).toMatchObject({ numerator: 1, denominator: 2 });
      expect(page.raiderActivation).toMatchObject({ numerator: 1, denominator: 1 });
      expect(page.reviewDelay.decided).toMatchObject({ numerator: 1, denominator: 1 });
      expect(page.settlement.byAsset.every((row) => row.dueEngagements === 1)).toBe(true);
      expect(page.excluded.engagementsWithoutVerifiedGuild).toBe(0);
      expect(page.excluded.submissionsWithoutVerifiedGuild).toBe(0);
    });

    it('a marked participant leaves participant measures only, never a Guild figure', async () => {
      const { w1 } = await twoGuilds();
      await mark({
        subjectType: 'PARTICIPANT',
        subjectId: w1.participantId,
        reason: 'KNOWN_ABUSE',
      });
      const page = await metrics();
      expect(page.raiderActivation).toMatchObject({ numerator: 1, denominator: 1 });
      expect(page.raiderFirstOutcome).toMatchObject({ numerator: 1, denominator: 1 });
      expect(page.timings.raiderToFirstOutcome.samples).toBe(1);
      expect(page.guildFirstOutcome).toMatchObject({ numerator: 2, denominator: 2 });
    });

    it('a release restores the figures; a later marker excludes again; a reason change keeps it excluded', async () => {
      const { a } = await twoGuilds();
      const first = await mark({ subjectType: 'GUILD', subjectId: a });
      expect((await metrics()).guildActivation.denominator).toBe(1);
      const changed = await mark({
        subjectType: 'GUILD',
        subjectId: a,
        reason: 'KNOWN_ABUSE',
        supersedesMarkerId: first.id,
      });
      expect((await metrics()).guildActivation.denominator).toBe(1);
      const released = await mark({
        subjectType: 'GUILD',
        subjectId: a,
        effect: 'RELEASE',
        evidenceRef: 'review-closed-no-finding',
        supersedesMarkerId: changed.id,
      });
      expect((await metrics()).guildActivation).toMatchObject({ numerator: 2, denominator: 2 });
      await mark({ subjectType: 'GUILD', subjectId: a, supersedesMarkerId: released.id });
      expect((await metrics()).guildActivation.denominator).toBe(1);
    });

    it('suspension and skill-evidence fingerprints never exclude anything on their own', async () => {
      const { w1 } = await twoGuilds();
      await db.user.update({ where: { id: w1.actor.accountId }, data: { suspended: true } });
      const page = await metrics();
      expect(page.raiderActivation).toMatchObject({ numerator: 2, denominator: 2 });
      expect(page.guildActivation).toMatchObject({ numerator: 2, denominator: 2 });
    });

    it('stops listing the now-implemented markers as not measured, and says what excludes', async () => {
      const page = await metrics();
      for (const name of ['fixtureExclusion', 'knownAbuseExclusion', 'duplicateExclusion'])
        expect(page.notMeasured).not.toContain(name);
      expect(page.guildActivation.exclusions.join(' ')).toMatch(/MetricsExclusion/);
      expect(page.guildActivation.exclusions.join(' ')).not.toMatch(/not marked in the data/);
    });
  });
});
