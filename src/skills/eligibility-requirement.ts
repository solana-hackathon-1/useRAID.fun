import type { SkillRank } from '../contracts/entities';
import type { SkillPredicate } from './eligibility-contracts';

const GROUP_LIMIT = 16;
/** Every required skill must be met. The eligibility schema allows 16 children per group and terms up to 50 skills. */
export function buildSkillRequirement(
  required: readonly { skillId: string; minimumRank: SkillRank; assessmentPolicyVersion: string }[],
): SkillPredicate {
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
