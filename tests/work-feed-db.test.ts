import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { readWorkDetail, readWorkFeed } from '../src/work-loop/feed-storage';
import { DetailSchema, FeedPageSchema, FeedQuerySchema } from '../src/work-loop/feed-contracts';
import { assetKey } from '../src/contracts/assets';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
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
    category: 'documentation',
    difficulty: 'B',
    admission: 'APPLICATION',
    rewards: [{ ...native, amount: '2000000000' }, tokenLeg('500')],
    deadlines: deadlines(9 * day),
  });
  const token = await seedWorkSlot(db, undefined, {
    title: 'Token payout task',
    category: 'documentation',
    rewards: [tokenLeg('9000')],
    deadlines: deadlines(12 * day),
  });
  return { docs, design, audit, token };
}
integration('R08 public Raid feed', { timeout: 60000 }, () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('lists only live, funded, open, public Raids as safe cards without private fields', async () => {
    const { docs, design, audit, token } = await seed();
    const filled = await seedWorkSlot(db, undefined, { title: 'Already taken' });
    const worker = await seedWorkHuman(db);
    await run((tx) =>
      commitEngagement(
        tx,
        {
          actor: worker.actor,
          input: { slotId: filled.slotId, termsVersionId: filled.termsVersionId },
          idempotencyKey: randomUUID(),
          requestId: 'take',
        },
        syntheticAcceptanceHost,
      ),
    );
    await seedWorkSlot(db, undefined, { title: 'About to lapse', deadlines: deadlines(1200) });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const page = FeedPageSchema.parse(await feed());
    expect(page.items.map((i) => i.listingId).sort()).toEqual(
      [docs, design, audit, token].map((s) => s.listingId).sort(),
    );
    expect(page.items.every((i) => i.availableSlots === 1 && i.funding.mode === 'SIMULATED')).toBe(
      true,
    );
    const text = JSON.stringify(page);
    for (const secret of [
      'reviewer',
      'fundingRef',
      'synthetic:',
      'deliverables',
      'creatorAccountId',
    ])
      expect(text, secret).not.toContain(secret);
    // Defense in depth: a non-public version is never listed even if one were stored.
    const hidden = await run(async (tx) => {
      await tx.query('ALTER TABLE "TermsVersion" DISABLE TRIGGER "TermsVersion_immutable"', []);
      await tx.query(
        `UPDATE "TermsVersion" SET "snapshot"=jsonb_set("snapshot",'{visibility}','"CONFIDENTIAL_LISTING"') WHERE "id"=$1::uuid`,
        [docs.termsVersionId],
      );
      const seen = await readWorkFeed(tx, {});
      throw Object.assign(Error('rollback'), { seen });
    }).catch((e) => e as { seen: { items: { listingId: string }[] } });
    expect(hidden.seen.items.map((i) => i.listingId)).not.toContain(docs.listingId);
  });
  it('filters by structured category, skill, rank, admission, participant, deadline and asset', async () => {
    const { docs, design, audit, token } = await seed();
    const ids = async (query: unknown) => (await feed(query)).items.map((i) => i.listingId).sort();
    const sorted = (...s: { listingId: string }[]) => s.map((x) => x.listingId).sort();
    expect(await ids({ category: 'design' })).toEqual(sorted(design));
    expect(await ids({ skillId: 'figma' })).toEqual(sorted(design));
    expect(await ids({ difficulty: 'B' })).toEqual(sorted(audit));
    expect(await ids({ admission: 'APPLICATION' })).toEqual(sorted(audit));
    expect(await ids({ participantKind: 'HUMAN', execution: 'SOLO' })).toHaveLength(4);
    expect(await ids({ participantKind: 'AI_AGENT' })).toEqual([]);
    expect(await ids({ closesBefore: ahead(4 * day) })).toEqual(sorted(design));
    expect(await ids({ assetKey: tokenKey })).toEqual(sorted(audit, token));
    expect(await ids({ assetKey: nativeKey })).toEqual(sorted(docs, design, audit));
    expect(await ids({ category: 'documentation', difficulty: 'E' })).toEqual(sorted(docs, token));
  });
  it('orders by newest, soonest deadline, or reward only within one selected asset', async () => {
    const { docs, design, audit, token } = await seed();
    const order = async (query: unknown) => (await feed(query)).items.map((i) => i.listingId);
    expect(await order({ sort: 'newest' })).toEqual(
      [token, audit, design, docs].map((s) => s.listingId),
    );
    expect(await order({ sort: 'deadline' })).toEqual(
      [design, docs, audit, token].map((s) => s.listingId),
    );
    expect(await order({ sort: 'reward', assetKey: nativeKey })).toEqual(
      [docs, audit, design].map((s) => s.listingId),
    );
    const byToken = await feed({ sort: 'reward', assetKey: tokenKey });
    expect(byToken.rewardComparable).toBe(true);
    expect(byToken.items.map((i) => i.listingId)).toEqual([token, audit].map((s) => s.listingId));
    // Different assets are never ranked against each other.
    expect(FeedQuerySchema.safeParse({ sort: 'reward' }).success).toBe(false);
    await expect(feed({ sort: 'reward' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await feed({ sort: 'newest' })).rewardComparable).toBe(false);
  });
  it('pages with an opaque cursor that is bound to its ordering and rejects tampering', async () => {
    const { docs, design, audit, token } = await seed();
    const everyone = [token, audit, design, docs].map((s) => s.listingId);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await feed({ limit: 1, cursor });
      seen.push(...page.items.map((i) => i.listingId));
      expect(page.items.length).toBeLessThanOrEqual(1);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(everyone);
    const first = await feed({ limit: 1, sort: 'deadline' });
    await expect(
      feed({ limit: 1, sort: 'newest', cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(feed({ cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(feed({ limit: 500 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(feed({ unknown: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
integration('R08 public Raid detail', { timeout: 60000 }, () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  const detail = (listingId: unknown) => run((tx) => readWorkDetail(tx, listingId));
  it('shows the full public brief of one live Raid without internal references', async () => {
    const slot = await seedWorkSlot(db, undefined, { title: 'Docs guide' });
    const brief = DetailSchema.parse(await detail(slot.listingId));
    expect(brief.title).toBe('Docs guide');
    expect(brief.listingId).toBe(slot.listingId);
    expect(brief.openSlotIds).toEqual([slot.slotId]);
    expect(brief.outcome).toBe(raidTerms().outcome);
    expect(brief.deliverables).toEqual(raidTerms().deliverables);
    expect(brief.acceptanceCriteria).toEqual(raidTerms().acceptanceCriteria);
    expect(brief.deadlines.operationalClosure).toBe(raidTerms().deadlines.operationalClosure);
    expect(brief.review).toEqual({
      evidence: raidTerms().review.evidence,
      maxRevisionRounds: raidTerms().review.maxRevisionRounds,
    });
    expect(brief.rewards[0].amount).toBe(raidTerms().rewards[0].amount);
    const text = JSON.stringify(brief);
    for (const secret of [
      'reviewerAccountId',
      'fundingSourceRef',
      'fundingRef',
      'synthetic:',
      'creatorAccountId',
    ])
      expect(text, secret).not.toContain(secret);
    expect(text).not.toContain(raidTerms().review.reviewerAccountId);
    expect(text).not.toContain(raidTerms().fundingSourceRef);
  });
  it('answers missing, unlisted, filled and malformed ids the same way', async () => {
    const open = await seedWorkSlot(db);
    const taken = await seedWorkSlot(db);
    const worker = await seedWorkHuman(db);
    await run((tx) =>
      commitEngagement(
        tx,
        {
          actor: worker.actor,
          input: { slotId: taken.slotId, termsVersionId: taken.termsVersionId },
          idempotencyKey: randomUUID(),
          requestId: 'take',
        },
        syntheticAcceptanceHost,
      ),
    );
    await expect(detail(taken.listingId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(detail(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(detail('not-a-uuid')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(detail(undefined)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(detail(open.listingId)).resolves.toMatchObject({ listingId: open.listingId });
  });
});
