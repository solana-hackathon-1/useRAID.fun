import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import {
  SkillEligibilityContractError,
  explainSkillEligibility,
  type SkillEligibilityInput,
} from '../skills/eligibility';
import { buildSkillRequirement } from '../skills/eligibility-requirement';
import { readPublishedSkillTaxonomy } from '../skills/taxonomy-storage';
import { WorkError, type WorkActor } from '../work-loop/contracts';
import { currentHuman, validate } from '../work-loop/engagement-authority';
import type { FeedEligibility } from '../work-loop/feed-contracts';
import type { RaidTerms } from '../work-loop/terms';
import { buildRootEligibilityContext, type FactRow } from './work-acceptance-host';

/** The parts of a Raid's terms the viewer's eligibility depends on. */
export type ViewerTerms = Pick<RaidTerms, 'requiredSkills' | 'execution' | 'participantKinds'>;
export type ViewerEvaluator = (terms: ViewerTerms) => FeedEligibility;

/**
 * Reads the signed-in person's current assessment facts once, at database time, and returns a pure per-Raid
 * evaluator that uses the same requirement and `explainSkillEligibility` rules acceptance uses. It is informational
 * only: it grants nothing, takes no lock and reserves nothing, and acceptance reads and authorizes its own facts again
 * under its locks when the person acts. A missing or restricted session, an unpublished taxonomy or any read problem
 * rejects, so the caller can say the check is unavailable instead of guessing.
 */
export async function createViewerEvaluator(
  tx: Tx,
  actor: WorkActor,
  taxonomyId: string,
): Promise<ViewerEvaluator> {
  validate(tx, actor);
  const { participantId } = await currentHuman(tx, actor);
  const taxonomy = await readPublishedSkillTaxonomy(tx, actor, taxonomyId);
  if (!taxonomy) throw new WorkError('STORAGE_CONTRACT');
  const facts = await tx.query<FactRow>(
    `SELECT a."id"::text AS "assessmentId",a."revision",v."skillId",v."skillDomain",v."state",v."assessedRank",
      v."policyVersionId"::text AS "policyVersionId",v."evaluatorAccountId",v."issuedAt",v."reassessmentAt",
      v."definitionVersionId"::text AS "definitionVersionId"
     FROM "SkillAssessment" a JOIN "SkillAssessmentVersion" v ON v."id"=a."currentVersionId"
     WHERE a."participantId"=$1::uuid AND a."taxonomyId"=$2`,
    [participantId, taxonomyId],
  );
  const [clock] = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now', []);
  if (!(clock?.now instanceof Date)) throw new WorkError('STORAGE_CONTRACT');
  const context = buildRootEligibilityContext({
    participantId,
    accountId: actor.accountId,
    taxonomy,
    facts,
    now: clock.now,
  });
  return (terms) => {
    // Acceptance takes a human, solo, skill-gated slot; anything else cannot be called a fit from skills alone.
    if (!terms.participantKinds.includes('HUMAN')) return 'NOT_ELIGIBLE';
    if (terms.execution === 'PARTY' || terms.requiredSkills.length === 0) return 'UNKNOWN';
    const input: SkillEligibilityInput = {
      version: 'v1',
      coverage: 'ONE_MEMBER',
      requirement: buildSkillRequirement(terms.requiredSkills),
    };
    try {
      const { status } = explainSkillEligibility(context, input);
      return status === 'MET' ? 'ELIGIBLE' : status === 'UNMET' ? 'NOT_ELIGIBLE' : 'UNKNOWN';
    } catch (error) {
      // A requirement naming a skill outside the taxonomy cannot be met; any other problem is not a verdict.
      if (error instanceof SkillEligibilityContractError && error.code === 'INVALID_INPUT')
        return 'NOT_ELIGIBLE';
      throw error;
    }
  };
}
