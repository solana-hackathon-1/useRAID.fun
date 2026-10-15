import { InternalId } from '../contracts/ids';
import { readOwnSkillAssessment } from '../skills/own-assessment-storage';
import type { SkillTaxonomyActor } from '../skills/taxonomy-storage-contracts';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
function catalogId() {
  const p = InternalId.safeParse(process.env.PRACTICE_ASSESSMENT_CATALOG_ID);
  return p.success ? p.data : null;
}
export function ownSkillAssessmentReadConfiguration() {
  if (process.env.SKILL_ASSESSMENT_READS_ENABLED !== 'true')
    return { readsAvailable: false, unavailableReason: 'DISABLED' as const };
  const readsAvailable = catalogId() !== null;
  return { readsAvailable, unavailableReason: readsAvailable ? null : ('MISCONFIGURED' as const) };
}
export async function readOwnSkillAssessmentFromHost(actor: SkillTaxonomyActor, skillId: string) {
  const initial = ownSkillAssessmentReadConfiguration(),
    id = catalogId();
  if (!initial.readsAvailable || id === null)
    return { version: 'v1' as const, view: null, ...initial };
  const observation = await runCommandTransaction(db, (tx) =>
    readOwnSkillAssessment(
      tx,
      actor,
      { version: 'v1', taxonomyId: id, skillId },
      (scope) =>
        ownSkillAssessmentReadConfiguration().readsAvailable && scope.taxonomyId === catalogId(),
    ),
  );
  const config = ownSkillAssessmentReadConfiguration();
  return {
    version: 'v1' as const,
    view: config.readsAvailable && catalogId() === id ? observation.view : null,
    ...config,
  };
}
