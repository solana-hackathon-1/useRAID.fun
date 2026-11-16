import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { publishPracticeTrialDefinition } from '../../src/skills/practice-trial-storage';
import { publishPracticeReviewPolicy } from '../../src/skills/practice-review-policy-storage';
import type { SkillTaxonomyActor } from '../../src/skills/taxonomy-storage';
import { definition as fixture } from '../../examples/skill-assessments/fixtures';

/**
 * Publishes (through the real commands) a practice trial for one skill of an already published taxonomy and an
 * ASSESSMENT_REVIEW policy for it, and returns the policy version id that Raid terms name as their
 * `assessmentPolicyVersion` (the id a verified assessment records, so acceptance can match it).
 */
export async function publishAssessmentPolicy(
  db: PrismaClient,
  publisher: SkillTaxonomyActor,
  scope: { taxonomyId: string; skillId: string; skillDomain: string },
  purpose: 'ASSESSMENT_REVIEW' | 'OWNERSHIP_REVIEW' = 'ASSESSMENT_REVIEW',
) {
  const draft = structuredClone(fixture);
  for (const field of ['reference', 'publishedAt', 'state']) Reflect.deleteProperty(draft, field);
  const { trial } = await runCommandTransaction(db, (tx) =>
    publishPracticeTrialDefinition(
      tx,
      {
        actor: publisher,
        input: {
          trialId: 'synthetic-policy-trial-' + randomUUID(),
          expectedRevision: 0,
          taxonomyReference: { recordId: scope.taxonomyId, revision: 1 },
          availability: 'AVAILABLE',
          draft: {
            ...draft,
            skillId: scope.skillId,
            skillDomain: scope.skillDomain,
            rubric: {
              ...draft.rubric,
              reference: { recordId: 'synthetic-policy-rubric-' + randomUUID(), revision: 1 },
            },
          },
        },
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
  const policyId = 'synthetic-policy-' + randomUUID();
  const publish = (expectedRevision: number, state: 'APPROVED' | 'WITHDRAWN') =>
    runCommandTransaction(db, (tx) =>
      publishPracticeReviewPolicy(
        tx,
        {
          actor: publisher,
          input: {
            version: 'v1',
            policyId,
            expectedRevision,
            definitionReference: trial.definition.reference,
            purpose,
            state,
            guidance: 'Synthetic assessment guidance.',
          },
          idempotencyKey: randomUUID(),
          requestId: randomUUID(),
        },
        { allowNewWrites: true, canPublish: () => true },
      ),
    );
  const approved = await publish(0, 'APPROVED');
  return {
    policyVersionId: approved.policy.id,
    /** Publishes a WITHDRAWN revision, which becomes the current one; its own version id is `.policy.id`. */
    withdraw: () => publish(approved.policy.reference.revision, 'WITHDRAWN'),
    /** Publishes a newer APPROVED revision, superseding `policyVersionId`. */
    revise: () => publish(approved.policy.reference.revision, 'APPROVED'),
  };
}
