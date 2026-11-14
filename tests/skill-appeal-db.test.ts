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
import { waitForAdvisoryWaiter } from './helpers/advisory-wait';

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
/** Holds a transaction-level advisory lock open until released, like an in-flight writer. */
async function holdLock(key: string, classId: number) {
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const got = new Promise<void>((r) => (acquired = r));
  const done = db.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,$2::bigint))::text',
        key,
        classId,
      );
      acquired();
      await gate;
    },
    { timeout: 60000 },
  );
  await got;
  return async () => {
    release();
    await done;
  };
}
const waiters = async (key: string, classId: number) =>
  (
    await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objsubid=1 AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1,$2::bigint)`,
      key,
      classId,
    )
  )[0].n;
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

  it('lets exactly one of two simultaneous filings win and the other see APPEAL_EXISTS', async () => {
    const settled = await Promise.allSettled([file(), file()]);
    expect(settled.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'APPEAL_EXISTS' });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "SkillAssessmentAppeal"')).toHaveLength(1);
  });
  it('replays one result for two simultaneous filings sharing a key', async () => {
    const key = randomUUID();
    const both = await Promise.all([
      file({}, fileBody(), appellant, key),
      file({}, fileBody(), appellant, key),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual(['EXECUTED', 'REPLAYED']);
    expect(both[0].appeal.id).toBe(both[1].appeal.id);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "SkillAssessmentAppeal"')).toHaveLength(1);
  });
  it('serializes a filing against a new assessment decision (no appeal on a version that was not current)', async () => {
    const key = seed.participantId + ':frontend';
    const release = await holdLock(key, 12022);
    const decision = seed.decide('REQUIRE_REASSESSMENT');
    const decided = decision.then(
      () => 'done',
      (e) => e,
    );
    expect(await waitForAdvisoryWaiter(db, key, 12022)).toBe(true);
    const filing = file().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    for (let i = 0; i < 100 && (await waiters(key, 12022)) < 2; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(await waiters(key, 12022)).toBe(2);
    await release();
    expect(await decided).toBe('done');
    const out = await filing;
    const appeals = await db.$queryRawUnsafe<{ revision: number }[]>(
      'SELECT v."revision" FROM "SkillAssessmentAppeal" a JOIN "SkillAssessmentVersion" v ON v."id"=a."assessmentVersionId"',
    );
    if ('error' in out) {
      expect(out.error).toMatchObject({ code: 'REVISION_CHANGED' });
      expect(appeals).toHaveLength(0);
    } else {
      // The filing committed first: it names the version that was current when it was filed.
      expect(appeals).toEqual([{ revision: 1 }]);
    }
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM "SkillAssessmentVersion"',
    );
    expect(n).toBe(2);
  });
  it('the database refuses an appeal on a version that is not the current decided one, by message', async () => {
    await seed.decide('REQUIRE_REASSESSMENT');
    const insert = (revision: number, notice = 'v."issuedAt"') =>
      db.$executeRawUnsafe(
        `INSERT INTO "SkillAssessmentAppeal"("assessmentVersionId","participantId","appellantAccountId","reasonCategory","statement","decisionNoticeAt","filingDeadlineAt","filedAt","adjudicationDueAt","receiptId","requestId") SELECT v."id",v."participantId",p."accountId",'FACTUAL_ERROR','s',${notice},v."issuedAt"+interval '14 days',clock_timestamp(),clock_timestamp()+interval '14 days',(SELECT "id" FROM "CommandReceipt" LIMIT 1),'r' FROM "SkillAssessmentVersion" v JOIN "Participant" p ON p."id"=v."participantId" WHERE v."revision"=$1::int`,
        String(revision),
      );
    await expect(insert(1)).rejects.toThrow(/own current decided version/);
    await expect(insert(2, `v."issuedAt"-interval '1 second'`)).rejects.toThrow(
      /own current decided version/,
    );
    expect(await insert(2)).toBe(1);
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
        code: 'FORBIDDEN',
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
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
        code: 'FORBIDDEN',
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
    it('is enforced by the database too, with the trigger reason, and rows are immutable', async () => {
      const insert = (
        adjudicator: string,
        outcome = 'DENIED',
        excluded = 'ARRAY[]::text[]',
        decidedAt = "date_trunc('milliseconds',clock_timestamp())",
      ) =>
        db.$executeRawUnsafe(
          `INSERT INTO "SkillAssessmentAppealDecision"("appealId","outcome","adjudicatorAccountId","reason","freshReviewExcludedAccountIds","decidedAt","receiptId","requestId") SELECT $1::uuid,$2,$3,'x',${excluded},${decidedAt},(SELECT "id" FROM "CommandReceipt" LIMIT 1),'r'`,
          appealId,
          outcome,
          adjudicator,
        );
      const independent = /must be independent of the appellant and the original reviewers/;
      await expect(insert(appellant.accountId)).rejects.toThrow(independent);
      await expect(insert(originalReviewer)).rejects.toThrow(independent);
      const fresh = (await person()).accountId;
      await expect(insert(fresh, 'UPHELD', `ARRAY['synthetic-other']::text[]`)).rejects.toThrow(
        /must exclude every original reviewer/,
      );
      await expect(insert(fresh, 'UPHELD')).rejects.toThrow(/must exclude every original reviewer/);
      await expect(insert(fresh, 'DENIED', `ARRAY['x']::text[]`)).rejects.toThrow(
        /violates check constraint/,
      );
      await expect(
        insert(
          fresh,
          'DENIED',
          'ARRAY[]::text[]',
          `(SELECT "filedAt"-interval '1 second' FROM "SkillAssessmentAppeal")`,
        ),
      ).rejects.toThrow(/cannot precede the filing/);
      await expect(
        db.$executeRawUnsafe(`UPDATE "SkillAssessmentAppeal" SET "statement"='edited'`),
      ).rejects.toThrow(/appeal history is immutable/);
      await expect(db.$executeRawUnsafe(`DELETE FROM "SkillAssessmentAppeal"`)).rejects.toThrow(
        /appeal history is immutable/,
      );
      // Positive control: the same statement shape is accepted for an independent adjudicator.
      expect(await insert(fresh, 'UPHELD', `ARRAY['${originalReviewer}']::text[]`)).toBe(1);
      await expect(
        db.$executeRawUnsafe(`UPDATE "SkillAssessmentAppealDecision" SET "reason"='edited'`),
      ).rejects.toThrow(/decisions are immutable/);
      await expect(
        db.$executeRawUnsafe(`DELETE FROM "SkillAssessmentAppealDecision"`),
      ).rejects.toThrow(/decisions are immutable/);
    });
    it('answers a conflicted adjudicator with the same refusal whether the appeal is pending or decided', async () => {
      allowlist.add(appellant.accountId);
      allowlist.add(originalReviewer);
      const reviewerSession = hash(randomUUID());
      await db.session.create({
        data: {
          userId: originalReviewer,
          tokenHash: reviewerSession,
          via: 'wallet',
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      const reviewer = { accountId: originalReviewer, sessionHash: reviewerSession };
      for (const who of [appellant, reviewer])
        await expect(adjudicate(appealId, who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await adjudicate(appealId, await person(), 'DENIED');
      for (const who of [appellant, reviewer])
        await expect(adjudicate(appealId, who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(adjudicate(appealId, await person())).rejects.toMatchObject({
        code: 'ALREADY_DECIDED',
      });
    });
    it('waits for an in-flight case commit before reading the original reviewers', async () => {
      const release = await holdLock(seed.submissionId, 12020);
      let finished = false;
      const pending = adjudicate(appealId, await person(), 'UPHELD').finally(() => {
        finished = true;
      });
      expect(await waitForAdvisoryWaiter(db, seed.submissionId, 12020)).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(finished).toBe(false);
      await release();
      expect((await pending).appeal.state).toBe('UPHELD');
    });
  });
});
