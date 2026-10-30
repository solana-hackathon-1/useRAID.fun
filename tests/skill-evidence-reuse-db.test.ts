import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../src/skills/practice-trial-storage';
import { startPracticeTrial } from '../src/skills/practice-trial-attempt-storage';
import { submitPracticeTrial } from '../src/skills/practice-trial-submission-storage';
import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
  type PracticeReviewAssignmentOptions,
} from '../src/skills/practice-review-assignment-storage';
import { saveSkillClaim } from '../src/skills/claim-storage';
import { fingerprintEvidenceReference } from '../src/skills/evidence-fingerprint';
import { readEvidenceReuseForReview } from '../src/skills/evidence-reuse-storage';
import { definition as fixture } from '../examples/skill-assessments/fixtures';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const catalogId = 'synthetic-reuse-catalog',
  trialId = 'synthetic-reuse-trial';
const skills = [
  { id: 'frontend', domain: 'web', name: 'Frontend', status: 'ACTIVE', aliases: ['frontend'] },
  { id: 'backend', domain: 'server', name: 'Backend', status: 'ACTIVE', aliases: ['backend'] },
];
type Subject = SkillTaxonomyActor & { participantId: string };
let publisher: SkillTaxonomyActor, evaluator: SkillTaxonomyActor;

async function actor(admin = false, mapped = true) {
  const user = await db.user.create({
    data: {
      handle: 'synthetic',
      role: admin ? 'ADMIN' : 'CREATOR',
      xId: admin ? randomUUID() : null,
    },
  });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: user.id,
      via: admin ? 'x' : 'wallet',
      expiresAt: new Date(Date.now() + 120000),
    },
  });
  const p = mapped
    ? await db.participant.create({
        data: {
          accountId: user.id,
          provisionActorAccountId: user.id,
          provisionRequestId: 'synthetic-provision',
        },
      })
    : null;
  return { accountId: user.id, sessionHash, participantId: p?.id ?? '' };
}
const identity = (a: SkillTaxonomyActor) => ({
  accountId: a.accountId,
  sessionHash: a.sessionHash,
});
const claimBody = (skillId: string, references: string[], revision = 0) => ({
  taxonomyId: catalogId,
  expectedTaxonomyRevision: 1,
  expectedClaimRevision: revision,
  skillId,
  claimedLevel: 'B',
  supportingReferences: references,
});
const claim = (
  a: SkillTaxonomyActor,
  skillId: string,
  refs: string[],
  revision = 0,
  key = randomUUID(),
) =>
  runCommandTransaction(db, (tx) =>
    saveSkillClaim(
      tx,
      {
        actor: identity(a),
        input: claimBody(skillId, refs, revision),
        idempotencyKey: key,
        requestId: 'synthetic-claim',
      },
      { allowNewWrites: true },
    ),
  );
const rows = () =>
  db.$queryRawUnsafe<{ skillClaimVersionId: string; fingerprint: string }[]>(
    'SELECT "skillClaimVersionId"::text,"fingerprint" FROM "SkillEvidenceFingerprint" ORDER BY "fingerprint"',
  );
