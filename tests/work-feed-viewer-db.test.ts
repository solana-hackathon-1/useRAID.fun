import { afterAll, describe, expect, it } from 'vitest';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import { activateGuild, type GuildActor } from '../src/guild-profiles/guild-storage';
import { hash } from '../src/lib/auth-primitives';
import { readWorkFeed } from '../src/work-loop/feed-storage';
import { attachPublicGuilds } from '../src/lib/work-feed-guilds';
import { createViewerEvaluator } from '../src/lib/work-feed-viewer';
import { FeedPageSchema } from '../src/work-loop/feed-contracts';
import { seedWorkSlot } from './helpers/work-loop-db';
import { seedOwnAssessmentFixture, db } from './helpers/own-assessment-fixture';
import { assertTestDatabase } from './helpers/db-guard';

/** T097: public Guild name/link and server-side "Eligible for me" against real PostgreSQL. */
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const TAXONOMY = 'synthetic-submission-catalog';
let counter = 0;
async function person(): Promise<GuildActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-feed-guild-' + ++counter } });
  const sessionHash = hash(user.id);
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: sessionHash,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return { accountId: user.id, sessionHash };
}
async function activeGuild() {
  const founder = await person();
  const operator = await person();
  const saved = await run((tx) =>
    saveGuildDraft(
      tx,
      {
        actor: { ...founder, actorAccountId: founder.accountId },
        input: {
          guildDraftId: null,
          expectedRevision: 0,
          profile: { name: 'Acme Guild', slug: 'acme-guild', description: 'Private-ish prose.' },
        },
        idempotencyKey: 'draft-key',
        requestId: 'draft-request',
      },
      { allowNewWrites: true },
    ),
  );
  const activated = await run((tx) =>
    activateGuild(
      tx,
      {
        actor: operator,
        input: {
          guildDraftId: saved.draft.id,
          expectedDraftRevision: saved.draft.revision,
          activationRef: 'evidence-record-1',
        },
        idempotencyKey: 'activate-key',
        requestId: 'activate-request',
      },
      { allowNewWrites: true, authorizeActivation: async () => true },
    ),
  );
  return { founder, guild: activated.guild };
}
async function policyVersion() {
  const [row] = (await db.$queryRawUnsafe(
    'SELECT "policyVersionId"::text AS id FROM "SkillAssessmentVersion" LIMIT 1',
  )) as { id: string }[];
  return row.id;
}
const need = (policy: string, minimumRank: string, skillId = 'frontend') => ({
  skillId,
  minimumRank,
  assessmentPolicyVersion: policy,
});

