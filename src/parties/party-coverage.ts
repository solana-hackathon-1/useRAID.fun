import { buildSkillRequirement } from '../skills/eligibility-requirement';
import { explainSkillEligibility, type SkillEligibilityContext } from '../skills/eligibility';
import type { SkillRank } from '../contracts/entities';

export type PartyCoverageRule = 'ONE_MEMBER' | 'DISTRIBUTED_PARTY' | 'EVERY_MEMBER';
export class PartyCoverageError extends Error {
  constructor(readonly code: 'ROSTER_MISMATCH') {
    super(code);
    this.name = 'PartyCoverageError';
  }
}
/**
 * Explains whether a roster covers a terms version's required skills. The context must hold exactly the roster's members,
 * each with their own evidence: a Party label, a leader's rank or a participant outside the snapshot never counts for
 * another member. The coverage rule is explicit because terms do not yet carry one (see docs/raid-parties.md).
 * Private informational explanation, like the skill eligibility it wraps; acceptance must re-read current facts.
 */
export function evaluatePartyCoverage(
  context: SkillEligibilityContext,
  rosterParticipantIds: readonly string[],
  requiredSkills: readonly {
    skillId: string;
    minimumRank: SkillRank;
    assessmentPolicyVersion: string;
  }[],
  coverage: PartyCoverageRule,
): ReturnType<typeof explainSkillEligibility> {
  const roster = new Set(rosterParticipantIds);
  const present = context.participants.map((entry) => entry.participant.id);
  if (
    roster.size !== rosterParticipantIds.length ||
    present.length !== roster.size ||
    present.some((id) => !roster.has(id))
  )
    throw new PartyCoverageError('ROSTER_MISMATCH');
  return explainSkillEligibility(context, {
    version: 'v1',
    coverage,
    requirement: requiredSkills.length ? buildSkillRequirement(requiredSkills) : null,
  });
}
