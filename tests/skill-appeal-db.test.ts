import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import { activateGuild, grantGuildRole } from '../src/guild-profiles/guild-storage';
import {
  adjudicateSkillAssessmentAppeal,
  fileSkillAssessmentAppeal,
  listOverdueSkillAssessmentAppeals,
} from '../src/skill-appeals/storage';
import { seedOwnAssessmentFixture } from './helpers/own-assessment-fixture';
import { assertTestDatabase } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
type Actor = { accountId: string; sessionHash: string };
const windows = { filingWindowSeconds: 14 * 86400, adjudicationSeconds: 14 * 86400 };
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
let seed: Awaited<ReturnType<typeof seedOwnAssessmentFixture>>;
let appellant: Actor, originalReviewer: string, reference: { recordId: string; revision: number };
const allowlist = new Set<string>();
let counter = 0;
async function person(allowlisted = true): Promise<Actor> {
  const user = await db.user.create({ data: { handle: 'synthetic-adjudicator-' + ++counter } });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: sessionHash,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  if (allowlisted) allowlist.add(user.id);
  return { accountId: user.id, sessionHash };
}
const fileBody = (patch: Record<string, unknown> = {}) => ({
  version: 'v1',
  expectedAssessmentReference: reference,
  reasonCategory: 'RUBRIC_MISAPPLIED',
  statement: 'Synthetic statement: the rubric criterion was applied to the wrong artifact.',
  ...patch,
});
const file = (
  options: Partial<typeof windows & { allowNewWrites: boolean }> = {},
  body: unknown = fileBody(),
  actor = appellant,
  key = randomUUID(),
) =>
  run((tx) =>
    fileSkillAssessmentAppeal(
      tx,
      { actor, input: body, idempotencyKey: key, requestId: 'synthetic-file' },
      { allowNewWrites: true, ...windows, ...options },
    ),
  );
const adjudicate = (
  appealId: string,
  actor: Actor,
  outcome: 'UPHELD' | 'DENIED' = 'DENIED',
  options: { allowNewWrites?: boolean } = {},
  key = randomUUID(),
) =>
  run((tx) =>
    adjudicateSkillAssessmentAppeal(
      tx,
      {
        actor,
        input: {
          version: 'v1',
          appealId,
          outcome,
          reason: 'Synthetic bounded reason for the outcome.',
        },
        idempotencyKey: key,
        requestId: 'synthetic-adjudicate',
      },
      { allowNewWrites: true, isAdjudicator: (id) => allowlist.has(id), ...options },
    ),
  );
const assessmentRows = () =>
  db.$queryRawUnsafe<{ n: number; current: string }[]>(
    `SELECT (SELECT count(*)::int FROM "SkillAssessmentVersion") AS n, (SELECT "currentVersionId"::text FROM "SkillAssessment" LIMIT 1) AS current`,
  );