integration('T097 feed: Guild link and Eligible for me', { timeout: 120000 }, () => {
  afterAll(() => db.$disconnect());

  it('labels a card with the public Guild name and slug only; a Guild without a page gets nothing', async () => {
    assertTestDatabase();
    const fx = await seedOwnAssessmentFixture(false);
    expect(fx.ownerId).toBeTruthy();
    const { guild } = await activeGuild();
    const linked = await seedWorkSlot(db as never, undefined, { title: 'Linked Raid' });
    await seedWorkSlot(db as never, undefined, { title: 'Unlinked Raid' });
    // Point one listing at the real Guild; the guard that freezes listing identity is lifted only for this fixture.
    await db.$executeRawUnsafe('ALTER TABLE "WorkListing" DISABLE TRIGGER "WorkListing_guard"');
    try {
      await db.$executeRawUnsafe(
        `UPDATE "WorkListing" SET "guildId"=$1 WHERE "id"=$2::uuid`,
        guild.id,
        linked.listingId,
      );
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE "WorkListing" ENABLE TRIGGER "WorkListing_guard"');
    }
    const page = await run(async (tx) => {
      const base = await readWorkFeed(tx, {});
      return { ...base, items: await attachPublicGuilds(tx, base.items) };
    });
    const parsed = FeedPageSchema.parse(page);
    const byTitle = new Map(parsed.items.map((i) => [i.title, i]));
    expect(byTitle.get('Linked Raid')?.guild).toEqual({ slug: 'acme-guild', name: 'Acme Guild' });
    expect(byTitle.get('Unlinked Raid')?.guild).toBeUndefined();
    const text = JSON.stringify(parsed.items.map((i) => i.guild ?? null));
    for (const secret of ['founder', 'Private-ish', 'activationRef', 'evidence-record'])
      expect(text).not.toContain(secret);
    // The plain read model never fills it: a Guild reference appears only through the explicit public projection.
    const plain = await run((tx) => readWorkFeed(tx, {}));
    expect(plain.items.every((i) => i.guild === undefined)).toBe(true);
  });

  it('evaluates Eligible for me from the viewer’s current verified assessments and rechecks on every read', async () => {
    const fx = await seedOwnAssessmentFixture(true);
    const policy = await policyVersion();
    const actor = { accountId: fx.ownerId, sessionHash: fx.cookieHash };
    const fits = await seedWorkSlot(db as never, undefined, {
      title: 'Fits',
      requiredSkills: [need(policy, 'D')] as never,
    });
    const tooHigh = await seedWorkSlot(db as never, undefined, {
      title: 'Too high',
      requiredSkills: [need(policy, 'S')] as never,
    });
    const missing = await seedWorkSlot(db as never, undefined, {
      title: 'Missing skill',
      requiredSkills: [need(policy, 'D'), need(policy, 'D', 'backend')] as never,
    });
    const otherPolicy = await seedWorkSlot(db as never, undefined, {
      title: 'Other policy',
      requiredSkills: [need('some-other-policy', 'D')] as never,
    });
    const read = (eligibleOnly = false, query: unknown = {}) =>
      run(async (tx) =>
        readWorkFeed(tx, query, {
          evaluate: await createViewerEvaluator(tx, actor, TAXONOMY),
          eligibleOnly,
        }),
      );
    const all = await read();
    expect(all.viewer?.eligibility).toEqual({
      [fits.listingId]: 'ELIGIBLE',
      [tooHigh.listingId]: 'NOT_ELIGIBLE',
      [missing.listingId]: 'NOT_ELIGIBLE',
      [otherPolicy.listingId]: 'NOT_ELIGIBLE',
    });
    // The public cards carry no viewer facts, and the strict public page contract is untouched.
    expect(JSON.stringify(all.items)).not.toContain('ELIGIBLE');
    expect(all.items).toHaveLength(4);
    const only = await read(true);
    expect(only.items.map((i) => i.listingId)).toEqual([fits.listingId]);
    // Paging stays correct under the filter: a window of one still reaches the single eligible Raid.
    expect((await read(true, { limit: 1 })).nextCursor).toBeNull();
    // A revoked assessment is read fresh on the next request.
    await fx.decide('REVOKE');
    const after = await read(true);
    expect(after.items).toEqual([]);
    expect((await read()).viewer?.eligibility[fits.listingId]).toBe('NOT_ELIGIBLE');
    // Without a viewer nothing is computed and nothing is added.
    const anonymous = await run((tx) => readWorkFeed(tx, {}));
    expect('viewer' in anonymous).toBe(false);
  });

  it('is unknown for modes skills alone cannot decide, and rejects when the check cannot be made', async () => {
    const fx = await seedOwnAssessmentFixture(true);
    const policy = await policyVersion();
    const actor = { accountId: fx.ownerId, sessionHash: fx.cookieHash };
    const evaluate = await run((tx) => createViewerEvaluator(tx, actor, TAXONOMY));
    const terms = {
      requiredSkills: [need(policy, 'D')],
      execution: 'SOLO',
      participantKinds: ['HUMAN'],
    } as never;
    expect(evaluate(terms)).toBe('ELIGIBLE');
    // Publication does not allow these modes today; the answer stays honest if it ever does.
    expect(evaluate({ ...(terms as object), execution: 'PARTY' } as never)).toBe('UNKNOWN');
    expect(evaluate({ ...(terms as object), requiredSkills: [] } as never)).toBe('UNKNOWN');
    expect(evaluate({ ...(terms as object), participantKinds: ['AI_AGENT'] } as never)).toBe(
      'NOT_ELIGIBLE',
    );
    expect(
      evaluate({
        ...(terms as object),
        requiredSkills: [need(policy, 'D', 'not-in-taxonomy')],
      } as never),
    ).toBe('NOT_ELIGIBLE');
    await expect(
      run((tx) => createViewerEvaluator(tx, actor, 'no-such-taxonomy')),
    ).rejects.toBeDefined();
    await expect(
      run((tx) =>
        createViewerEvaluator(tx, { accountId: fx.ownerId, sessionHash: 'f'.repeat(64) }, TAXONOMY),
      ),
    ).rejects.toBeDefined();
  });
});
