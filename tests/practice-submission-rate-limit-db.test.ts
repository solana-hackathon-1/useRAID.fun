import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../src/skills/practice-trial-storage';
import { startPracticeTrial } from '../src/skills/practice-trial-attempt-storage';
import {
  submitPracticeTrial,
  PracticeTrialSubmissionStorageError,
} from '../src/skills/practice-trial-submission-storage';
import { definition as fixture } from '../examples/skill-assessments/fixtures';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const catalogId = 'synthetic-limit-catalog',
  trialId = 'synthetic-limit-trial',
  rubricId = 'synthetic-limit-rubric';
let publisher: SkillTaxonomyActor;
async function actor() {
  const user = await db.user.create({ data: { handle: 'synthetic', role: 'CREATOR' } });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: user.id,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  await db.participant.create({
    data: {
      accountId: user.id,
      provisionActorAccountId: user.id,
      provisionRequestId: 'synthetic-provision',
    },
  });
  return { accountId: user.id, sessionHash };
}
async function admin() {
  const user = await db.user.create({
    data: { handle: 'synthetic-admin', role: 'ADMIN', xId: randomUUID() },
  });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: user.id,
      via: 'x',
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  return { accountId: user.id, sessionHash };
}
const begin = async (a: SkillTaxonomyActor) =>
  (
    await runCommandTransaction(db, (tx) =>
      startPracticeTrial(
        tx,
        {
          actor: a,
          input: {
            version: 'v1',
            definitionReference: { recordId: trialId, revision: 1 },
            accommodationReference: null,
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-start',
        },
        { allowNewWrites: true },
      ),
    )
  ).start.id;
const body = (startId: string) => ({
  version: 'v1',
  startId,
  expectedDefinitionReference: { recordId: trialId, revision: 1 },
  expectedRubricReference: { recordId: rubricId, revision: 1 },
  answer: 'const answer = 1;',
  explanation: 'Synthetic explanation.',
  toolsUsed: ['editor'],
  aiAssistanceUsed: false,
  assistanceDisclosure: 'None.',
});
type Limit = { max: number; windowSeconds: number };
const submit = (a: SkillTaxonomyActor, startId: string, limit?: Limit, key = randomUUID()) =>
  runCommandTransaction(db, (tx) =>
    submitPracticeTrial(
      tx,
      { actor: a, input: body(startId), idempotencyKey: key, requestId: 'synthetic-submit' },
      { allowNewWrites: true, ...(limit ? { submissionRateLimit: limit } : {}) },
    ),
  );
const submissions = async () =>
  (
    await db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int n FROM "PracticeTrialSubmission"',
    )
  )[0].n;
const receipts = async () =>
  (
    await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int n FROM "CommandReceipt" WHERE "commandKind"='SubmitPracticeTrial'`,
    )
  )[0].n;
const limited = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PracticeTrialSubmissionStorageError);
  return error as PracticeTrialSubmissionStorageError & { retryAfterSeconds?: number };
};

integration('T014 per-account practice submission rate limit (#56, O09 default not policy)', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    publisher = await admin();
    await runCommandTransaction(db, (tx) =>
      publishSkillTaxonomy(
        tx,
        {
          actor: publisher,
          input: {
            taxonomyId: catalogId,
            expectedRevision: 0,
            skills: [
              {
                id: 'frontend',
                domain: 'web',
                name: 'Frontend',
                status: 'ACTIVE',
                aliases: ['frontend'],
              },
            ],
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-catalog',
        },
        { allowNewWrites: true, canPublish: () => true },
      ),
    );
    const draft = structuredClone(fixture);
    for (const field of ['reference', 'publishedAt', 'state']) Reflect.deleteProperty(draft, field);
    await runCommandTransaction(db, (tx) =>
      publishPracticeTrialDefinition(
        tx,
        {
          actor: publisher,
          input: {
            trialId,
            expectedRevision: 0,
            taxonomyReference: { recordId: catalogId, revision: 1 },
            availability: 'AVAILABLE',
            draft: {
              ...draft,
              maximumAttempts: 3,
              cooldownSeconds: 0,
              rubric: { ...draft.rubric, reference: { recordId: rubricId, revision: 1 } },
            },
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-definition',
        },
        { allowNewWrites: true, canPublish: () => true },
      ),
    );
  });
  afterAll(() => db.$disconnect());

  it('refuses a submission over the account limit with RATE_LIMITED and a bounded retry delay, leaving no row or receipt', async () => {
    const a = await actor();
    const limit = { max: 2, windowSeconds: 3600 };
    const [s1, s2, s3] = [await begin(a), await begin(a), await begin(a)];
    expect((await submit(a, s1, limit)).status).toBe('EXECUTED');
    expect((await submit(a, s2, limit)).status).toBe('EXECUTED');
    const error = await limited(submit(a, s3, limit));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect([await submissions(), await receipts()]).toEqual([2, 2]);
  });

  it('is per account: another account is unaffected, and an unconfigured host keeps the previous behaviour', async () => {
    const a = await actor(),
      b = await actor();
    const limit = { max: 1, windowSeconds: 3600 };
    await submit(a, await begin(a), limit);
    expect((await submit(b, await begin(b), limit)).status).toBe('EXECUTED');
    expect((await submit(a, await begin(a))).status).toBe('EXECUTED');
  });

  it('replays an earlier accepted submission even while the account is over its limit', async () => {
    const a = await actor();
    const limit = { max: 1, windowSeconds: 3600 };
    const first = await begin(a);
    const key = randomUUID();
    const done = await submit(a, first, limit, key);
    await limited(submit(a, await begin(a), limit));
    const replay = await submit(a, first, limit, key);
    expect(replay.status).toBe('REPLAYED');
    expect(replay.submission.reference.recordId).toBe(done.submission.reference.recordId);
  });

  it('does not consume the idempotency key: the same command succeeds once the limit allows it', async () => {
    const a = await actor();
    await submit(a, await begin(a), { max: 1, windowSeconds: 3600 });
    const second = await begin(a);
    const key = randomUUID();
    await limited(submit(a, second, { max: 1, windowSeconds: 3600 }, key));
    expect((await submit(a, second, { max: 2, windowSeconds: 3600 }, key)).status).toBe('EXECUTED');
  });

  it('allows a new submission when the window has passed', async () => {
    const a = await actor();
    const limit = { max: 1, windowSeconds: 1 };
    await submit(a, await begin(a), limit);
    const second = await begin(a);
    const error = await limited(submit(a, second, limit));
    expect(error.retryAfterSeconds).toBe(1);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await submit(a, second, limit)).status).toBe('EXECUTED');
  });

  it('admits exactly the limit when the same account submits concurrently', async () => {
    const a = await actor();
    const limit = { max: 2, windowSeconds: 3600 };
    const starts = [await begin(a), await begin(a), await begin(a)];
    const settled = await Promise.allSettled(starts.map((s) => submit(a, s, limit)));
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await submissions()).toBe(2);
  });

  it('rejects a malformed limit as a host contract error instead of silently disabling it', async () => {
    const a = await actor();
    const s = await begin(a);
    for (const bad of [
      { max: 0, windowSeconds: 60 },
      { max: 1.5, windowSeconds: 60 },
      { max: 5, windowSeconds: 0 },
      { max: 5, windowSeconds: 86401 },
      { max: 1001, windowSeconds: 60 },
    ])
      expect(await limited(submit(a, s, bad))).toMatchObject({ code: 'STORAGE_CONTRACT' });
    expect(await submissions()).toBe(0);
  });
});