integration('T014 skill-assessment appeals: intake and independent adjudication (#357)', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    allowlist.clear();
    seed = await seedOwnAssessmentFixture(true);
    appellant = { accountId: seed.ownerId, sessionHash: seed.cookieHash };
    reference = seed.issued!.view.assessment!.reference;
    originalReviewer = seed.issued!.view.assessment!.evaluatorAccountId;
  });
  afterAll(() => db.$disconnect());

  it('files one pending appeal on the participant own decided version and changes nothing about the assessment', async () => {
    const before = await assessmentRows();
    const filed = await file();
    expect(filed.status).toBe('EXECUTED');
    expect(filed.appeal).toMatchObject({
      state: 'PENDING',
      assessmentReference: reference,
      reasonCategory: 'RUBRIC_MISAPPLIED',
      decidedAt: null,
    });
    expect(Date.parse(filed.appeal.adjudicationDueAt) - Date.parse(filed.appeal.filedAt)).toBe(
      14 * 86400 * 1000,
    );
    expect(JSON.stringify(filed.appeal)).not.toContain('wrong artifact');
    expect(JSON.stringify(filed.appeal)).not.toContain(originalReviewer);
    expect(await assessmentRows()).toEqual(before);
    expect(await db.outboxEvent.count()).toBe(0);
  });
  it('replays an identical retry and rejects a reused key with another body', async () => {
    const key = randomUUID();
    const first = await file({}, fileBody(), appellant, key);
    const again = await file({}, fileBody(), appellant, key);
    expect(again.status).toBe('REPLAYED');
    expect(again.appeal.id).toBe(first.appeal.id);
    await expect(
      file({}, fileBody({ reasonCategory: 'FACTUAL_ERROR' }), appellant, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('allows one appeal per decided version, even with a new key', async () => {
    await file();
    await expect(file()).rejects.toMatchObject({ code: 'APPEAL_EXISTS' });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "SkillAssessmentAppeal"')).toHaveLength(1);
  });
  it('refuses a filing after the window and keeps the boundary exact', async () => {
    await new Promise((r) => setTimeout(r, 1200));
    await expect(file({ filingWindowSeconds: 1 })).rejects.toMatchObject({
      code: 'WINDOW_CLOSED',
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "SkillAssessmentAppeal"')).toHaveLength(0);
  });
  it('refuses a stale version after a newer decision and a version the actor does not own', async () => {
    await expect(
      file({}, fileBody({ expectedAssessmentReference: { ...reference, revision: 2 } })),
    ).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    await seed.decide('REQUIRE_REASSESSMENT');
    await expect(file()).rejects.toMatchObject({ code: 'REVISION_CHANGED' });
    const stranger = await person(false);
    await db.participant.create({
      data: {
        accountId: stranger.accountId,
        provisionActorAccountId: stranger.accountId,
        provisionRequestId: 'synthetic-provision',
      },
    });
    await expect(
      file({}, fileBody({ expectedAssessmentReference: { ...reference, revision: 2 } }), stranger),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects category outside the closed list, extra fields and unauthenticated sessions', async () => {
    await expect(file({}, fileBody({ reasonCategory: 'OTHER' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(file({}, fileBody({ participantId: randomUUID() }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      file({}, fileBody(), { ...appellant, sessionHash: hash('missing') }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
  it('writes nothing while the switch is off, but still replays an original filing', async () => {
    await expect(file({ allowNewWrites: false })).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    const key = randomUUID();
    const first = await file({}, fileBody(), appellant, key);
    const replay = await file({ allowNewWrites: false }, fileBody(), appellant, key);
    expect(replay).toMatchObject({ status: 'REPLAYED', appeal: { id: first.appeal.id } });
  });

  it('keeps an overdue appeal pending, reports it, and never decides it automatically', async () => {
    const { appeal } = await file({ adjudicationSeconds: 1 });
    expect(await run((tx) => listOverdueSkillAssessmentAppeals(tx, { limit: 10 }))).toEqual([]);
    await new Promise((r) => setTimeout(r, 1300));
    const overdue = await run((tx) => listOverdueSkillAssessmentAppeals(tx, { limit: 10 }));
    expect(overdue).toEqual([
      expect.objectContaining({ appealId: appeal.id, overdueSeconds: expect.any(Number) }),
    ]);
    expect(JSON.stringify(overdue)).not.toContain(appellant.accountId);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "SkillAssessmentAppealDecision"')).toHaveLength(
      0,
    );
    expect(await adjudicate(appeal.id, await person())).toMatchObject({ status: 'EXECUTED' });
    expect(await run((tx) => listOverdueSkillAssessmentAppeals(tx, { limit: 10 }))).toEqual([]);
  });

  describe('adjudication', () => {
    let appealId: string;
    beforeEach(async () => {
      appealId = (await file()).appeal.id;
    });

    it('lets an independent allowlisted adjudicator deny: final, nothing changes, no rank', async () => {
      const before = await assessmentRows();
      const adjudicator = await person();
      const out = await adjudicate(appealId, adjudicator, 'DENIED');
      expect(out.appeal).toMatchObject({
        id: appealId,
        state: 'DENIED',
        freshReview: { required: false },
      });
      expect(await assessmentRows()).toEqual(before);
      await expect(adjudicate(appealId, await person(), 'UPHELD')).rejects.toMatchObject({
        code: 'ALREADY_DECIDED',
      });
      expect(await assessmentRows()).toEqual(before);
    });
    it('reopens for a fresh review on uphold without granting anything, excluding the original reviewer', async () => {
      const before = await assessmentRows();
      const out = await adjudicate(appealId, await person(), 'UPHELD');
      expect(out.appeal).toMatchObject({
        state: 'UPHELD',
        freshReview: { required: true, excludesOriginalReviewers: true },
      });
      expect(JSON.stringify(out)).not.toContain(originalReviewer);
      const [row] = await db.$queryRawUnsafe<{ excluded: string[] }[]>(
        'SELECT "freshReviewExcludedAccountIds" AS excluded FROM "SkillAssessmentAppealDecision"',
      );
      expect(row.excluded).toContain(originalReviewer);
      expect(await assessmentRows()).toEqual(before);
      const [{ ranks }] = await db.$queryRawUnsafe<{ ranks: number }[]>(
        `SELECT count(*)::int AS ranks FROM "SkillAssessmentVersion" WHERE "state"='VERIFIED' AND "revision">1`,
      );
      expect(ranks).toBe(0);
    });
    it('refuses the appellant even when allowlisted (no self-adjudication)', async () => {
      allowlist.add(appellant.accountId);
      await expect(adjudicate(appealId, appellant)).rejects.toMatchObject({
        code: 'SELF_ADJUDICATION',
      });
    });
    it('refuses the original reviewer even when allowlisted', async () => {
      allowlist.add(originalReviewer);
      const reviewer = await db.session.create({
        data: {
          userId: originalReviewer,
          tokenHash: hash(randomUUID()),
          via: 'wallet',
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      await expect(
        adjudicate(appealId, { accountId: originalReviewer, sessionHash: reviewer.tokenHash }),
      ).rejects.toMatchObject({ code: 'ORIGINAL_REVIEWER' });
    });
    it('refuses an adjudicator who is not on the allowlist or whose session is gone', async () => {
      const outsider = await person(false);
      await expect(adjudicate(appealId, outsider)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const ghost = await person();
      await expect(
        adjudicate(appealId, { ...ghost, sessionHash: hash('missing') }),
      ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    });
    it('refuses an adjudicator related to the appellant through a Guild role', async () => {
      const operator = await person();
      const draft = (
        await run((tx) =>
          saveGuildDraft(
            tx,
            {
              actor: { ...appellant, actorAccountId: appellant.accountId },
              input: {
                guildDraftId: null,
                expectedRevision: 0,
                profile: { name: 'Synthetic', slug: 'synthetic-appeal-guild', description: 'x' },
              },
              idempotencyKey: randomUUID(),
              requestId: 'synthetic-draft',
            },
            { allowNewWrites: true },
          ),
        )
      ).draft;
      const { guild } = await run((tx) =>
        activateGuild(
          tx,
          {
            actor: operator,
            input: {
              guildDraftId: draft.id,
              expectedDraftRevision: draft.revision,
              activationRef: 'synthetic-evidence',
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-activate',
          },
          { allowNewWrites: true, authorizeActivation: async () => true },
        ),
      );
      const adjudicator = await person();
      await run((tx) =>
        grantGuildRole(
          tx,
          {
            actor: appellant,
            input: { guildId: guild.id, granteeAccountId: adjudicator.accountId, kind: 'WORK' },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-grant',
          },
          { allowNewWrites: true },
        ),
      );
      await expect(adjudicate(appealId, adjudicator)).rejects.toMatchObject({
        code: 'GUILD_RELATIONSHIP',
      });
      // The Guild Founder (the appellant here) is just as related to a Founder-side adjudicator.
      expect(await adjudicate(appealId, await person())).toMatchObject({ status: 'EXECUTED' });
    });
    it('writes nothing while the switch is off but replays an original decision', async () => {
      const adjudicator = await person();
      await expect(
        adjudicate(appealId, adjudicator, 'DENIED', { allowNewWrites: false }),
      ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
      const key = randomUUID();
      const done = await adjudicate(appealId, adjudicator, 'DENIED', {}, key);
      const replay = await adjudicate(
        appealId,
        adjudicator,
        'DENIED',
        { allowNewWrites: false },
        key,
      );
      expect(replay).toMatchObject({ status: 'REPLAYED', appeal: { state: done.appeal.state } });
    });
    it('reports an unknown appeal as not found', async () => {
      await expect(adjudicate(randomUUID(), await person())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
    it('lets exactly one of two concurrent adjudicators decide', async () => {
      const [a, b] = [await person(), await person()];
      const settled = await Promise.allSettled([
        adjudicate(appealId, a, 'UPHELD'),
        adjudicate(appealId, b, 'DENIED'),
      ]);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const lost = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'ALREADY_DECIDED' });
      expect(
        await db.$queryRawUnsafe('SELECT 1 FROM "SkillAssessmentAppealDecision"'),
      ).toHaveLength(1);
    });
    it('is enforced by the database too: no self, original-reviewer or edited rows', async () => {
      const insert = (adjudicator: string) =>
        db.$executeRawUnsafe(
          `INSERT INTO "SkillAssessmentAppealDecision"("appealId","outcome","adjudicatorAccountId","reason","freshReviewExcludedAccountIds","receiptId","requestId") SELECT $1::uuid,'DENIED',$2,'x',ARRAY[]::text[],(SELECT "id" FROM "CommandReceipt" LIMIT 1),'r'`,
          appealId,
          adjudicator,
        );
      await expect(insert(appellant.accountId)).rejects.toThrow();
      await expect(insert(originalReviewer)).rejects.toThrow();
      await expect(
        db.$executeRawUnsafe(`UPDATE "SkillAssessmentAppeal" SET "statement"='edited'`),
      ).rejects.toThrow();
      await expect(db.$executeRawUnsafe(`DELETE FROM "SkillAssessmentAppeal"`)).rejects.toThrow();
    });
  });
});
