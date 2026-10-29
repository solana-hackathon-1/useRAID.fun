import type { SkillRank } from '../contracts/entities';
import { SkillEligibilityContractError, type SkillPredicate } from './eligibility-contracts';

const GROUP_LIMIT = 16;

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
    for (let i = 0; i < level.length; i += GROUP_LIMIT)
      groups.push({ kind: 'AND', children: level.slice(i, i + GROUP_LIMIT) });
    level = groups;
  } while (level.length > 1);
  return level[0];
}