async function setup() {
  publisher = await actor(true, false);
  evaluator = await actor(false, false);
  await runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor: identity(publisher),
        input: { taxonomyId: catalogId, expectedRevision: 0, skills },
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
        actor: identity(publisher),
        input: {
          trialId,
          expectedRevision: 0,
          taxonomyReference: { recordId: catalogId, revision: 1 },
          availability: 'AVAILABLE',
          draft: {
            ...draft,
            maximumAttempts: 3,
            cooldownSeconds: 0,
            rubric: {
              ...draft.rubric,
              reference: { recordId: 'synthetic-reuse-rubric', revision: 1 },
            },
          },
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-definition',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
}
/** A subject who has submitted the practice trial (skill 'frontend') and an evaluator assignment on it. */
async function reviewable(subject: Subject) {
  const begun = await runCommandTransaction(db, (tx) =>
    startPracticeTrial(
      tx,
      {
        actor: identity(subject),
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
  );
  const sent = await runCommandTransaction(db, (tx) =>
    submitPracticeTrial(
      tx,
      {
        actor: identity(subject),
        input: {
          version: 'v1',
          startId: begun.start.id,
          expectedDefinitionReference: { recordId: trialId, revision: 1 },
          expectedRubricReference: { recordId: 'synthetic-reuse-rubric', revision: 1 },
          answer: 'const answer = 1;',
          explanation: 'Synthetic explanation.',
          toolsUsed: ['editor'],
          aiAssistanceUsed: false,
          assistanceDisclosure: 'None.',
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-submit',
      },
      { allowNewWrites: true },
    ),
  );
  const submissionId = sent.submission.reference.recordId;
  const policy: PracticeReviewAssignmentOptions = {
    allowNewWrites: true,
    canManage: (s) => s.issuerAccountId === publisher.accountId,
  };
  const assignment = await runCommandTransaction(db, (tx) =>
    issuePracticeReviewAssignment(
      tx,
      {
        actor: identity(publisher),
        input: {
          version: 'v1',
          submissionId,
          evaluatorAccountId: evaluator.accountId,
          purpose: 'ASSESSMENT_REVIEW',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          reason: 'Synthetic bounded assessment review.',
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-issue',
      },
      policy,
    ),
  );
  return { submissionId, assignmentId: assignment.assignment.id, policy };
}
const readReuse = (
  c: { submissionId: string; assignmentId: string },
  who: SkillTaxonomyActor = evaluator,
  purpose = 'ASSESSMENT_REVIEW',
  canRead: Parameters<typeof readEvidenceReuseForReview>[3] = () => true,
) =>
  runCommandTransaction(db, (tx) =>
    readEvidenceReuseForReview(
      tx,
      identity(who),
      { version: 'v1', assignmentId: c.assignmentId, submissionId: c.submissionId, purpose },
      canRead,
    ),
  );

integration(
  'T014 duplicate evidence fingerprints and reviewer-only possible-reuse signal (#56)',
  () => {
    beforeAll(() => assertTestDatabase());
    beforeEach(async () => {
      await truncateAll(db);
      await setup();
    });
    afterAll(() => db.$disconnect());

    it('stores one normalized fingerprint per distinct reference, once per version, and none on replay', async () => {
      const a = await actor();
      const key = randomUUID();
      const refs = [
        'https://Public.Example/portfolio/',
        'https://public.example/portfolio#top',
        'https://repo.example/a',
      ];
      const first = await claim(a, 'frontend', refs, 0, key);
      expect(first.status).toBe('EXECUTED');
      const stored = await rows();
      expect(stored.map((r) => r.fingerprint).sort()).toEqual(
        [
          fingerprintEvidenceReference('https://public.example/portfolio'),
          fingerprintEvidenceReference('https://repo.example/a'),
        ].sort(),
      );
      const replay = await claim(a, 'frontend', refs, 0, key);
      expect(replay.status).toBe('REPLAYED');
      expect(await rows()).toHaveLength(2);
    });

    it('never leaks the signal or any fingerprint into the claimant-facing record', async () => {
      const a = await actor();
      const saved = await claim(a, 'frontend', ['https://public.example/portfolio']);
      expect(JSON.stringify(saved)).not.toMatch(/fingerprint|possibleReuse|advisory/i);
    });

    it('flags both claimants for a human reviewer when a reference is shared, without blocking either save', async () => {
      const a = await actor(),
        b = await actor(),
        c = await actor();
      await claim(a, 'frontend', ['https://public.example/portfolio']);
      await claim(b, 'frontend', ['https://www.PUBLIC.example/portfolio/?utm_source=x']);
      await claim(c, 'frontend', ['https://elsewhere.example/own-work']);
      const [ca, cb, cc] = [await reviewable(a), await reviewable(b), await reviewable(c)];
      const signalA = await readReuse(ca);
      expect(signalA).toMatchObject({
        version: 'v1',
        private: true,
        advisory: true,
        possibleReuse: true,
        otherParticipantCount: 1,
        matchedReferenceCount: 1,
        automaticRestriction: false,
        isAuthorizationToken: false,
      });
      expect(await readReuse(cb)).toMatchObject({ possibleReuse: true, otherParticipantCount: 1 });
      expect(await readReuse(cc)).toMatchObject({
        possibleReuse: false,
        otherParticipantCount: 0,
        matchedReferenceCount: 0,
      });
      // Identity of the other claimant is never part of the signal.
      expect(JSON.stringify(signalA)).not.toContain(b.accountId);
      expect(JSON.stringify(signalA)).not.toContain(b.participantId);
    });

    it('does not flag the same participant reusing a portfolio link across their own skills', async () => {
      const a = await actor();
      await claim(a, 'frontend', ['https://public.example/portfolio']);
      await claim(a, 'backend', ['https://public.example/portfolio']);
      expect(await readReuse(await reviewable(a))).toMatchObject({ possibleReuse: false });
    });

    it('stops flagging when the other claimant replaces the reference; the old fingerprint row is retained', async () => {
      const a = await actor(),
        b = await actor();
      await claim(a, 'frontend', ['https://public.example/portfolio']);
      await claim(b, 'frontend', ['https://public.example/portfolio']);
      const review = await reviewable(a);
      expect(await readReuse(review)).toMatchObject({ possibleReuse: true });
      await claim(b, 'frontend', ['https://b-own.example/work'], 1);
      expect(await readReuse(review)).toMatchObject({
        possibleReuse: false,
        otherParticipantCount: 0,
      });
      expect(await rows()).toHaveLength(3);
    });

    it('flags both sides when two claimants race to save the same new reference (neither is rejected)', async () => {
      const a = await actor(),
        b = await actor();
      const [ra, rb] = await Promise.all([
        claim(a, 'frontend', ['https://public.example/raced']),
        claim(b, 'frontend', ['https://public.example/raced']),
      ]);
      expect([ra.status, rb.status]).toEqual(['EXECUTED', 'EXECUTED']);
      expect(await rows()).toHaveLength(2);
      expect(await readReuse(await reviewable(a))).toMatchObject({ possibleReuse: true });
      expect(await readReuse(await reviewable(b))).toMatchObject({ possibleReuse: true });
    });

    it('keeps a concurrent replay of one save to a single fingerprint set', async () => {
      const a = await actor();
      const key = randomUUID();
      const settled = await Promise.allSettled([
        claim(a, 'frontend', ['https://public.example/one'], 0, key),
        claim(a, 'frontend', ['https://public.example/one'], 0, key),
      ]);
      expect(settled.some((r) => r.status === 'fulfilled')).toBe(true);
      expect(await rows()).toHaveLength(1);
    });

    it('is visible only to the assigned reviewer for the exact submission, purpose and a granted scope', async () => {
      const a = await actor(),
        b = await actor();
      await claim(a, 'frontend', ['https://public.example/portfolio']);
      await claim(b, 'frontend', ['https://public.example/portfolio']);
      const review = await reviewable(a);
      const other = await reviewable(b);
      expect(await readReuse(review, await actor(false, false))).toBeNull();
      expect(await readReuse(review, publisher)).toBeNull();
      expect(await readReuse(review, a)).toBeNull();
      expect(await readReuse({ ...review, submissionId: other.submissionId })).toBeNull();
      expect(await readReuse(review, evaluator, 'OWNERSHIP_REVIEW')).toBeNull();
      expect(await readReuse(review, evaluator, 'ASSESSMENT_REVIEW', () => false)).toBeNull();
      await runCommandTransaction(db, (tx) =>
        revokePracticeReviewAssignment(
          tx,
          {
            actor: identity(publisher),
            input: {
              version: 'v1',
              assignmentId: review.assignmentId,
              reason: 'Synthetic revoke.',
            },
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-revoke',
          },
          review.policy,
        ),
      );
      expect(await readReuse(review)).toBeNull();
    });

    it('is append-only and refuses malformed digests at the database boundary', async () => {
      const a = await actor();
      await claim(a, 'frontend', ['https://public.example/portfolio']);
      await expect(
        db.$executeRawUnsafe(
          'UPDATE "SkillEvidenceFingerprint" SET "fingerprint"=repeat(\'a\',64)',
        ),
      ).rejects.toThrow();
      await expect(
        db.$executeRawUnsafe('DELETE FROM "SkillEvidenceFingerprint"'),
      ).rejects.toThrow();
      const version = (await rows())[0].skillClaimVersionId;
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "SkillEvidenceFingerprint"("skillClaimVersionId","fingerprintVersion","fingerprint") VALUES('${version}'::uuid,'v1','NOT-A-DIGEST')`,
        ),
      ).rejects.toThrow();
    });

    it('migration is additive: re-running it over an existing claim row set leaves every row intact', async () => {
      const a = await actor();
      await claim(a, 'frontend', ['https://public.example/portfolio']);
      const snapshot = () =>
        db.$queryRawUnsafe<{ n: number; digest: string }[]>(
          `SELECT (SELECT count(*)::int FROM "SkillClaim")+(SELECT count(*)::int FROM "SkillClaimVersion") AS n,(SELECT md5(string_agg(t::text,',' ORDER BY t."id")) FROM "SkillClaimVersion" t) AS digest`,
        );
      const before = (await snapshot())[0];
      const sql = readFileSync(
        'prisma/migrations/202610300001_skill_evidence_fingerprints/migration.sql',
        'utf8',
      );
      const statements = sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s && s !== 'BEGIN' && s !== 'COMMIT');
      expect(statements.length).toBeGreaterThanOrEqual(4);
      class Rollback extends Error {}
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('DROP TABLE "SkillEvidenceFingerprint"');
          for (const statement of statements) await tx.$executeRawUnsafe(statement);
          const [after] = await tx.$queryRawUnsafe<{ n: number; digest: string }[]>(
            `SELECT (SELECT count(*)::int FROM "SkillClaim")+(SELECT count(*)::int FROM "SkillClaimVersion") AS n,(SELECT md5(string_agg(t::text,',' ORDER BY t."id")) FROM "SkillClaimVersion" t) AS digest`,
          );
          expect(after).toEqual(before);
          const [empty] = await tx.$queryRawUnsafe<{ n: number }[]>(
            'SELECT count(*)::int AS n FROM "SkillEvidenceFingerprint"',
          );
          expect(empty.n).toBe(0);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await snapshot()).toEqual([before]);
      expect(await rows()).toHaveLength(1);
    });
  },
);
