import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { submitWork, decideReview } from '../src/work-loop/submission-storage';
import type { SubmissionHost } from '../src/work-loop/submission-contracts';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { matchesBlockingObservation } from './helpers/lock-observation';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const cmd = (
  actor: { accountId: string; sessionHash: string },
  input: unknown,
  key: string = randomUUID(),
) => ({ actor, input, idempotencyKey: key, requestId: key });
const host: SubmissionHost = { allowNewWrites: true };
const work = (engagementId: string, expectedSubmissionNumber = 1) => ({
  engagementId,
  expectedSubmissionNumber,
  explanation: 'Guide written and verified on a clean machine.',
  artifacts: [
    {
      kind: 'COMMIT' as const,
      ref: 'synthetic://repo/setup.md',
      immutableVersion: 'a'.repeat(40),
    },
  ],
  dependencies: ['Public synthetic repository'],
  aiUsage: null,
});
const met = [{ index: 0, result: 'MET' as const, evidence: 'Installation output attached.' }];
const unmet = [{ index: 0, result: 'UNMET' as const, evidence: 'Step three fails.' }];
const review = (
  submissionId: string,
  decision: 'ACCEPT' | 'REQUEST_REVISION' | 'DISPUTE',
  criteria: unknown = decision === 'ACCEPT' ? met : unmet,
  revisionDeadline: string | null = decision === 'REQUEST_REVISION'
    ? new Date(Date.now() + 3600000).toISOString()
    : null,
) => ({
  submissionId,
  decision,
  reason: 'Reviewed against the accepted criteria.',
  criteria,
  revisionDeadline,
});
async function setup(override: Partial<ReturnType<typeof raidTerms>> = {}) {
  const worker = await seedWorkHuman(db),
    reviewer = await seedWorkHuman(db, 'reviewer-' + randomUUID());
  const slot = await seedWorkSlot(db, undefined, {
    review: { ...raidTerms().review, reviewerAccountId: reviewer.actor.accountId },
    ...override,
  });
  const accepted = await run((tx) =>
    commitEngagement(
      tx,
      cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      syntheticAcceptanceHost,
    ),
  );
  const engagementId = accepted.engagement.id;
  // Binding/access start belongs to a later task; the host moves the engagement through the guarded transition.
  await start(engagementId);
  return { worker, reviewer, slot, engagementId };
}
const start = (engagementId: string) =>
  db.$executeRawUnsafe(
    `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
    engagementId,
  );
const submit = (actor: Parameters<typeof cmd>[0], input: unknown, h = host, key?: string) =>
  run((tx) => submitWork(tx, cmd(actor, input, key), h));
const decide = (actor: Parameters<typeof cmd>[0], input: unknown, h = host, key?: string) =>
  run((tx) => decideReview(tx, cmd(actor, input, key), h));
const state = async (engagementId: string) =>
  (
    (await db.$queryRawUnsafe(
      'SELECT "state" FROM "Engagement" WHERE "id"=$1::uuid',
      engagementId,
    )) as { state: string }[]
  )[0].state;
const commitments = () =>
  db.$queryRawUnsafe('SELECT "participantId","engagementId" FROM "ActiveCommitment"');
const txOptions = { transaction: { timeout: 15000, maxWait: 15000 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const pid = async (tx: Prisma.TransactionClient) =>
  (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;
async function waitFor(waiter: number, blocker: number, statement: RegExp) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [row] = (await db.$queryRawUnsafe(
      'SELECT query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1::int',
      String(waiter),
    )) as { query: string; blockers: number[] }[];
    if (matchesBlockingObservation(row, blocker, statement)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected database blocking relationship was not observed.');
}
integration('T023 versioned submissions and criterion review', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('refuses text jsonb cannot store as invalid input, not as a raw database error', async () => {
    const { worker, engagementId } = await setup();
    for (const bad of ['a\u0000b', 'a\ud800b'])
      await expect(
        submit(worker.actor, { ...work(engagementId), explanation: bad }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await state(engagementId)).toBe('IN_PROGRESS');
  });
  it('audits stored rows against the shape rules, naming only ids', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'));
    const audit = readFileSync('scripts/audit-work-json-shape.sql', 'utf8');
    expect(await db.$queryRawUnsafe(audit)).toEqual([]);
    const sentinel = new Error('rollback');
    // A row written before the stricter rules existed: constraints and the immutability trigger are bypassed
    // inside this transaction only, then rolled back.
    const found = await db
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
          for (const c of [
            ['WorkSubmission', 'WorkSubmission_artifacts_shape_check'],
            ['WorkSubmission', 'WorkSubmission_dependencies_shape_check'],
            ['WorkReview', 'WorkReview_criteria_shape_check'],
          ])
            await tx.$executeRawUnsafe(`ALTER TABLE "${c[0]}" DROP CONSTRAINT "${c[1]}"`);
          await tx.$executeRawUnsafe(
            `UPDATE "WorkSubmission" SET "artifacts"='[{"kind":"COMMIT","ref":"\\t","immutableVersion":"v"}]'::jsonb,"dependencies"='["\\t"]'::jsonb`,
          );
          await tx.$executeRawUnsafe(
            `UPDATE "WorkReview" SET "criteria"='[{"index":0,"result":"MET","evidence":"\\t"}]'::jsonb`,
          );
          const rows = await tx.$queryRawUnsafe(audit);
          throw Object.assign(sentinel, { rows });
        },
        { timeout: 15000, maxWait: 15000 },
      )
      .catch((e) => {
        if (e !== sentinel) throw e;
        return (e as unknown as { rows: Record<string, string>[] }).rows;
      });
    expect(found.map((r) => [r.table, r.column])).toEqual([
      ['WorkReview', 'criteria'],
      ['WorkSubmission', 'artifacts'],
      ['WorkSubmission', 'dependencies'],
    ]);
    expect(await db.$queryRawUnsafe(audit)).toEqual([]);
  });
  it('records an immutable submission, holds capacity, and replays the original receipt', async () => {
    const { worker, engagementId } = await setup();
    const key = randomUUID();
    const first = await submit(worker.actor, work(engagementId), host, key);
    expect(first.status).toBe('EXECUTED');
    expect(first.submission.submissionNumber).toBe(1);
    expect(first.engagementState).toBe('SUBMITTED');
    expect(await state(engagementId)).toBe('SUBMITTED');
    expect(await commitments()).toHaveLength(1);
    const replay = await submit(worker.actor, work(engagementId), { allowNewWrites: false }, key);
    expect(replay.status).toBe('REPLAYED');
    expect(replay.submission.id).toBe(first.submission.id);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkSubmission"')).toHaveLength(1);
    await expect(
      db.$executeRawUnsafe(`UPDATE "WorkSubmission" SET "explanation"='changed'`),
    ).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "WorkSubmission"')).rejects.toThrow();
  });
  it('denies non-members, wrong state, stale numbers and disabled writes without side effects', async () => {
    const { worker, engagementId } = await setup();
    const stranger = await seedWorkHuman(db);
    await expect(submit(stranger.actor, work(engagementId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(submit(worker.actor, work(engagementId, 2))).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(
      submit(worker.actor, work(engagementId), { allowNewWrites: false }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    await submit(worker.actor, work(engagementId));
    await expect(submit(worker.actor, work(engagementId, 2))).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE',
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkSubmission"')).toHaveLength(1);
  });
  it('limits review to the exact terms reviewer and denies self-review or incomplete criteria', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const other = await seedWorkHuman(db);
    for (const actor of [worker.actor, other.actor])
      await expect(decide(actor, review(sub.submission.id, 'ACCEPT'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    await expect(
      decide(reviewer.actor, review(sub.submission.id, 'ACCEPT', [])),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      decide(reviewer.actor, review(sub.submission.id, 'ACCEPT', unmet)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkReview"')).toEqual([]);
    expect(await state(engagementId)).toBe('SUBMITTED');
  });
  it('denies a worker named as reviewer by the terms from reviewing their own submission', async () => {
    const worker = await seedWorkHuman(db);
    const slot = await seedWorkSlot(db, undefined, {
      review: { ...raidTerms().review, reviewerAccountId: worker.actor.accountId },
    });
    const accepted = await run((tx) =>
      commitEngagement(
        tx,
        cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
        syntheticAcceptanceHost,
      ),
    );
    await start(accepted.engagement.id);
    const sub = await submit(worker.actor, work(accepted.engagement.id));
    await expect(decide(worker.actor, review(sub.submission.id, 'ACCEPT'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await state(accepted.engagement.id)).toBe('SUBMITTED');
  });
  it('requires every original acceptance criterion to be judged exactly once', async () => {
    const { worker, reviewer, engagementId } = await setup({
      acceptanceCriteria: ['First original criterion.', 'Second original criterion.'],
    });
    const sub = await submit(worker.actor, work(engagementId));
    const one = { index: 0, result: 'MET' as const, evidence: null };
    for (const criteria of [[one], [one, { ...one, index: 2 }], [one, one]])
      await expect(
        decide(reviewer.actor, review(sub.submission.id, 'ACCEPT', criteria)),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT', [one, { ...one, index: 1 }]));
    expect(await state(engagementId)).toBe('ACCEPTED');
  });
  it('accepts the work, closes it and releases only the matching participant commitment', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const key = randomUUID();
    const accepted = await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'), host, key);
    expect(accepted.review.decision).toBe('ACCEPT');
    expect(accepted.engagementState).toBe('ACCEPTED');
    expect(await state(engagementId)).toBe('ACCEPTED');
    expect(await commitments()).toEqual([]);
    // The participant can hold a newer engagement; replaying the old decision cannot release it.
    const next = await seedWorkSlot(db);
    const newer = await run((tx) =>
      commitEngagement(
        tx,
        cmd(worker.actor, { slotId: next.slotId, termsVersionId: next.termsVersionId }),
        syntheticAcceptanceHost,
      ),
    );
    const replay = await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'), host, key);
    expect(replay.status).toBe('REPLAYED');
    expect(await commitments()).toEqual([
      { participantId: worker.participantId, engagementId: newer.engagement.id },
    ]);
    await expect(
      decide(reviewer.actor, review(sub.submission.id, 'REQUEST_REVISION')),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE' });
  });
  it('requests a bounded revision, accepts the resubmission and enforces the round limit', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const first = await submit(worker.actor, work(engagementId));
    const revision = await decide(reviewer.actor, review(first.submission.id, 'REQUEST_REVISION'));
    expect(revision.engagementState).toBe('REVISION_REQUESTED');
    expect(await commitments()).toHaveLength(1);
    await expect(
      decide(reviewer.actor, review(first.submission.id, 'ACCEPT')),
    ).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE',
    });
    const second = await submit(worker.actor, work(engagementId, 2));
    expect(second.submission.submissionNumber).toBe(2);
    await expect(
      decide(reviewer.actor, review(first.submission.id, 'ACCEPT')),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    // The fixture allows exactly one revision round.
    await expect(
      decide(reviewer.actor, review(second.submission.id, 'REQUEST_REVISION')),
    ).rejects.toMatchObject({ code: 'REVISION_LIMIT' });
    await decide(reviewer.actor, review(second.submission.id, 'ACCEPT'));
    expect(await state(engagementId)).toBe('ACCEPTED');
    expect(
      await db.$queryRawUnsafe('SELECT "submissionNumber" FROM "WorkSubmission" ORDER BY 1'),
    ).toEqual([{ submissionNumber: 1 }, { submissionNumber: 2 }]);
  });
  it('requires a finite future revision deadline inside operational closure', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    for (const deadline of [
      null,
      new Date(Date.now() - 1000).toISOString(),
      '2999-01-01T00:00:00.000Z',
    ])
      await expect(
        decide(reviewer.actor, review(sub.submission.id, 'REQUEST_REVISION', unmet, deadline)),
      ).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_INPUT|DEADLINE_PASSED/) });
    expect(await state(engagementId)).toBe('SUBMITTED');
  });
  it('records a reasoned dispute without releasing capacity or allowing further decisions', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const disputed = await decide(reviewer.actor, review(sub.submission.id, 'DISPUTE'));
    expect(disputed.review.decision).toBe('DISPUTE');
    expect(await state(engagementId)).toBe('SUBMITTED');
    expect(await commitments()).toHaveLength(1);
    await expect(decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'))).rejects.toMatchObject(
      {
        code: 'REVIEW_EXISTS',
      },
    );
    await expect(submit(worker.actor, work(engagementId, 2))).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE',
    });
  });
  it('serializes a revision request against a competing acceptance behind the real engagement lock', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const ready = deferred<number>(),
      waiter = deferred<number>(),
      release = deferred<void>();
    const first = runCommandTransaction(
      db,
      async (port, tx) => {
        const result = await decideReview(
          port,
          cmd(reviewer.actor, review(sub.submission.id, 'REQUEST_REVISION')),
          host,
        );
        ready.resolve(await pid(tx));
        await release.promise;
        return result;
      },
      txOptions,
    );
    let second: Promise<unknown> | undefined;
    try {
      const blocker = await Promise.race([
        ready.promise,
        first.then(() => {
          throw Error('First decision ended before its barrier.');
        }),
      ]);
      second = runCommandTransaction(
        db,
        async (port, tx) => {
          waiter.resolve(await pid(tx));
          return decideReview(port, cmd(reviewer.actor, review(sub.submission.id, 'ACCEPT')), host);
        },
        txOptions,
      );
      const results = Promise.allSettled([first, second]);
      await waitFor(
        await Promise.race([
          waiter.promise,
          second.then(() => {
            throw Error('Second decision ended before observing its backend.');
          }),
        ]),
        blocker,
        /"Engagement".*FOR UPDATE/s,
      );
      release.resolve();
      const settled = await results;
      expect(settled[0].status).toBe('fulfilled');
      expect(settled[1]).toMatchObject({
        status: 'rejected',
        reason: { code: 'ENGAGEMENT_STATE' },
      });
      expect(await state(engagementId)).toBe('REVISION_REQUESTED');
      expect(await commitments()).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });
  it('lets exactly one of two concurrent review decisions win', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const sub = await submit(worker.actor, work(engagementId));
    const results = await Promise.allSettled([
      decide(reviewer.actor, review(sub.submission.id, 'ACCEPT')),
      decide(reviewer.actor, review(sub.submission.id, 'REQUEST_REVISION')),
      decide(reviewer.actor, review(sub.submission.id, 'DISPUTE')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkReview"')).toHaveLength(1);
    const final = await state(engagementId);
    const live = (await commitments()) as unknown[];
    expect(live).toHaveLength(final === 'ACCEPTED' ? 0 : 1);
  });
  it('lets exactly one of two concurrent identical-number submissions win', async () => {
    const { worker, engagementId } = await setup();
    const results = await Promise.allSettled([
      submit(worker.actor, work(engagementId)),
      submit(worker.actor, work(engagementId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkSubmission"')).toHaveLength(1);
  });
  it('rejects submissions after the accepted submission deadline', async () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const { worker, engagementId } = await setup({
      deadlines: {
        commitment: at(3000),
        preparation: at(3500),
        submission: at(4000),
        review: at(4500),
        operationalClosure: at(5000),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 4200));
    await expect(submit(worker.actor, work(engagementId))).rejects.toMatchObject({
      code: 'DEADLINE_PASSED',
    });
  });
  it('refuses direct engagement inserts that skip acceptance or its pending state', async () => {
    const { worker } = await setup();
    const other = await seedWorkSlot(db);
    for (const [state, revision] of [
      ['ACCEPTED', '7'],
      ['IN_PROGRESS', '1'],
      ['ACCESS_PENDING', '3'],
    ])
      await expect(
        db.$transaction(async (tx) => {
          const [e] = (await tx.$queryRawUnsafe(
            `INSERT INTO "Engagement" ("slotId","termsVersionId","guildId","acceptedTerms","acceptedDigest","state","revision")
             SELECT s."id",s."termsVersionId",l."guildId",
              jsonb_build_object('id',s."termsVersionId",'guildId',l."guildId",'revision',t."revision",'acceptanceCriteria',t."snapshot"->'acceptanceCriteria','requiredSkills',t."snapshot"->'requiredSkills','deadlines',(t."snapshot"->'deadlines')-'commitment','roster',jsonb_build_array(jsonb_build_object('participantId',$1::text)),'rewards',(SELECT jsonb_agg(jsonb_build_object('policy',r->'policy','amount',r->>'amount','beneficiaryParticipantId',$1::text)) FROM jsonb_array_elements(t."snapshot"->'rewards') r)),
              repeat('a',64),$2,$3::int
             FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=s."termsVersionId" WHERE s."id"=$4::uuid RETURNING "id"::text`,
            worker.participantId,
            state,
            revision,
            other.slotId,
          )) as { id: string }[];
          await tx.$executeRawUnsafe(
            `INSERT INTO "EngagementMember" ("engagementId","participantId","termsVersionId") VALUES ($1::uuid,$2::uuid,$3::uuid)`,
            e.id,
            worker.participantId,
            other.termsVersionId,
          );
          await tx.$executeRawUnsafe(
            `UPDATE "RaidSlot" SET "state"='FILLED' WHERE "id"=$1::uuid`,
            other.slotId,
          );
        }),
      ).rejects.toThrow(/starts ACCESS_PENDING at revision 1/);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "Engagement"')).toHaveLength(1);
  });
  it('rejects malformed artifact, dependency and criterion JSON from direct writers', async () => {
    const { worker, reviewer, slot, engagementId } = await setup();
    const rolledBack = Error('rolled back after the statement was accepted');
    const attempt = async (sql: string, ...args: string[]) => {
      try {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(sql, ...args);
          throw rolledBack;
        });
      } catch (error) {
        return error === rolledBack ? 'accepted' : 'rejected';
      }
      return 'accepted';
    };
    const insertSubmission = (artifacts: unknown, dependencies: unknown = []) =>
      attempt(
        `INSERT INTO "WorkSubmission" ("engagementId","termsVersionId","submissionNumber","submitterParticipantId","explanation","artifacts","dependencies","digest") VALUES ($1::uuid,$2::uuid,1,$3::uuid,'Guide written.',$4::jsonb,$5::jsonb,repeat('a',64))`,
        engagementId,
        slot.termsVersionId,
        worker.participantId,
        JSON.stringify(artifacts),
        JSON.stringify(dependencies),
      );
    const good = {
      kind: 'COMMIT',
      ref: 'synthetic://repo/setup.md',
      immutableVersion: 'a'.repeat(40),
    };
    expect(await insertSubmission([good])).toBe('accepted');
    for (const artifacts of [
      [{ kind: 'COMMIT' }],
      [{ ...good, extra: true }],
      [{ ...good, kind: 'FTP' }],
      [{ ...good, ref: '' }],
      [{ ...good, ref: 'x'.repeat(501) }],
      [{ ...good, immutableVersion: 7 }],
      [{ ...good, immutableVersion: 'v'.repeat(201) }],
      ['not an object'],
      [good, good],
    ])
      expect(await insertSubmission(artifacts), JSON.stringify(artifacts)).toBe('rejected');
    for (const dependencies of [[1], [''], [{ name: 'x' }], ['x'.repeat(8001)]])
      expect(await insertSubmission([good], dependencies), JSON.stringify(dependencies)).toBe(
        'rejected',
      );
    await submit(worker.actor, {
      engagementId,
      expectedSubmissionNumber: 1,
      explanation: 'Guide written.',
      artifacts: [good],
      dependencies: [],
      aiUsage: null,
    });
    const submissionId = (
      (await db.$queryRawUnsafe('SELECT "id"::text FROM "WorkSubmission"')) as { id: string }[]
    )[0].id;
    const insertReview = (criteria: unknown) =>
      attempt(
        `INSERT INTO "WorkReview" ("submissionId","engagementId","termsVersionId","reviewerAccountId","decision","reason","criteria","digest") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'DISPUTE','Not what was agreed.',$5::jsonb,repeat('a',64))`,
        submissionId,
        engagementId,
        slot.termsVersionId,
        reviewer.actor.accountId,
        JSON.stringify(criteria),
      );
    const met = { index: 0, result: 'MET', evidence: 'Verified.' };
    expect(await insertReview([met])).toBe('accepted');
    for (const criteria of [
      [{ index: 0, result: 'MET' }],
      [{ ...met, extra: true }],
      [{ ...met, index: 50 }],
      [{ ...met, index: 1.5 }],
      [{ ...met, index: -1 }],
      [{ ...met, index: '0' }],
      [{ ...met, result: 'MAYBE' }],
      [{ ...met, evidence: '' }],
      [{ ...met, evidence: 'e'.repeat(2001) }],
      [{ ...met, evidence: 3 }],
      [met, { ...met, result: 'UNMET' }],
      ['not an object'],
    ])
      expect(await insertReview(criteria), JSON.stringify(criteria)).toBe('rejected');
  });
  it('mirrors the command schema trim and UTF-16 length rules in the JSON shape checks', async () => {
    const { worker, reviewer, slot, engagementId } = await setup();
    const rolledBack = Error('rolled back after the statement was accepted');
    // Reports which constraint refused a statement, so another guard cannot mask a missing CHECK.
    const attempt = async (sql: string, ...args: string[]) => {
      try {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(sql, ...args);
          throw rolledBack;
        });
      } catch (error) {
        if (error === rolledBack) return 'accepted';
        return /check constraint "([^"]+)"/.exec(String((error as Error).message))?.[1] ?? 'other';
      }
      return 'accepted';
    };
    const artifactsCheck = 'WorkSubmission_artifacts_shape_check';
    const insertSubmission = (artifacts: unknown, dependencies: unknown = []) =>
      attempt(
        `INSERT INTO "WorkSubmission" ("engagementId","termsVersionId","submissionNumber","submitterParticipantId","explanation","artifacts","dependencies","digest") VALUES ($1::uuid,$2::uuid,1,$3::uuid,'Guide written.',$4::jsonb,$5::jsonb,repeat('a',64))`,
        engagementId,
        slot.termsVersionId,
        worker.participantId,
        JSON.stringify(artifacts),
        JSON.stringify(dependencies),
      );
    const good = {
      kind: 'COMMIT',
      ref: 'synthetic://repo/setup.md',
      immutableVersion: 'a'.repeat(40),
    };
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...good, ref: good.ref + '#' + i }));
    // Whitespace that JavaScript trim() removes but ASCII btrim() keeps.
    for (const blank of ['\t', ' ', ' ', '　', '﻿', ' \n  '])
      expect(await insertSubmission([{ ...good, ref: blank }]), JSON.stringify(blank)).toBe(
        artifactsCheck,
      );
    expect(await insertSubmission([{ ...good, immutableVersion: ' ' }])).toBe(artifactsCheck);
    expect(await insertSubmission([{ ...good, ref: 'x'.repeat(500) }])).toBe('accepted');
    expect(await insertSubmission([{ ...good, ref: 'x'.repeat(501) }])).toBe(artifactsCheck);
    // zod counts UTF-16 units: 250 emoji are 500 units, 251 are 502 although only 251 code points.
    expect(await insertSubmission([{ ...good, ref: '\u{1F600}'.repeat(250) }])).toBe('accepted');
    expect(await insertSubmission([{ ...good, ref: '\u{1F600}'.repeat(251) }])).toBe(
      artifactsCheck,
    );
    // A JSON null is not a string: zod's enum refuses it, so the database must too.
    expect(await insertSubmission([{ ...good, kind: null }])).toBe(artifactsCheck);
    // Padding is trimmed before the limit and the duplicate check, exactly as the command schema does.
    expect(await insertSubmission([{ ...good, ref: '\u00a0' + 'x'.repeat(500) + '\t' }])).toBe(
      'accepted',
    );
    expect(await insertSubmission([good, { ...good, ref: '\u3000' + good.ref + '\u00a0' }])).toBe(
      artifactsCheck,
    );
    expect(await insertSubmission(many(20))).toBe('accepted');
    // Counts are bounded by the older column checks, which fire first.
    expect(await insertSubmission(many(21))).toBe('WorkSubmission_artifacts_check');
    expect(await insertSubmission([])).toBe('WorkSubmission_artifacts_check');
    const dependenciesCheck = 'WorkSubmission_dependencies_shape_check';
    expect(await insertSubmission([good], ['npm:left-pad@1.0.0'])).toBe('accepted');
    expect(await insertSubmission([good], ['\t'])).toBe(dependenciesCheck);
    expect(
      await insertSubmission(
        [good],
        Array.from({ length: 50 }, (_, i) => 'd' + i),
      ),
    ).toBe('accepted');
    expect(
      await insertSubmission(
        [good],
        Array.from({ length: 51 }, (_, i) => 'd' + i),
      ),
    ).toBe('WorkSubmission_dependencies_check');
    expect(await insertSubmission([good], ['\u{1F600}'.repeat(4000)])).toBe('accepted');
    expect(await insertSubmission([good], ['\u{1F600}'.repeat(4001)])).toBe(dependenciesCheck);
    await submit(worker.actor, {
      engagementId,
      expectedSubmissionNumber: 1,
      explanation: 'Guide written.',
      artifacts: [good],
      dependencies: [],
      aiUsage: null,
    });
    const submissionId = (
      (await db.$queryRawUnsafe('SELECT "id"::text FROM "WorkSubmission"')) as { id: string }[]
    )[0].id;
    const insertReview = (criteria: unknown) =>
      attempt(
        `INSERT INTO "WorkReview" ("submissionId","engagementId","termsVersionId","reviewerAccountId","decision","reason","criteria","digest") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'DISPUTE','Not what was agreed.',$5::jsonb,repeat('a',64))`,
        submissionId,
        engagementId,
        slot.termsVersionId,
        reviewer.actor.accountId,
        JSON.stringify(criteria),
      );
    const criteriaCheck = 'WorkReview_criteria_shape_check';
    const at = (index: number) => ({ index, result: 'MET', evidence: null });
    const criteria = (count: number) => Array.from({ length: count }, (_, i) => at(i));
    expect(await insertReview([at(49)])).toBe('accepted');
    expect(await insertReview(criteria(50))).toBe('accepted');
    expect(await insertReview(criteria(51))).toBe('WorkReview_criteria_check');
    expect(await insertReview([])).toBe('WorkReview_criteria_check');
    expect(await insertReview([{ ...at(0), evidence: ' \t' }])).toBe(criteriaCheck);
    expect(await insertReview([{ ...at(0), evidence: '\u{1F600}'.repeat(1000) }])).toBe('accepted');
    expect(await insertReview([{ ...at(0), evidence: '\u{1F600}'.repeat(1001) }])).toBe(
      criteriaCheck,
    );
    expect(await insertReview([{ ...at(0), result: null }])).toBe(criteriaCheck);
    expect(await insertReview([at(0), { ...at(0), result: 'UNMET' }])).toBe(criteriaCheck);
  });
  it('ties every lifecycle state change to its evidence row even for direct writers', async () => {
    const { worker, reviewer, engagementId } = await setup();
    const bare = (to: string, release = false) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "Engagement" SET "state"=$2,"revision"="revision"+1 WHERE "id"=$1::uuid`,
          engagementId,
          to,
        );
        if (release) await tx.$executeRawUnsafe('DELETE FROM "ActiveCommitment"');
      });
    // No submission exists: SUBMITTED, REVISION_REQUESTED and ACCEPTED are all unproven.
    await expect(bare('SUBMITTED')).rejects.toThrow();
    const sub = await submit(worker.actor, work(engagementId));
    // A submission without a review proves neither a revision request nor acceptance.
    await expect(bare('REVISION_REQUESTED')).rejects.toThrow();
    await expect(bare('ACCEPTED', true)).rejects.toThrow();
    // A dispute is not an acceptance.
    await decide(reviewer.actor, review(sub.submission.id, 'DISPUTE'));
    await expect(bare('ACCEPTED', true)).rejects.toThrow();
    await expect(bare('REVISION_REQUESTED')).rejects.toThrow();
    expect(await state(engagementId)).toBe('SUBMITTED');
    expect(await commitments()).toHaveLength(1);
  });
  it('enforces the lifecycle and capacity guards at the database even for direct writers', async () => {
    const { worker, reviewer, engagementId } = await setup();
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Engagement" SET "state"='ACCEPTED',"revision"="revision"+1 WHERE "id"=$1::uuid`,
        engagementId,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Engagement" SET "guildId"='other' WHERE "id"=$1::uuid`,
        engagementId,
      ),
    ).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "Engagement"')).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "ActiveCommitment"')).rejects.toThrow();
    const sub = await submit(worker.actor, work(engagementId));
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "WorkSubmission" ("engagementId","termsVersionId","submissionNumber","submitterParticipantId","explanation","artifacts","dependencies","digest") SELECT "engagementId","termsVersionId",2,"participantId",'x','[{"kind":"COMMIT","ref":"r","immutableVersion":"v"}]','[]',repeat('a',64) FROM "EngagementMember"`,
      ),
    ).rejects.toThrow();
    const accepted = await decide(reviewer.actor, review(sub.submission.id, 'ACCEPT'));
    expect(accepted.engagementState).toBe('ACCEPTED');
    await expect(
      db.$executeRawUnsafe(`UPDATE "WorkReview" SET "reason"='changed'`),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
        engagementId,
      ),
    ).rejects.toThrow();
  });
});
