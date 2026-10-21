import { InternalId } from '../contracts/ids';
import {
  recordPracticeAssessmentDecision,
  readPracticeTrialAssessmentState,
  readPracticeAssessmentDecision,
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
export function practiceAssessmentDecisionWriteConfiguration() {
  if (process.env.PRACTICE_ASSESSMENT_DECISIONS_ENABLED !== 'true')
    return { writesAvailable: false, unavailableReason: 'DISABLED' as const };
  const writesAvailable = assessmentCatalogId() !== null;
  return {
    writesAvailable,
    unavailableReason: writesAvailable ? null : ('MISCONFIGURED' as const),
  };
}
export async function recordPracticeAssessmentDecisionFromHost(
  command: PracticeTrialAssessmentCommand,
) {
  const r = await runCommandTransaction(db, (tx) =>
    recordPracticeAssessmentDecision(tx, command, {
      allowNewWrites: practiceAssessmentDecisionWriteConfiguration().writesAvailable,
      canRead: () => practiceReviewReadConfiguration().readsAvailable,
      canUsePolicy: () => practiceReviewReadConfiguration().readsAvailable,
      canDecide: (scope) =>
        practiceAssessmentDecisionWriteConfiguration().writesAvailable &&
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
    ...practiceAssessmentDecisionWriteConfiguration(),
  };
}
export async function readPracticeTrialAssessmentStateFromHost(
  actor: SkillTaxonomyActor,
  input: unknown,
) {
  const view = await runCommandTransaction(db, (tx) =>
    readPracticeTrialAssessmentState(
      tx,
      actor,
      input,
      () => practiceReviewReadConfiguration().readsAvailable,
    ),
  );
  const config = practiceReviewReadConfiguration();
  return { version: 'v1' as const, view: config.readsAvailable ? view : null, ...config };
}

export async function readPracticeAssessmentDecisionFromHost(
  actor: SkillTaxonomyActor,
  input: unknown,
) {
  const view = await runCommandTransaction(db, (tx) =>
    readPracticeAssessmentDecision(
      tx,
      actor,
      input,
      () => practiceReviewReadConfiguration().readsAvailable,
    ),
  );
  const config = practiceReviewReadConfiguration();
  return { version: 'v1' as const, view: config.readsAvailable ? view : null, ...config };
}
