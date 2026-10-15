import { InternalId } from '../contracts/ids';
import {
  observePracticeTrialAssessmentContext,
  recordPracticeTrialAssessment,
  readPracticeTrialAssessment,
  type PracticeTrialAssessmentCommand,
} from '../skills/practice-trial-assessment-storage';
import type { SkillTaxonomyActor } from '../skills/taxonomy-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { practiceReviewReadConfiguration } from './practice-review-reads-host';
import { db } from './db';
function assessmentCatalogId() {
  const r = InternalId.safeParse(process.env.PRACTICE_ASSESSMENT_CATALOG_ID);
  return r.success ? r.data : null;
}
export function practiceTrialAssessmentWriteConfiguration() {
  if (process.env.PRACTICE_TRIAL_ASSESSMENTS_ENABLED !== 'true')
    return { writesAvailable: false, unavailableReason: 'DISABLED' as const };
  const writesAvailable = assessmentCatalogId() !== null;
  return {
    writesAvailable,
    unavailableReason: writesAvailable ? null : ('MISCONFIGURED' as const),
  };
}
export async function recordPracticeTrialAssessmentFromHost(
  command: PracticeTrialAssessmentCommand,
) {
  const r = await runCommandTransaction(db, (tx) =>
    recordPracticeTrialAssessment(tx, command, {
      allowNewWrites: practiceTrialAssessmentWriteConfiguration().writesAvailable,
      canRead: () => practiceReviewReadConfiguration().readsAvailable,
      canUsePolicy: () => practiceReviewReadConfiguration().readsAvailable,
      canReview: (scope) =>
        practiceTrialAssessmentWriteConfiguration().writesAvailable &&
        practiceReviewReadConfiguration().readsAvailable &&
        scope.taxonomyId === assessmentCatalogId(),
    }),
  );
  const reads = practiceReviewReadConfiguration();
  return {
    version: 'v1' as const,
    ...r,
    view: reads.readsAvailable ? r.view : null,
    readsAvailable: reads.readsAvailable,
    ...practiceTrialAssessmentWriteConfiguration(),
  };
}
export async function readPracticeTrialAssessmentFromHost(
  actor: SkillTaxonomyActor,
  input: unknown,
) {
  const view = await runCommandTransaction(db, (tx) =>
    readPracticeTrialAssessment(
      tx,
      actor,
      input,
      () => practiceReviewReadConfiguration().readsAvailable,
    ),
  );
  const config = practiceReviewReadConfiguration();
  return { version: 'v1' as const, view: config.readsAvailable ? view : null, ...config };
}

export async function observePracticeTrialAssessmentContextFromHost(
  actor: SkillTaxonomyActor,
  input: unknown,
) {
  const context = await runCommandTransaction(db, (tx) =>
    observePracticeTrialAssessmentContext(
      tx,
      actor,
      input,
      () => practiceReviewReadConfiguration().readsAvailable,
    ),
  );
  const config = practiceReviewReadConfiguration();
  return { version: 'v1' as const, context: config.readsAvailable ? context : null, ...config };
}
