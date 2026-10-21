import { randomUUID, randomBytes } from 'node:crypto';
import { db } from '../../src/lib/db';
import { hash } from '../../src/lib/auth-primitives';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy, type SkillTaxonomyActor } from '../../src/skills/taxonomy-storage';
import { publishPracticeTrialDefinition } from '../../src/skills/practice-trial-storage';
import { startPracticeTrial } from '../../src/skills/practice-trial-attempt-storage';
import { definition as fixture } from '../../examples/skill-assessments/fixtures';
import { assertTestDatabase, truncateAll } from './db-guard';

export const catalogId = 'synthetic-submission-catalog',
  trialId = 'synthetic-submission-trial',
  rubricId = 'synthetic-submission-rubric';
async function actor(admin: boolean): Promise<SkillTaxonomyActor & { userId: string }> {
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
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return { accountId: user.id, sessionHash, userId: user.id };
}
const pure = (a: { accountId: string; sessionHash: string }): SkillTaxonomyActor => ({
  accountId: a.accountId,
  sessionHash: a.sessionHash,
});
function definitionInput(revision: number, availability: 'AVAILABLE' | 'RETIRED', ai: boolean) {
  const draft = structuredClone(fixture) as Record<string, unknown> & typeof fixture;
  for (const field of ['reference', 'publishedAt', 'state']) Reflect.deleteProperty(draft, field);
  return {
    trialId,
    expectedRevision: revision,
    taxonomyReference: { recordId: catalogId, revision: 1 },
    availability,
    draft: {
      ...draft,
      tools: { ...draft.tools, aiAssistance: ai ? 'ALLOWED' : 'PROHIBITED' },
      maximumAttempts: 3,
      cooldownSeconds: 0,
      rubric: { ...draft.rubric, reference: { recordId: rubricId, revision: 1 } },
    },
  };
}
/** Synthetic-only catalog, trial and learner session for the practice-portal browser checks. */
export async function seedPracticePortalFixture(options: { ai?: boolean } = {}) {
  assertTestDatabase();
  await truncateAll(db);
  const publisher = await actor(true),
    subject = await actor(false);
  await db.participant.create({
    data: {
      accountId: subject.userId,
      provisionActorAccountId: subject.userId,
      provisionRequestId: 'synthetic-provision',
    },
  });
  await runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor: pure(publisher),
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
  await runCommandTransaction(db, (tx) =>
    publishPracticeTrialDefinition(
      tx,
      {
        actor: pure(publisher),
        input: definitionInput(0, 'AVAILABLE', options.ai ?? true),
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-definition',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
  const cookie = randomBytes(32).toString('base64url'),
    cookieHash = hash(cookie);
  await db.session.create({
    data: {
      tokenHash: cookieHash,
      userId: subject.userId,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return {
    cookie,
    cookieHash,
    ownerId: subject.userId,
    /** A start created outside the browser, to exercise reload/continue. */
    async startOutsideBrowser() {
      const result = await runCommandTransaction(db, (tx) =>
        startPracticeTrial(
          tx,
          {
            actor: { accountId: subject.accountId, sessionHash: subject.sessionHash },
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
      return result.start.id as string;
    },
    async retire() {
      await runCommandTransaction(db, (tx) =>
        publishPracticeTrialDefinition(
          tx,
          {
            actor: pure(publisher),
            input: definitionInput(1, 'RETIRED', options.ai ?? true),
            idempotencyKey: randomUUID(),
            requestId: 'synthetic-retire',
          },
          { allowNewWrites: true, canPublish: () => true },
        ),
      );
    },
  };
}
export { db };
