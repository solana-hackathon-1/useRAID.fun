import type { SkillRank } from '../contracts/entities';
import {
  SKILL_PREDICATE_LIMITS,
  SkillEligibilityContractError,
  type SkillPredicate,
} from './eligibility-contracts';

/**
 * Every required skill must be met. Groups respect the eligibility parser's per-group child limit; terms allow up to
 * 50 skills, which fits two levels well inside its depth and node bounds. No skills is not a requirement.
 */
export function buildSkillRequirement(
  required: readonly { skillId: string; minimumRank: SkillRank; assessmentPolicyVersion: string }[],
): SkillPredicate {
  if (required.length === 0) throw new SkillEligibilityContractError('INVALID_INPUT');
  const leaves: SkillPredicate[] = required.map((s) => ({
    kind: 'SKILL',
    skillId: s.skillId,
    minimumRank: s.minimumRank,
    verificationRequired: true,
    assessmentPolicyVersion: s.assessmentPolicyVersion,
  }));
  let level = leaves;
  do {
    const groups: SkillPredicate[] = [];
    for (let i = 0; i < level.length; i += SKILL_PREDICATE_LIMITS.children)
      groups.push({ kind: 'AND', children: level.slice(i, i + SKILL_PREDICATE_LIMITS.children) });
    level = groups;
  } while (level.length > 1);
  return level[0];
}
