import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { readFeedFacets, readWorkFeed } from '../src/work-loop/feed-storage';
import { FeedQuerySchema } from '../src/work-loop/feed-contracts';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkSlot } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const day = 86400000;
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const deadlines = (commitmentMs: number) => ({
  commitment: ahead(commitmentMs),
  preparation: ahead(commitmentMs + day),
  submission: ahead(commitmentMs + 2 * day),
  review: ahead(commitmentMs + 3 * day),
  operationalClosure: ahead(commitmentMs + 4 * day),
});
const native = raidTerms().rewards[0];
const feed = (query: unknown = {}) => run((tx) => readWorkFeed(tx, query));
const ids = async (query: unknown) => (await feed(query)).items.map((i) => i.listingId).sort();
const sorted = (...s: { listingId: string }[]) => s.map((x) => x.listingId).sort();
async function seed() {
  const docs = await seedWorkSlot(db, undefined, {
    title: 'Docs guide',
    category: 'documentation',
    rewards: [{ ...native, amount: '3000000000' }],
    deadlines: deadlines(6 * day),
  });
  const design = await seedWorkSlot(db, undefined, {
    title: 'Landing design',
    category: 'design',
    difficulty: 'D',
    requiredSkills: [{ skillId: 'figma', minimumRank: 'D', assessmentPolicyVersion: 'starter-v1' }],
    rewards: [{ ...native, amount: '1000000000' }],
    deadlines: deadlines(3 * day),
  });
  const audit = await seedWorkSlot(db, undefined, {
    title: 'Contract audit',
    category: 'security',
    difficulty: 'B',
    admission: 'APPLICATION',
    rewards: [{ ...native, amount: '2000000000' }],
    deadlines: deadlines(9 * day),
  });
  return { docs, design, audit };
}
/** Stores a non-public visibility on one version inside a rolled-back transaction, then reads with `work`. */
async function withNonPublic<T>(
  termsVersionId: string,
  visibility: string,
  work: (tx: Parameters<Parameters<typeof run>[0]>[0]) => Promise<T>,
) {
  const out = await run(async (tx) => {
    await tx.query('ALTER TABLE "TermsVersion" DISABLE TRIGGER "TermsVersion_immutable"', []);
    await tx.query(
      `UPDATE "TermsVersion" SET "snapshot"=jsonb_set("snapshot",'{visibility}',to_jsonb($2::text)) WHERE "id"=$1::uuid`,
      [termsVersionId, visibility],
    );
    const value = await work(tx);
    throw Object.assign(Error('rollback'), { value });
  }).catch((e) => e as { value: T });
  return out.value;
}
integration('T097 structured feed filters', { timeout: 60000 }, () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('bounds the apply-by deadline to a window: closesAfter is inclusive, closesBefore exclusive', async () => {
    const { docs, design, audit } = await seed();
    expect(await ids({ closesAfter: ahead(2 * day) })).toEqual(sorted(docs, design, audit));
    expect(await ids({ closesAfter: ahead(4 * day) })).toEqual(sorted(docs, audit));
    expect(await ids({ closesAfter: ahead(4 * day), closesBefore: ahead(7 * day) })).toEqual(
      sorted(docs),
    );
    expect(await ids({ closesAfter: ahead(10 * day) })).toEqual([]);
  });
  it('refuses an empty or inverted deadline window instead of silently listing nothing', () => {
    const after = ahead(5 * day);
    expect(FeedQuerySchema.safeParse({ closesAfter: after, closesBefore: after }).success).toBe(
      false,
    );
    expect(
      FeedQuerySchema.safeParse({ closesAfter: ahead(6 * day), closesBefore: after }).success,
    ).toBe(false);
    expect(
      FeedQuerySchema.safeParse({ closesAfter: after, closesBefore: ahead(6 * day) }).success,
    ).toBe(true);
  });
  it('has no visibility parameter: the feed only ever discovers PUBLIC work', async () => {
    await seed();
    for (const visibility of ['PUBLIC', 'TRUSTED_LISTING', 'CONFIDENTIAL_LISTING', 'INVITE_ONLY'])
      await expect(feed({ visibility })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('never lets any filter reveal a Raid whose stored visibility is not PUBLIC', async () => {
    const { docs, design, audit } = await seed();
    for (const visibility of ['TRUSTED_LISTING', 'CONFIDENTIAL_LISTING', 'INVITE_ONLY']) {
      const seen = await withNonPublic(design.termsVersionId, visibility, async (tx) => {
        const read = async (q: unknown) =>
          (await readWorkFeed(tx, q)).items.map((i) => i.listingId).sort();
        return {
          all: await read({}),
          // Each filter that would match the hidden Raid exactly must still not list it.
          byCategory: await read({ category: 'design' }),
          bySkill: await read({ skillId: 'figma' }),
          byRank: await read({ difficulty: 'D' }),
          byWindow: await read({ closesAfter: ahead(2 * day), closesBefore: ahead(4 * day) }),
          byAll: await read({ category: 'design', skillId: 'figma', difficulty: 'D' }),
          facets: await readFeedFacets(tx),
        };
      });
      expect(seen.all, visibility).toEqual(sorted(docs, audit));
      for (const key of ['byCategory', 'bySkill', 'byRank', 'byWindow', 'byAll'] as const)
        expect(seen[key], `${visibility} ${key}`).toEqual([]);
      // A hidden Raid's category and skill are not suggested either.
      expect(seen.facets.categories, visibility).not.toContain('design');
      expect(seen.facets.skills, visibility).not.toContain('figma');
    }
  });
  it('suggests only the categories and skills of live, public, funded Raids, sorted and bounded', async () => {
    await seed();
    await seedWorkSlot(db, undefined, {
      title: 'About to lapse',
      category: 'lapsed',
      deadlines: deadlines(1200),
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const facets = await run((tx) => readFeedFacets(tx));
    expect(facets.categories).toEqual(
      expect.arrayContaining(['design', 'documentation', 'security']),
    );
    expect(facets.categories).toEqual([...facets.categories].sort());
    expect(facets.categories).not.toContain('lapsed');
    expect(facets.skills).toContain('figma');
    expect(facets.categories.length).toBeLessThanOrEqual(100);
    expect(facets.skills.length).toBeLessThanOrEqual(100);
  });
});
